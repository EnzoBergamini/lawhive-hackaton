"""Intake Agent powered by Claude (via the Lawhive gateway) and pydantic-ai.

The agent runs a guided conversation with a prospective client:
  1. The client first picks a tone of voice for the agent.
  2. It asks what the legal issue is.
  3. From the client's description it asks targeted follow-up questions, one at
     a time, to gather everything a lawyer needs to assess the case.
  4. At any point the client can upload documents; the agent reads them and
     folds the findings into the case.

The aim is to give a lawyer a clear picture of the matter.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field

from anthropic import AsyncAnthropic
from pydantic_ai import Agent, BinaryContent, RunContext
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.providers.anthropic import AnthropicProvider

# The app talks to the Lawhive hackathon AI gateway, an Anthropic-compatible
# proxy that serves Claude (via Vertex). Configured through environment vars.
GATEWAY_BASE_URL = os.environ.get("LAWHIVE_AI_BASE_URL", "https://ai.hack.lawhive.co.uk")
GATEWAY_TOKEN = os.environ.get("LAWHIVE_AI_TOKEN", "")
MODEL = os.environ.get("LAWHIVE_MODEL", "vertex_ai/claude-opus-4-7")

# --- Prompt ------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are the "Intake Agent", a warm, professional legal intake assistant for a UK
law firm. You are NOT a lawyer and you do not give legal advice or predict
outcomes. Your single job is to interview a prospective client so that a human
lawyer can quickly understand their situation and decide how to help.

How to conduct the interview:
- Your very first message must briefly introduce yourself in one sentence and
  ask the open question: "What is the legal issue you need help with?"
- After the client describes their issue, ask AT MOST 6 follow-up questions in
  total — fewer if you already have enough. Ask ONE question at a time.
- Make every question count. Only ask things that genuinely change how a lawyer
  would assess or act on the case. Pick the most useful questions for THIS
  specific issue rather than working through a generic checklist. Prioritise:
  the key dates / sequence of events, the amount of money at stake, any
  upcoming deadline or court date, and what outcome the client wants. Skip
  anything the client has already told you or that doesn't matter here.
- Keep questions short and in plain English (no legal jargon). Be empathetic and
  non-judgemental, and acknowledge each answer in a few words before the next.
- CRITICAL: never ask the same question twice. Each question must be about a NEW
  topic you have not asked about yet. Before asking, check the conversation: if
  the client has already given an answer — even a short, vague, or imperfect one
  — accept it, move on, and do NOT re-ask. If an answer is unclear, make a
  reasonable interpretation from context (e.g. a bare number after you ask about
  desired outcome means that amount of money) rather than asking again. At most,
  rephrase once; never repeat a question a third time. If something stays
  unclear, just note it and move to a different topic.
- Once you have a useful picture (or after 6 questions), STOP asking. Summarise
  what you understood in 2-3 sentences, invite the client to upload any relevant
  documents using the attach button, and tell them a lawyer will review their
  case.
- If the client uploads documents, briefly acknowledge what you read in them
  (parties, dates, amounts) and ask only about anything still genuinely missing
  (within the 6-question budget).

Never invent facts. If something is unknown, leave it for the lawyer. Keep every
message concise — a couple of short paragraphs at most.
"""

# --- Tone of voice -----------------------------------------------------------

# The 6 tones the client can pick before the interview starts. `label` and
# `description` are shown on the selection screen; `guidance` steers the model.
TONES: dict[str, dict[str, str]] = {
    "empathetic": {
        "label": "Warm & empathetic",
        "description": "Gentle and understanding — acknowledges how you feel.",
        "guidance": "Adopt a warm, deeply empathetic tone. Acknowledge the "
        "client's feelings, show you care, and use gentle, reassuring language.",
    },
    "friendly": {
        "label": "Friendly & casual",
        "description": "Relaxed, conversational and approachable.",
        "guidance": "Adopt a friendly, casual, conversational tone — like a "
        "helpful person chatting. Stay relaxed and approachable, but respectful.",
    },
    "professional": {
        "label": "Professional & formal",
        "description": "Polished, precise and business-like.",
        "guidance": "Adopt a professional, formal, business-like tone. Be "
        "polished, precise and courteous, as a solicitor's office would be.",
    },
    "reassuring": {
        "label": "Calm & reassuring",
        "description": "Steady and calming — eases your worry.",
        "guidance": "Adopt a calm, reassuring tone. Keep the client at ease, "
        "reduce anxiety, and convey steady confidence that they are in good hands.",
    },
    "direct": {
        "label": "Concise & direct",
        "description": "Brief and to the point, no fluff.",
        "guidance": "Adopt a concise, direct, efficient tone. Keep messages brief "
        "and to the point with minimal small talk, while remaining polite.",
    },
    "supportive": {
        "label": "Patient & supportive",
        "description": "Encouraging and thorough — takes its time.",
        "guidance": "Adopt a patient, supportive, encouraging tone. Take time to "
        "make the client comfortable, encourage them to share, and never rush them.",
    },
}
DEFAULT_TONE = "professional"


