import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8000);
const INDEX_FILE = resolve("public/index.html");

const MAX_BODY_BYTES = 6_000_000;
const TIMEOUT_MS = 90_000;

const PROVIDERS = Object.freeze({
  huggingface: {
    catalog: "https://router.huggingface.co/v1/models",
    chat: "https://router.huggingface.co/v1/chat/completions"
  },
  gemini: {
    catalog: "https://generativelanguage.googleapis.com/v1beta/models"
  }
});

class AppError extends Error {
  constructor(message, status = 400, code = "REQUEST_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(data);
}

function providerConfig(name) {
  if (typeof name !== "string" || !Object.hasOwn(PROVIDERS, name)) {
    throw new AppError("Неизвестный провайдер.", 400, "UNKNOWN_PROVIDER");
  }

  return PROVIDERS[name];
}

function personalKey(req) {
  const value = req.headers["x-provider-key"];

  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    /[\r\n]/.test(value)
  ) {
    throw new AppError(
      "Добавьте действующий личный ключ провайдера в настройках.",
      401,
      "KEY_REQUIRED"
    );
  }

  return value.trim();
}

async function requestProvider(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const host = new URL(url).host;

  try {
    let response;

    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
    } catch (error) {
      console.error("[provider connection]", {
        host,
        code: error?.cause?.code || null,
        cause: error?.cause?.message || null
      });

      const timedOut =
        controller.signal.aborted || error?.name === "AbortError";

      throw new AppError(
        timedOut
          ? `Превышено время ожидания ${host}.`
          : `Сервер не смог подключиться к ${host}. ` +
            "Проверьте сеть и настройки сертификатов Node.js.",
        502,
        timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE"
      );
    }

    let raw;

    try {
      raw = await response.text();
    } catch {
      throw new AppError(
        `Не удалось прочитать ответ ${host}.`,
        502,
        "PROVIDER_READ_ERROR"
      );
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail = String(
        data?.error?.message ??
        data?.error ??
        data?.message ??
        raw ??
        `HTTP ${response.status}`
      ).slice(0, 350);

      console.error("[provider HTTP]", {
        host,
        status: response.status,
        requestId:
          response.headers.get("x-request-id") ||
          response.headers.get("cf-ray") ||
          null,
        detail
      });

      const regionDenied =
        /user location is not supported/i.test(detail);

      throw new AppError(
        regionDenied
          ? "Gemini API недоступен для текущего региона сервера."
          : `Провайдер вернул HTTP ${response.status}: ${detail}`,
        502,
        regionDenied
          ? "GEMINI_REGION_UNSUPPORTED"
          : response.status === 401
            ? "PROVIDER_UNAUTHORIZED"
            : response.status === 429
              ? "PROVIDER_RATE_LIMIT"
              : "PROVIDER_HTTP_ERROR"
      );
    }

    if (data === null) {
      throw new AppError(
        `${host} вернул ответ не в формате JSON.`,
        502,
        "INVALID_PROVIDER_RESPONSE"
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function huggingFaceCatalog(key) {
  /*
    Берём список у маршрутизатора Inference Providers,
    а не произвольный список репозиториев Hugging Face Hub.
    Наличие модели в каталоге всё равно не гарантирует доступ
    при исчерпанной квоте или ограничениях аккаунта.
  */
  const data = await requestProvider(PROVIDERS.huggingface.catalog, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`
    }
  });

  if (!Array.isArray(data?.data)) {
    throw new AppError(
      "Hugging Face вернул каталог неизвестного формата.",
      502,
      "INVALID_CATALOG"
    );
  }

  return data.data
    .filter(model => typeof model?.id === "string")
    .map(model => ({
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      image: Array.isArray(model.architecture?.input_modalities) &&
        model.architecture.input_modalities.includes("image")
    }));
}

async function geminiCatalog(key) {
  const result = [];
  let pageToken = "";

  for (let page = 0; page < 10; page++) {
    const url = new URL(PROVIDERS.gemini.catalog);
    url.searchParams.set("pageSize", "100");

    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const data = await requestProvider(url, {
      headers: {
        Accept: "application/json",
        "x-goog-api-key": key
      }
    });

    if (!Array.isArray(data.models)) {
      throw new AppError(
        "Gemini вернул каталог неизвестного формата.",
        502,
        "INVALID_CATALOG"
      );
    }

    for (const model of data.models) {
      if (
        typeof model.name !== "string" ||
        !model.supportedGenerationMethods?.includes("generateContent")
      ) {
        continue;
      }

      result.push({
        id: model.name,
        name: model.displayName || model.name,
        /*
          ListModels не всегда сообщает возможности ввода достаточно
          точно. Поэтому не обещаем поддержку изображений автоматически.
        */
        image: false
      });
    }

    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }

  return result;
}

function validateMessages(messages) {
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > 20
  ) {
    throw new AppError(
      "История должна содержать от 1 до 20 сообщений.",
      400,
      "INVALID_MESSAGES"
    );
  }

  for (const message of messages) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      (
        typeof message.content !== "string" &&
        !Array.isArray(message.content)
      )
    ) {
      throw new AppError(
        "Некорректный формат сообщения.",
        400,
        "INVALID_MESSAGES"
      );
    }

    if (!Array.isArray(message.content)) continue;

    if (message.content.length > 6) {
      throw new AppError(
        "Слишком много частей в одном сообщении.",
        400,
        "INVALID_MESSAGES"
      );
    }

    for (const part of message.content) {
      if (
        part?.type === "text" &&
        typeof part.text === "string"
      ) {
        continue;
      }

      if (
        part?.type === "image_url" &&
        typeof part.image_url?.url === "string" &&
        /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/
          .test(part.image_url.url)
      ) {
        continue;
      }

      throw new AppError(
        "Неподдерживаемое вложение.",
        400,
        "INVALID_ATTACHMENT"
      );
    }
  }
}

function geminiContents(messages) {
  return messages.map(message => {
    const parts = [];

    if (typeof message.content === "string") {
      parts.push({ text: message.content || " " });
    } else {
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push({ text: part.text });
          continue;
        }

        const match =
          /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/
            .exec(part.image_url.url);

        if (!match || match[2].length > 5_600_000) {
          throw new AppError(
            "Некорректное или слишком большое изображение.",
            400,
            "INVALID_IMAGE"
          );
        }

        parts.push({
          inline_data: {
            mime_type: match[1],
            data: match[2]
          }
        });
      }
    }

    return {
      role: message.role === "assistant" ? "model" : "user",
      parts: parts.length ? parts : [{ text: " " }]
    };
  });
}

async function chatWithGemini(model, messages, key) {
  if (!/^models\/[a-zA-Z0-9._-]+$/.test(model)) {
    throw new AppError(
      "Некорректный ID модели Gemini.",
      400,
      "INVALID_MODEL"
    );
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/` +
    `${model}:generateContent`;

  const data = await requestProvider(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      contents: geminiContents(messages),
      generationConfig: { maxOutputTokens: 2048 }
    })
  });

  const answer = (data.candidates?.[0]?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("");

  if (!answer.trim()) {
    throw new AppError(
      "Gemini не вернул текстовый ответ.",
      502,
      "EMPTY_PROVIDER_RESPONSE"
    );
  }

  return { text: answer };
}

async function chatWithHuggingFace(model, messages, key) {
  const data = await requestProvider(PROVIDERS.huggingface.chat, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      max_tokens: 2048
    })
  });

  const content = data.choices?.[0]?.message?.content;

  const answer =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map(part => part.text || "").join("")
        : "";

  if (!answer.trim()) {
    throw new AppError(
      "Hugging Face не вернул текстовый ответ.",
      502,
      "EMPTY_PROVIDER_RESPONSE"
    );
  }

  return { text: answer };
}

