"""FastAPI server for the Intake Agent."""

from __future__ import annotations

import os
import re

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

load_dotenv()

from .agent import IntakeAgent, bypass_enabled, tone_options  # noqa: E402  (after load_dotenv)

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
    name: str | None = None


class ChatRequest(BaseModel):
    session_id: str
    message: str


@app.get("/api/tones")
def tones():
    return {"tones": tone_options()}


@app.get("/api/config")
def config():
    """Frontend bootstrap flags. `bypass` skips intake straight to the timeline."""
    return {"bypass": bypass_enabled()}


@app.post("/api/start")
async def start(req: StartRequest):
    r = await agent.start(req.session_id, req.tone, req.name)
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


class DossierRequest(BaseModel):
    session_id: str


@app.post("/api/dossier")
async def dossier(req: DossierRequest):
    """Extract the structured case file (synthesis + timeline) for a session."""
    case = await agent.build_case_file(req.session_id)
    return case.model_dump(mode="json")


@app.post("/api/assessment")
async def assessment(req: DossierRequest):
    """Write the plain-English case assessment (loaded after the timeline)."""
    return {"case_assessment": await agent.build_assessment(req.session_id)}


class AddEventRequest(BaseModel):
    session_id: str
    title: str
    date: str | None = None  # ISO yyyy-mm-dd, or empty for an undated event
    date_text: str | None = None
    detail: str | None = None
    category: str = "other"
    disputed: bool = False
    is_deadline: bool = False


@app.post("/api/event")
async def add_event(req: AddEventRequest):
    """Manually add an event to the timeline; returns the updated case file."""
    case = await agent.add_event(req.session_id, req.model_dump(exclude={"session_id"}))
    return case.model_dump(mode="json")


@app.post("/api/dossier/chat")
async def dossier_chat(req: ChatRequest):
    """Answer a question about the case file (the dossier side chat)."""
    return {"reply": await agent.chat_about_case(req.session_id, req.message)}


@app.get("/api/document")
def document(session_id: str, name: str):
    """Serve an uploaded document inline, so a timeline card can open it."""
    found = agent.get_document(session_id, name)
    if found is None:
        raise HTTPException(status_code=404, detail="Document not found")
    data, media_type = found
    filename = os.path.basename(name)
    return Response(
        content=data,
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@app.post("/api/documents")
async def documents(session_id: str = Form(...), files: list[UploadFile] = File(...)):
    """Store uploaded documents on disk for later processing (no AI here)."""
    safe = re.sub(r"[^A-Za-z0-9_-]", "", session_id) or "session"
    dest = os.path.join(UPLOAD_DIR, safe)
    os.makedirs(dest, exist_ok=True)

    stored = []
    payload = []
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
        data = await f.read()
        with open(path, "wb") as out:
            out.write(data)
        stored.append(name)
        payload.append((name, data))

    # Also attach to the session so the case-file extractor can read them.
    agent.register_documents(session_id, payload)

    return {"stored": stored, "count": len(stored), "dir": f"uploads/{safe}"}


@app.get("/api/health")
def health():
    return {"status": "ok"}
