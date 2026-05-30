"""FastAPI server for the Intake Agent."""

from __future__ import annotations

import os
import re

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

from .agent import IntakeAgent, tone_options  # noqa: E402  (after load_dotenv)

app = FastAPI(title="CLEARFILE")

# Where uploaded documents are stored on disk. The actual processing of these
# files is done later — here we just collect and persist them.
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")

# Allow the Vite dev server to call the API directly during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

agent = IntakeAgent()


class StartRequest(BaseModel):
    session_id: str
    tone: str | None = None


class ChatRequest(BaseModel):
    session_id: str
    message: str


@app.get("/api/tones")
def tones():
    return {"tones": tone_options()}


@app.post("/api/start")
async def start(req: StartRequest):
    r = await agent.start(req.session_id, req.tone)
    return {"reply": r.message, "done": r.intake_complete}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    r = await agent.chat(req.session_id, req.message)
    return {"reply": r.message, "done": r.intake_complete}


@app.post("/api/upload")
async def upload(session_id: str = Form(...), files: list[UploadFile] = File(...)):
    payload = [(f.filename or "document", await f.read()) for f in files]
    r = await agent.add_documents(session_id, payload)
    return {"reply": r.message, "done": r.intake_complete, "files": [name for name, _ in payload]}


@app.post("/api/documents")
async def documents(session_id: str = Form(...), files: list[UploadFile] = File(...)):
    """Store uploaded documents on disk for later processing (no AI here)."""
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session_id) or "session"
    dest = os.path.join(UPLOAD_DIR, safe)
    os.makedirs(dest, exist_ok=True)

    stored = []
    for f in files:
        name = os.path.basename(f.filename or "document")
        path = os.path.join(dest, name)
        # Avoid overwriting a file with the same name.
        base, ext = os.path.splitext(name)
        n = 1
        while os.path.exists(path):
            name = f"{base}_{n}{ext}"
            path = os.path.join(dest, name)
            n += 1
        with open(path, "wb") as out:
            out.write(await f.read())
        stored.append(name)

    return {"stored": stored, "count": len(stored), "dir": f"uploads/{safe}"}


@app.get("/api/health")
def health():
    return {"status": "ok"}