def tone_options() -> list[dict[str, str]]:
    """The tone catalogue for the selection screen (no model guidance)."""
    return [
        {"id": tid, "label": t["label"], "description": t["description"]}
        for tid, t in TONES.items()
    ]


# Map file extensions to the media types the model understands.
_MEDIA_TYPES = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain",
}


def media_type_for(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    return _MEDIA_TYPES.get(ext, "application/octet-stream")


@dataclass
class Deps:
    """Per-run dependencies — carries the chosen tone into the agent."""

    tone_guidance: str


@dataclass
class Session:
    """In-memory state for one client conversation."""

    messages: list[ModelMessage] = field(default_factory=list)
    tone: str = DEFAULT_TONE


class IntakeAgent:
    def __init__(self) -> None:
        # Point the Anthropic client at the gateway; it authenticates with a
        # bearer token rather than a standard Anthropic API key.
        client = AsyncAnthropic(base_url=GATEWAY_BASE_URL, auth_token=GATEWAY_TOKEN)
        model = AnthropicModel(MODEL, provider=AnthropicProvider(anthropic_client=client))
        self.agent = Agent(model, deps_type=Deps, system_prompt=SYSTEM_PROMPT)
        self.sessions: dict[str, Session] = {}

        # Dynamic instruction: inject the chosen tone on every request so it
        # applies consistently across the whole conversation.
        @self.agent.instructions
        def _tone(ctx: RunContext[Deps]) -> str:
            return ctx.deps.tone_guidance

    def _session(self, session_id: str) -> Session:
        if session_id not in self.sessions:
            self.sessions[session_id] = Session()
        return self.sessions[session_id]

    async def _run(self, session: Session, prompt) -> str:
        """Run one turn through the agent with backoff on 429 rate limits."""
        deps = Deps(tone_guidance=TONES.get(session.tone, TONES[DEFAULT_TONE])["guidance"])
        delays = [2, 8, 20]
        for attempt in range(len(delays) + 1):
            try:
                result = await self.agent.run(
                    prompt, message_history=session.messages, deps=deps
                )
                session.messages = result.all_messages()
                return result.output.strip()
            except ModelHTTPError as exc:
                if exc.status_code != 429:
                    raise
                if attempt == len(delays):
                    # Quota (often the free-tier daily cap) is exhausted: degrade
                    # gracefully instead of surfacing a raw error to the client.
                    return (
                        "I'm receiving a lot of requests right now and have hit a "
                        "temporary usage limit. Please try again in a little while — "
                        "your conversation so far has been saved."
                    )
                await asyncio.sleep(delays[attempt])

    # --- Chat ----------------------------------------------------------------

    async def start(self, session_id: str, tone: str | None = None) -> str:
        """Produce the agent's opening message using the chosen tone."""
        session = self._session(session_id)
        session.messages = []
        session.tone = tone if tone in TONES else DEFAULT_TONE
        return await self._run(session, "Please begin the intake conversation.")

    async def chat(self, session_id: str, message: str) -> str:
        return await self._run(self._session(session_id), message)

    # --- Documents -----------------------------------------------------------

    async def add_documents(self, session_id: str, files: list[tuple[str, bytes]]) -> str:
        """Send uploaded documents into the conversation and get the reply.

        `files` is a list of (filename, raw_bytes). Each file is attached as
        multimodal content so Gemini reads it directly; the agent then
        acknowledges what it saw and asks about anything still missing.
        """
        session = self._session(session_id)
        names = ", ".join(name for name, _ in files)
        prompt: list = [
            f"The client uploaded the following document(s) as evidence: {names}. "
            "Read them, briefly acknowledge the key facts a lawyer would care about "
            "(parties, dates, amounts, deadlines), and ask about anything still missing."
        ]
        for name, data in files:
            prompt.append(BinaryContent(data=data, media_type=media_type_for(name)))
        return await self._run(session, prompt)
