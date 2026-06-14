# Portfolio Backend — Project Overview

## What is this?

The backend for Muhammed Shariq's portfolio site (`msmshariq.com`). A Cloudflare Worker that serves a streaming RAG-based chat API, allowing recruiters and employers to have a conversation with an "AI version" of Shariq. Powered by LangGraph.js, OpenAI, and Cloudflare Vectorize.

**Owner:** Muhammed Shariq (msmshariq@gmail.com)  
**Frontend repo:** `msmshariq/portfolio-web` (Next.js, deployed on Cloudflare Pages at msmshariq.com)  
**Backend repo:** `msmshariq/portfolio-backend` (this repo)

---

## Architecture

```
portfolio-backend/
├── worker/          # Cloudflare Worker — chat API endpoint (streaming)
├── ingestion/       # Scripts to embed source docs → Cloudflare Vectorize
├── data/            # Markdown source files (CV, LinkedIn, bio)
└── CLAUDE.md
```

### Request flow

```
User (chat UI) → Cloudflare Worker → LangGraph.js RAG pipeline
                                          ├── Embed user query (OpenAI)
                                          ├── Search Cloudflare Vectorize
                                          ├── Build prompt with context
                                          └── Stream response from OpenAI → User
```

---

## Tech Stack

- **Runtime:** Cloudflare Workers (JS/TS)
- **AI Orchestration:** LangGraph.js
- **Embeddings & LLM:** OpenAI API (`text-embedding-3-small` for embeddings, `gpt-4o` for chat)
- **Vector Store:** Cloudflare Vectorize
- **Streaming:** Server-Sent Events (SSE)
- **Package Manager:** npm

---

## Key Decisions

- **Streaming responses** — OpenAI tokens streamed via SSE for real-time "typing" UX
- **Session memory** — LangGraph manages conversation history within a session (multi-turn, so recruiters can ask follow-up questions)
- **One repo for API + AI** — no separate AI service; the Worker handles both the API layer and the RAG orchestration
- **Cloudflare-native** — Vectorize for vector storage, Workers for compute; keeps everything in one ecosystem alongside the frontend

---

## Data Sources (RAG knowledge base)

Files live in `data/` as markdown:
- `cv.md` — Full CV/resume content
- `linkedin.md` — LinkedIn profile content
- `bio.md` — Additional context, tone, personality notes for the AI

Ingestion pipeline (`ingestion/`) converts these to OpenAI embeddings and indexes them into Cloudflare Vectorize.

---

## API

### `POST /chat` (streaming)

Accepts a user message + session history, returns a streaming SSE response.

**Request:**
```json
{
  "message": "What experience does Shariq have with Kubernetes?",
  "sessionId": "uuid",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

**Response:** SSE stream of text chunks.

### `OPTIONS /chat`

CORS preflight — required for browser requests from `msmshariq.com`.

---

## Environment Variables / Secrets

Set in Cloudflare Workers dashboard or `wrangler.toml`:

| Key | Description |
|-----|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `VECTORIZE_INDEX_NAME` | Cloudflare Vectorize index name |

---

## How to Run Locally

```bash
cd worker
npm install
npx wrangler dev
```

---

## Deployment

Cloudflare Workers — deployed via `wrangler publish` or GitHub Actions on push to `main`.

---

## Frontend Integration

The chat UI is a floating bubble component in `portfolio-web`. It:
- Opens a chat drawer on click
- Shows a proactive prompt message after a few seconds to nudge recruiters
- Sends messages to this Worker's `/chat` endpoint
- Renders the SSE stream token by token (streaming)

---

## What's Not Built Yet

- [ ] Worker scaffolding (`worker/`)
- [ ] LangGraph.js RAG pipeline
- [ ] Cloudflare Vectorize index setup
- [ ] Ingestion scripts (`ingestion/`)
- [ ] Data markdown files (`data/`)
- [ ] Chat UI component in `portfolio-web`
- [ ] CORS configuration
- [ ] GitHub Actions deploy workflow