async function readJSONBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw new AppError(
        "Сообщение слишком большое.",
        413,
        "REQUEST_TOO_LARGE"
      );
    }

    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(
      "Некорректный JSON.",
      400,
      "INVALID_JSON"
    );
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    if (url.pathname === "/api/catalog" && req.method === "GET") {
      const provider = url.searchParams.get("provider");
      providerConfig(provider);

      const key = personalKey(req);

      const models = provider === "huggingface"
        ? await huggingFaceCatalog(key)
        : await geminiCatalog(key);

      return sendJSON(res, 200, { models });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readJSONBody(req);
      const provider = body?.provider;
      providerConfig(provider);

      const key = personalKey(req);
      const model = body?.model;

      if (
        typeof model !== "string" ||
        !model ||
        model.length > 200
      ) {
        throw new AppError(
          "Укажите корректную модель.",
          400,
          "INVALID_MODEL"
        );
      }

      validateMessages(body?.messages);

      const result = provider === "huggingface"
        ? await chatWithHuggingFace(model, body.messages, key)
        : await chatWithGemini(model, body.messages, key);

      return sendJSON(res, 200, result);
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      const content = await readFile(INDEX_FILE);

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": content.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });

      return res.end(content);
    }

    throw new AppError(
      "Страница не найдена.",
      404,
      "NOT_FOUND"
    );
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    if (!(error instanceof AppError)) {
      console.error("[server error]", error);
    }

    sendJSON(
      res,
      error instanceof AppError ? error.status : 500,
      {
        error: error instanceof AppError
          ? error.message
          : "Внутренняя ошибка сервера.",
        code: error instanceof AppError
          ? error.code
          : "INTERNAL_ERROR"
      }
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Extend: http://${HOST}:${PORT}`);
});