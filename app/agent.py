"""CLEARFILE — legal intake agent powered by Claude (via the Lawhive gateway) and pydantic-ai.

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

from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from pydantic_ai import Agent, BinaryContent, RunContext
from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from .timeline import CaseFile

# The app talks to OpenAI directly, authenticated with a standard API key.
# Configured through environment vars.
OPENAI_API_KEY = os.environ.get("OPEN_AI_API_KEY", "")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o")

# Sample-case directory used by the dev intake bypass (see BY_PASS_INTAKE below).
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

# When set, skip the intake conversation entirely and preload a sample case's
# documents so we can iterate on the timeline. Empty / falsy disables it; a
# truthy flag ("1", "true", …) uses "case-1"; an explicit folder name like
# "case-3" loads that case from `data/`.
BY_PASS_INTAKE = os.environ.get("BY_PASS_INTAKE", "").strip()


def _bypass_case() -> str:
    """Return the sample case folder to preload, or "" when bypass is off."""
    val = BY_PASS_INTAKE.lower()
    if val in ("", "0", "false", "no", "off"):
        return ""
    if val in ("1", "true", "yes", "on"):
        return "case-1"
    return BY_PASS_INTAKE


def bypass_enabled() -> bool:
    """Whether the dev intake bypass is active (exposed to the frontend)."""
    return bool(_bypass_case())

# --- Prompt ------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are "CLEARFILE", a warm, professional legal intake assistant for a UK law
firm. You are NOT a lawyer and you do not give legal advice or predict
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
  what you understood in 2-3 sentences, let the client know they'll be able to
  add any supporting documents next, and that a lawyer will review their case.
- If the client uploads documents, briefly acknowledge what you read in them
  (parties, dates, amounts) and ask only about anything still genuinely missing
  (within the 6-question budget).

Never invent facts. If something is unknown, leave it for the lawyer. Keep every
message concise — a couple of short paragraphs at most.

Your response has two fields:
- `message`: what the client reads (your question, acknowledgement, or wrap-up).
- `intake_complete`: set this to true ONLY on your final wrap-up turn — when you
  have a useful picture (or have already asked 6 questions), you are summarising
  what you understood, and you are letting the client know a lawyer will review
  their case. On every other turn it MUST be false.
"""

# --- Case file extraction ----------------------------------------------------

EXTRACTION_PROMPT = """\
You build a structured case file for a UK lawyer from a completed intake: the
conversation transcript plus any documents the client uploaded. You do not give
legal advice — you organise the facts so a lawyer gets a clear snapshot.

Produce:
- matter_type: the type of dispute in a few words (e.g. "Unfair dismissal /
  redundancy", "Consumer Rights Act — faulty car", "Flight delay compensation").
- summary: 2-3 neutral sentences describing the situation.
- parties: each person/organisation involved, with their role (client, employer,
  garage, airline, landlord, etc.).
- amount_in_dispute: the headline sum at stake, only if there is one.
- next_deadline: the most pressing upcoming deadline or date (appeal window,
  court date, limitation), only if one exists. Use a short label.
- events: the chronological timeline. Extract EVERY dated fact — one event per
  distinct fact. A single document often yields many events.

For each event:
- date: the normalised ISO date (YYYY-MM-DD), used for sorting. Resolve relative
  dates ("last week", "today") using nearby dates in the transcript/documents as
  an anchor. If only a month or year is known, use the first of that month/year.
  Set null only when the date is genuinely unknown.
- date_text: the date exactly as stated ("last week", "Feb 2024", "27 May 2026").
- title: what happened, as a short headline (a few words).
- detail: one short sentence describing the event in plain English. Always
  provide one — it is the description shown on the timeline card.
- category: one of agreement, payment, communication, breach, notice, complaint,
  legal_action, decision, deadline, incident, other.
- parties: who was involved in this event.
- amount: only when money is the subject of the event.
- source: the document filename it came from, or "Conversation".
- disputed: true when the fact is contested between the parties.
- is_deadline: true for a future deadline / date not to miss.

Rules: never invent facts; if unsure, omit. Only include fields that carry real
meaning — do not pad. Be exhaustive about events but precise about each one.
"""

