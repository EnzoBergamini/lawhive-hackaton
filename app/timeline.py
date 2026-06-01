"""Structured case file produced from an intake conversation.

A `CaseFile` is the snapshot a lawyer sees once intake is done: a short synthesis
header plus a chronological timeline of events extracted from the conversation
and the uploaded documents. The extraction itself lives in `agent.py`; this
module only defines the data shape and the chronological ordering.
"""

from __future__ import annotations

import datetime as dt
from enum import Enum

from pydantic import BaseModel, Field


class Category(str, Enum):
    """Coarse event type — drives the colour badge on the timeline."""

    agreement = "agreement"
    payment = "payment"
    communication = "communication"
    breach = "breach"
    notice = "notice"
    complaint = "complaint"
    legal_action = "legal_action"
    decision = "decision"
    deadline = "deadline"
    incident = "incident"
    other = "other"


class Money(BaseModel):
    amount: float
    currency: str = "GBP"


class Party(BaseModel):
    name: str
    role: str = Field(description="e.g. client, employer, garage, airline")


class Event(BaseModel):
    """One dated fact in the case timeline."""

    date: dt.date | None = Field(
        None, description="Normalised ISO date, used for sorting. null if unknown."
    )
    date_text: str = Field(
        description="The date as stated, e.g. 'last week', 'Feb 2024'."
    )
    title: str = Field(description="What happened, one clear sentence.")
    detail: str | None = Field(
        None, description="Short context — only when it adds meaning."
    )
    category: Category = Category.other
    parties: list[str] = Field(default_factory=list)
    amount: Money | None = Field(None, description="Only when money is involved.")
    source: str = Field(description="Source filename, or 'Conversation'.")
    disputed: bool = Field(
        False, description="True when the fact is contested between parties."
    )
    is_deadline: bool = Field(
        False, description="True for a future deadline / date not to miss."
    )


class Deadline(BaseModel):
    date: dt.date | None = None
    date_text: str
    label: str


class ObligationStatus(str, Enum):
    """Whether a time-limited action was done in time."""

    met = "met"  # evidence shows it was done within the window
    missed = "missed"  # not done, or the window clearly passed with no action
    pending = "pending"  # window still open
    unknown = "unknown"


class Obligation(BaseModel):
    """A time-limited action: "do X within N days of an anchor date".

    Models a *relative* legal deadline (e.g. "protect the deposit within 30 days
    of receipt"). The model supplies the anchor and the window; the absolute
    `due_date` is computed in code (`compute_due`) rather than guessed, so the
    arithmetic is always correct.
    """

    action: str = Field(description="What must be done, as a short headline.")
    anchor_date: dt.date | None = Field(
        None, description="ISO date the clock starts from (the anchoring event)."
    )
    anchor_text: str = Field(
        description="The anchoring event in words, e.g. 'deposit received'."
    )
    window_days: int = Field(description="Number of days allowed after the anchor.")
    due_date: dt.date | None = Field(
        None, description="Computed deadline — leave null; filled in code."
    )
    due_text: str = Field(
        default="", description="Human label for the due date — filled in code."
    )
    basis: str | None = Field(
        None, description="Legal basis, e.g. 'Housing Act 2004 s.213' or a clause."
    )
    status: ObligationStatus = ObligationStatus.unknown

    def compute_due(self) -> "Obligation":
        """Derive the absolute due date and its label from anchor + window."""
        if self.anchor_date is not None and self.window_days:
            self.due_date = self.anchor_date + dt.timedelta(days=self.window_days)
            self.due_text = f"{self.due_date.day} {self.due_date:%B %Y}"
        return self


class CaseFile(BaseModel):
    """The full snapshot: synthesis header + chronological events."""

    matter_type: str = Field(description="Type of dispute, in a few words.")
    summary: str = Field(description="2-3 neutral sentences about the case.")
    case_assessment: str = Field(
        default="",
        description="Plain-English assessment of the case for the client, "
        "grounded in the documents — a few paragraphs separated by blank lines.",
    )
    parties: list[Party] = Field(default_factory=list)
    amount_in_dispute: Money | None = None
    next_deadline: Deadline | None = None
    events: list[Event] = Field(default_factory=list)
    obligations: list[Obligation] = Field(
        default_factory=list,
        description="Time-limited actions ('do X within N days of a date').",
    )

    def sorted(self) -> "CaseFile":
        """Order events oldest-first; undated events fall to the end.

        Also derives each obligation's absolute due date from its anchor and
        window, so the arithmetic is computed rather than guessed.
        """
        self.events.sort(key=lambda e: e.date or dt.date.max)
        for o in self.obligations:
            o.compute_due()
        return self
