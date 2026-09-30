# Extend

**A quieter space to think with AI.**

Extend is a minimalist AI chat workspace for local models, Hugging Face, Google Gemini, and custom OpenAI-compatible APIs. It brings conversations, model selection, drafts, and personalization together in a clean interface.

## Features

- **Local models** powered by WebLLM and WebGPU — no API key required
- **Hugging Face** and **Google Gemini** connections using personal API keys
- **Custom OpenAI-compatible API** connection
- Searchable model catalog
- Download indicator for cached local models
- Persistent conversations and a separate draft for each chat
- Text, PDF, and image attachments where supported
- Color themes and a custom photo background
- Automatic language detection and manual language selection
- Responsive layout with smooth transitions

## Requirements

- [Node.js](https://nodejs.org/) **20 or newer**
- A modern browser
- WebGPU support for local models, typically available in recent versions of Chrome or Edge
- An internet connection for cloud providers and the first download of a local model

## Run locally

Clone the repository:

```bash
git clone https://github.com/Xel-lenes/Extend.git
cd Extend
```

Start Extend:

```bash
npm start
```

Then open **http://127.0.0.1:8000** in your browser.


### Running on Windows without Git

You can also download the repository as a ZIP file from GitHub:

1. Click **Code → Download ZIP**.
2. Extract the archive.
3. Open Command Prompt in the extracted project folder.
4. Run `npm start`.
5. Open **http://127.0.0.1:8000**.

## Connect a model

Click the model selector below the message field and choose a provider:

| Provider | What you need |
| --- | --- |
| **Local** | A WebGPU-compatible browser and enough device memory. No API key is needed. |
| **Hugging Face** | A personal Hugging Face token. Add it in **Settings**. |
| **Google Gemini** | A personal Gemini API key. Add it in **Settings**. |
| **Custom API** | A full OpenAI-compatible `/chat/completions` URL, a model ID, and an API key if your server requires one. |

Local models are downloaded when first used. Subsequent launches may use the browser’s model cache.

Custom API requests are sent directly from the browser. Your custom API server must allow requests from Extend through **CORS**.

## Attachments

Extend supports text files, PDFs, and images. Text files and PDFs are converted into text for the model. Image attachments are available only when the selected connection is configured to support images.

Image-only scanned PDFs may not contain extractable text.

## Data and privacy

Extend saves conversations, per-chat drafts, settings, provider credentials, and the custom background photo in your browser. Data is not automatically synchronized across devices.

**Saved API keys are not additionally encrypted by Extend.** Do not save personal keys on a shared computer. Clearing the browser’s site data will remove locally stored chats, drafts, keys, and settings.

Local-model generation runs on your device. When you use Hugging Face, Gemini, or a custom API, the messages and supported attachments required for your request are sent to that provider.

## Known limitations

- Local models require compatible WebGPU hardware and sufficient memory.
- The first download of a local model can be large.
- Model availability, pricing, quotas, and regional restrictions are determined by each provider.
- Gemini API may be unavailable in some regions.
- Not every model supports images or every attachment format.
- Custom APIs must use a compatible chat-completions format and permit browser requests through CORS.

## Project structure

```text
extend/
├── package.json
├── server.mjs
└── public/
    └── index.html
```

---

**Extend** — make room for the next idea.