# Generated by a separate call (kept apart from the structured extraction so
# neither request grows long enough to hit the gateway timeout).
ASSESSMENT_PROMPT = """\
You write a clear, plain-English assessment of a UK legal case for the CLIENT,
from the case summary and timeline of evidenced facts provided. Address the
client as "you". Ground everything ONLY in the facts given — each fact notes the
document it came from (e.g. "[bank_statement_deposit_payment.pdf]"); use that to
say things like "your bank statement shows…".

Write a few short paragraphs separated by a blank line, in this order:
1. A direct headline conclusion (one or two sentences) — the core finding.
2. "Here's what the documents show:" — the key evidenced facts, each with the
   date, amount and WHICH document it comes from.
3. The legal duty and whether it was met — cite the relevant statute or
   regulation AND, where possible, the client's own document (e.g. a specific
   contract clause or schedule). Name any second, separate breach.
4. "What this means for you:" — the client's entitlements or options in concrete
   terms, with the figures involved (e.g. a compensation range).
5. How strong the claim/position is and WHY, pointing to the specific evidence.
6. One thing to be aware of — a caveat, risk, or related consequence.

Cite the real figures, dates and document names from the facts. Never invent
facts that are not provided. If the evidence is weak, partial or mixed, say so
honestly rather than overstating. Plain text only — no markdown symbols,
headings or bullet characters. Return ONLY the assessment text.
"""

# --- Tone of voice -----------------------------------------------------------

# The 5 modes the client can pick before the interview starts. They tailor how
# the agent communicates for a legal context. `label` and `description` are
# shown on the selection screen; `guidance` steers the model.
TONES: dict[str, dict[str, str]] = {
    "plain_english": {
        "label": "Plain English",
        "description": "Everyday language, with the legal term in brackets so you can look it up.",
        "guidance": "Communicate in plain, everyday English. Avoid legal jargon. "
        "When a legal concept is genuinely unavoidable, explain it simply and put "
        "the formal legal term in brackets so the client can look it up or quote "
        "it — e.g. \"a written explanation of why you were dismissed (this is "
        "called a 'statement of reasons')\".",
    },
    "step_by_step": {
        "label": "Step by Step",
        "description": "A clear sequence — what's happened, your options, what to do first.",
        "guidance": "Communicate as a clear, ordered sequence: what has happened, "
        "what the options are, and what to do first. Take one logical step at a "
        "time. Do not go into branching scenarios or 'it depends' tangents unless "
        "the client asks. This suits clients who feel overwhelmed by complexity "
        "or urgency.",
    },
    "key_points": {
        "label": "Just the Key Points",
        "description": "A short bullet summary of what matters — rights, deadlines, risks.",
        "guidance": "Communicate in a short bullet summary of only the most "
        "important facts — rights, deadlines and risks — without explanation or "
        "elaboration. Keep it scannable and minimal, for clients who find detail "
        "distracting and just need to know what matters right now.",
    },
    "full_detail": {
        "label": "Full Detail",
        "description": "Complete context, caveats, legal references and reasoning.",
        "guidance": "Communicate with complete context: include relevant caveats, "
        "the reasoning behind things, and legal references where helpful. Don't "
        "leave gaps or ambiguity — err toward thoroughness over brevity, for "
        "clients who find gaps or ambiguity more distressing than complexity.",
    },
    "check_as_we_go": {
        "label": "Check As We Go",
        "description": "One short question at a time, checking in as we go.",
        "guidance": "Ask one short question at a time and confirm you have "
        "understood the client's answer before moving on. Check in regularly and "
        "keep each message small, for clients who find it hard to absorb a large "
        "amount of information at once.",
    },
}
DEFAULT_TONE = "plain_english"


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


def load_sample_documents(case: str) -> list[tuple[str, bytes]]:
    """Read every supported document from `data/<case>` as (filename, bytes).

    Used by the dev intake bypass to preload a case so the timeline can be
    built without going through the conversation first.
    """
    folder = os.path.join(DATA_DIR, case)
    docs: list[tuple[str, bytes]] = []
    if not os.path.isdir(folder):
        return docs
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if os.path.isfile(path) and media_type_for(name) != "application/octet-stream":
            with open(path, "rb") as fh:
                docs.append((name, fh.read()))
    return docs


class IntakeReply(BaseModel):
    """Structured turn output: the visible message plus a completion flag."""

    message: str = Field(description="The message shown to the client.")
    intake_complete: bool = Field(
        default=False,
        description="True only on the final wrap-up turn, once enough has been "
        "gathered; false on every other turn.",
    )


@dataclass
class Deps:
    """Per-run dependencies — carries the chosen tone into the agent."""

    tone_guidance: str


