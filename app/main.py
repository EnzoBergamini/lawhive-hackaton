"""FastAPI server for the Intake Agent."""

from __future__ import annotations

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

from .agent import IntakeAgent  # noqa: E402  (after load_dotenv so the key is set)

app = FastAPI(title="Intake Agent")

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


class ChatRequest(BaseModel):
    session_id: str
    message: str


@app.post("/api/start")
async def start(req: StartRequest):
    return {"reply": await agent.start(req.session_id)}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    return {"reply": await agent.chat(req.session_id, req.message)}


@app.post("/api/upload")
async def upload(session_id: str = Form(...), files: list[UploadFile] = File(...)):
    payload = [(f.filename or "document", await f.read()) for f in files]
    reply = await agent.add_documents(session_id, payload)
    return {"reply": reply, "files": [name for name, _ in payload]}


@app.get("/api/health")
def health():
    return {"status": "ok"}
