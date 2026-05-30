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


class CaseFile(BaseModel):
    """The full snapshot: synthesis header + chronological events."""

    matter_type: str = Field(description="Type of dispute, in a few words.")
    summary: str = Field(description="2-3 neutral sentences about the case.")
    parties: list[Party] = Field(default_factory=list)
    amount_in_dispute: Money | None = None
    next_deadline: Deadline | None = None
    events: list[Event] = Field(default_factory=list)

    def sorted(self) -> "CaseFile":
        """Order events oldest-first; undated events fall to the end."""
        self.events.sort(key=lambda e: e.date or dt.date.max)
        return self