@dataclass
class Session:
    """In-memory state for one client conversation."""

    messages: list[ModelMessage] = field(default_factory=list)
    tone: str = DEFAULT_TONE
    name: str | None = None
    # Clean text transcript (role, text) and the raw bytes of uploaded documents,
    # both fed to the extractor when building the case file.
    transcript: list[tuple[str, str]] = field(default_factory=list)
    documents: list[tuple[str, bytes]] = field(default_factory=list)
    # The last extracted case file, cached so the (deferred) assessment can be
    # written from it without re-reading the documents.
    case_file: CaseFile | None = None


class IntakeAgent:
    def __init__(self) -> None:
        # Standard OpenAI client, authenticated with an API key.
        client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        model = OpenAIChatModel(MODEL, provider=OpenAIProvider(openai_client=client))
        self.agent = Agent(
            model, deps_type=Deps, output_type=IntakeReply, system_prompt=SYSTEM_PROMPT
        )
        # Separate agent that turns a finished intake into a structured CaseFile.
        self.extractor = Agent(model, output_type=CaseFile, system_prompt=EXTRACTION_PROMPT)
        # And a plain-text agent that writes the client-facing case assessment.
        self.assessor = Agent(model, system_prompt=ASSESSMENT_PROMPT)
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

    async def _run(self, session: Session, prompt) -> IntakeReply:
        """Run one turn through the agent with backoff on 429 rate limits."""
        deps = Deps(tone_guidance=TONES.get(session.tone, TONES[DEFAULT_TONE])["guidance"])
        delays = [2, 8, 20]
        for attempt in range(len(delays) + 1):
            try:
                result = await self.agent.run(
                    prompt, message_history=session.messages, deps=deps
                )
                session.messages = result.all_messages()
                reply = result.output
                reply.message = reply.message.strip()
                return reply
            except ModelHTTPError as exc:
                if exc.status_code != 429:
                    raise
                if attempt == len(delays):
                    # Quota (often the free-tier daily cap) is exhausted: degrade
                    # gracefully instead of surfacing a raw error to the client.
                    return IntakeReply(
                        message=(
                            "I'm receiving a lot of requests right now and have hit "
                            "a temporary usage limit. Please try again in a little "
                            "while — your conversation so far has been saved."
                        ),
                        intake_complete=False,
                    )
                await asyncio.sleep(delays[attempt])

    # --- Chat ----------------------------------------------------------------

    async def start(
        self, session_id: str, tone: str | None = None, name: str | None = None
    ) -> str:
        """Produce the agent's opening message using the chosen tone and name."""
        session = self._session(session_id)
        session.messages = []
        session.transcript = []
        session.documents = []
        session.case_file = None
        session.tone = tone if tone in TONES else DEFAULT_TONE
        session.name = (name or "").strip() or None

        # DEV bypass: skip the conversation, preload a sample case's documents,
        # and report the intake as already complete so the UI jumps to the
        # timeline. No model call is made here.
        case = _bypass_case()
        if case:
            docs = load_sample_documents(case)
            session.documents.extend(docs)
            names = ", ".join(n for n, _ in docs) or "none"
            session.transcript.append(
                ("Assistant", f"[Intake bypassed — preloaded documents from {case}: {names}]")
            )
            return IntakeReply(
                message=(
                    f"Intake bypassed (dev mode). Loaded {len(docs)} document(s) "
                    f"from {case} — building the timeline."
                ),
                intake_complete=True,
            )

        kickoff = "Please begin the intake conversation."
        if session.name:
            kickoff += (
                f" The client's name is {session.name} — greet them warmly by "
                "their first name in your opening sentence."
            )
            # Record the name so it flows into the case file too.
            session.transcript.append(("Client", f"My name is {session.name}."))
        reply = await self._run(session, kickoff)
        session.transcript.append(("Assistant", reply.message))
        return reply

    async def chat(self, session_id: str, message: str) -> str:
        session = self._session(session_id)
        session.transcript.append(("Client", message))
        reply = await self._run(session, message)
        session.transcript.append(("Assistant", reply.message))
        return reply

    # --- Documents -----------------------------------------------------------

    async def add_documents(self, session_id: str, files: list[tuple[str, bytes]]) -> str:
        """Send uploaded documents into the conversation and get the reply.

        `files` is a list of (filename, raw_bytes). Each file is attached as
        multimodal content so Gemini reads it directly; the agent then
        acknowledges what it saw and asks about anything still missing.
        """
        session = self._session(session_id)
        session.documents.extend(files)
        names = ", ".join(name for name, _ in files)
        session.transcript.append(("Client", f"[Uploaded documents: {names}]"))
        prompt: list = [
            f"The client uploaded the following document(s) as evidence: {names}. "
            "Read them, briefly acknowledge the key facts a lawyer would care about "
            "(parties, dates, amounts, deadlines), and ask about anything still missing."
        ]
        for name, data in files:
            prompt.append(BinaryContent(data=data, media_type=media_type_for(name)))
        reply = await self._run(session, prompt)
        session.transcript.append(("Assistant", reply.message))
        return reply

    def register_documents(self, session_id: str, files: list[tuple[str, bytes]]) -> None:
        """Attach documents to the session for extraction, without an AI turn.

        Used by the final upload screen, which stores files on disk; we also keep
        the bytes here so the case-file extractor can read them.
        """
        self._session(session_id).documents.extend(files)

    def get_document(self, session_id: str, name: str) -> tuple[bytes, str] | None:
        """Return (bytes, media_type) for an uploaded document, or None.

        Matches on the full name first, then on the basename, so a timeline
        event's `source` resolves even if the path differs slightly.
        """
        session = self.sessions.get(session_id)
        if session is None:
            return None
        base = os.path.basename(name)
        for fname, data in session.documents:
            if fname == name or os.path.basename(fname) == base:
                return data, media_type_for(fname)
        return None

    # --- Case file -----------------------------------------------------------

    async def _run_agent(self, agent: Agent, prompt: list):
        """Run an extraction/assessment agent with backoff on 429 rate limits."""
        delays = [2, 8, 20]
        for attempt in range(len(delays) + 1):
            try:
                result = await agent.run(prompt)
                return result.output
            except ModelHTTPError as exc:
                if exc.status_code != 429 or attempt == len(delays):
                    raise
                await asyncio.sleep(delays[attempt])

    async def build_case_file(self, session_id: str) -> CaseFile:
        """Extract the structured case file (synthesis + timeline) for a session.

        The extractor reads the transcript + the raw documents and returns a
        validated `CaseFile`, sorted oldest-first (undated last). The client
        assessment is produced separately by `build_assessment` so the timeline
        can be shown first while the assessment loads. The result is cached on
        the session for that follow-up call.
        """
        session = self._session(session_id)
        transcript = "\n".join(f"{role}: {text}" for role, text in session.transcript)
        prompt: list = [
            "Here is a completed legal intake.\n\n"
            f"=== Conversation transcript ===\n{transcript}\n\n"
            "=== Uploaded documents follow (if any) ==="
        ]
        for name, data in session.documents:
            prompt.append(f"Document: {name}")
            prompt.append(BinaryContent(data=data, media_type=media_type_for(name)))

        case: CaseFile = await self._run_agent(self.extractor, prompt)
        case.sorted()
        session.case_file = case
        return case

    async def build_assessment(self, session_id: str) -> str:
        """Write the plain-English client assessment from the extracted facts.

        Uses the case file cached by `build_case_file` (extracting it first if it
        hasn't been built yet). No documents are re-sent, so this call stays
        light and well under the gateway timeout.
        """
        session = self._session(session_id)
        case = session.case_file or await self.build_case_file(session_id)
        assessment = await self._run_agent(self.assessor, [self._case_facts(case)])
        case.case_assessment = (assessment or "").strip()
        return case.case_assessment

    @staticmethod
    def _case_facts(case: CaseFile) -> str:
        """Render the extracted case file as compact text for the assessor."""
        lines = [f"Matter: {case.matter_type}", f"Summary: {case.summary}", ""]
        if case.parties:
            lines.append("Parties:")
            lines += [f"  - {p.name} ({p.role})" for p in case.parties]
        if case.amount_in_dispute:
            m = case.amount_in_dispute
            lines.append(f"Amount in dispute: {m.currency} {m.amount}")
        if case.next_deadline:
            lines.append(f"Next deadline: {case.next_deadline.label} ({case.next_deadline.date_text})")
        lines.append("\nTimeline of evidenced facts:")
        for e in case.events:
            amt = f" — {e.amount.currency} {e.amount.amount}" if e.amount else ""
            flags = " [DISPUTED]" if e.disputed else ""
            lines.append(f"  - {e.date_text}: {e.title}{amt}{flags}")
            lines.append(f"      {e.detail}  [{e.source}]")
        return "\n".join(lines)
