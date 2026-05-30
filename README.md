# Intake Agent

A minimalist conversational **legal intake assistant**. It interviews a
prospective client, gathers the facts a lawyer needs, and lets the client upload
supporting documents — so a lawyer gets a clear picture of the matter.

Powered by **Claude** (`vertex_ai/claude-opus-4-7`) through the Lawhive hackathon
AI gateway, called via **pydantic-ai**.

## How it works

1. The **Intake Agent** greets the client and asks *"What is the legal issue you
   need help with?"*
2. From the description it asks focused follow-up questions, one at a time
   (parties, timeline, amounts, desired outcome, deadlines, steps taken…).
3. The client can **attach documents** (PDFs, images, court forms). Gemini reads
   them and folds the findings into the conversation.

## Stack

- **Backend** — Python · FastAPI · `pydantic-ai` · Claude `claude-opus-4-7`
  (Anthropic-compatible Lawhive AI gateway)
- **Frontend** — React (Vite), minimalist centered chat
- The Vite dev server proxies `/api` to the FastAPI backend.

## Prerequisites

- Python 3.11+
- Node.js 18+
- Gateway credentials in `.env` (already present):
  - `LAWHIVE_AI_BASE_URL` — gateway base URL
  - `LAWHIVE_AI_TOKEN` — bearer token
  - `LAWHIVE_MODEL` — model id (default `vertex_ai/claude-opus-4-7`)

## Setup

```bash
# 1. Backend dependencies
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 2. Frontend dependencies
cd frontend && npm install && cd ..
```

## Run

You need **two terminals**.

**Terminal 1 — backend (port 8000):**

```bash
.venv/bin/uvicorn app.main:app --reload --port 8000
```

**Terminal 2 — frontend (port 5173):**

```bash
cd frontend && npm run dev
```

Then open **http://localhost:5173**

> The frontend proxies API calls to the backend, so both must be running.

## Configuration

All set via `.env`:

- `LAWHIVE_AI_BASE_URL` — gateway base URL (default `https://ai.hack.lawhive.co.uk`)
- `LAWHIVE_AI_TOKEN` — bearer token used to authenticate with the gateway
- `LAWHIVE_MODEL` — model id served by the gateway (default `vertex_ai/claude-opus-4-7`)

## Notes

- Conversations are kept in memory (fine for a demo); restarting the backend
  clears state.
- The agent is explicitly instructed **not** to give legal advice — it only
  collects information for a human lawyer.
- Sample cases live in `data/` for testing the document upload flow.
