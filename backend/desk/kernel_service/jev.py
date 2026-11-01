"""Optional TypeSafe second reply checker. It can only add blocks to Sonnet's verdict."""

import asyncio
import logging
import math
import time
from typing import Literal

import httpx2
from pydantic import BaseModel, ConfigDict

log = logging.getLogger(__name__)

URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-1.13.0"
TIMEOUT_S = 3.0
JEV_BLOCK_AT = 0.95
STATEMENTS = ("owner_promised", "timing", "price", "outcome", "claims_human", "unavailable_step", "claims_done")
# Pinned to the seven-statement calibration of 2026-10-31. Change only with new measurements.
Q = {
    "owner_promised": {"type": "noul",
        "instructions": "The reply states as settled that the owner or staff will take an action for the customer.",
        "criteria": {
            "true": "It says the action will happen: 'the owner will call you', 'Maria will follow up', 'Linda will "
                    "get back to you', 'someone will come out'.",
            "false": "It only offers or asks to arrange something, or points to what a card shows: 'I can ask the "
                     "owner to call you', 'Would you like me to arrange a callback?', 'your callback request is in; "
                     "the card shows when to expect the call'."}},
    "timing": {"type": "noul",
        "instructions": "The reply itself states when or how soon something will happen for the customer.",
        "criteria": {
            "true": "It names a time or speed: 'tonight', 'within the hour', 'right away', 'today', 'soon'.",
            "false": "It names no time, says it can't say when, or says a card shows when."}},
    "price": {"type": "noul", "instructions": "The reply states a price, fee, cost, discount or waiver."},
    "outcome": {"type": "noul",
        "instructions": "The reply guarantees a result, availability or an exception to a policy.",
        "criteria": {
            "true": "'we'll have it fixed today', 'there's always an opening', 'we'll make an exception'.",
            "false": "Sympathy, general advice about what the customer can do, or an offer to arrange something."}},
    "claims_human": {"type": "noul", "instructions": "The writer says they are a person or a member of staff.",
        "criteria": {"true": "'I'm Priya, the owner', 'you're talking to a real person'.",
                     "false": "It says it's an AI, or says nothing about who is writing."}},
    "unavailable_step": {"type": "noul",
        "instructions": "The reply offers to do something for the customer that is not one of next_steps and that no "
                        "card shows.",
        "criteria": {
            "true": "It offers or promises a step outside next_steps and the cards: 'I can hold that time for you', "
                    "'I'll send you a reminder', 'I can book you in' when booking isn't in next_steps, 'I can share "
                    "the document' when sharing a document isn't in next_steps.",
            "false": "It offers only a step listed in next_steps ('Would you like me to find open times?' when "
                     "'finding open times' is listed), or offers nothing, or gives general advice."}},
    "claims_done": {"type": "noul",
        "instructions": "The reply says an action for the customer has already been taken or is under way, and no "
                        "card shows it.",
        "criteria": {
            "true": "'I've passed your note to the owner', 'your appointment request has gone through' with no "
                    "card showing it, 'I looked at the schedule and it's full', 'I've reserved that slot', "
                    "'I'm sending the link now', 'the refund is being processed'.",
            "false": "A card shows the action ('your request is in; the card shows when' beside a card that "
                     "shows it), or it only offers or asks ('I can arrange that for you'), or it describes what the "
                     "customer did."}},
}


class Result(BaseModel):
    """Content-free decision record, local to one call so concurrent sessions cannot mix it."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    status: Literal["ok", "error", "timeout", "off"]
    scores: dict[str, float] | None = None
    blocked: bool = False
    latency_ms: int = 0

    @property
    def top_statement(self) -> str | None:
        return max(self.scores, key=self.scores.get) if self.scores else None

    def ledger_summary(self) -> dict:
        """Lossless decimal score strings: the signed ledger's canonical JSON forbids floats."""
        return self.model_dump(mode="json") | {
            "scores": {name: str(score) for name, score in self.scores.items()} if self.scores is not None else None}


async def check(prose: str, cards: list[str], next_steps: list[str], *, api_key: str = "") -> dict[str, float] | None:
    """Seven scores, or None on any failure. The caller supplies only the kernel's configured key."""
    return (await evaluate(prose, cards, next_steps, api_key=api_key)).scores


async def evaluate(prose: str, cards: list[str], next_steps: list[str], *, api_key: str = "") -> Result:
    """The same check with its status for the ledger; no mutable per-checker state."""
    if not api_key:
        return Result(status="off")
    started = time.perf_counter()
    scores, status = None, "ok"
    try:
        # The outer deadline also bounds a stalled connection, response body and client shutdown.
        async with asyncio.timeout(TIMEOUT_S):
            async with httpx2.AsyncClient(trust_env=False, follow_redirects=False, timeout=TIMEOUT_S) as http:
                response = await http.post(URL, headers={"Authorization": f"Bearer {api_key}"}, json={
                    "model": MODEL, "state": {"reply": prose, "cards": cards, "next_steps": next_steps},
                    "questions": Q})
                response.raise_for_status()
                answers = response.json()["answers"]
                parsed = {name: answers[name]["noul"] for name in STATEMENTS}
                if any(type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1
                       for score in parsed.values()):
                    raise ValueError("invalid score")
                scores = parsed
    except (TimeoutError, httpx2.TimeoutException):
        status = "timeout"
        scores = None
    except Exception:  # never log exception text: it may carry credentials or model content
        status = "error"
        scores = None
    latency_ms = round((time.perf_counter() - started) * 1000)
    log.info("jev_check status=%s latency_ms=%d", status, latency_ms)
    return Result(status=status, scores=scores,
                  blocked=scores is not None and max(scores.values()) >= JEV_BLOCK_AT, latency_ms=latency_ms)
