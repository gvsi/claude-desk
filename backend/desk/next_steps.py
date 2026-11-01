"""Fixed offers shared by the kernel and API, projected only from resolved session tools.

Descriptions and tool arguments are untrusted; neither can supply an exemption phrase.
"""

from collections.abc import Iterable
from typing import Protocol


NEXT_STEPS: dict[str, str] = {
    "native.find_slots": "finding open times",
    "native.book": "booking a time a card shows",
    "native.quote": "giving a quote",
    "native.payment_link": "sending a payment link for a quote a card shows",
    "native.start_verification": "checking who the visitor is with the contact on record",
    "native.release_document": "sharing a document with the verified person it belongs to",
    "payments.list_charges": "showing a verified person their own charges",
    "payments.create_refund": "requesting a refund of the verified person's own payment",
    "native.capture_lead": "taking a message",
    "native.request_callback": "arranging a call back",
}

# Purpose payments gain an offer only when their adapter and calibration land.
BUSINESS_BLOCK_STEPS: dict[str, str] = {
    "typed_booking": "booking a time a card shows",
    "intake": "taking a message",
    "urgent": "arranging a call back",
}


class NamedTool(Protocol):
    tool: str


def next_steps(tools: Iterable[NamedTool]) -> list[str]:
    """Tool-name order, with nothing visitor-written and unknown tools omitted. A step two tools
    offer (an urgent block beside the native call-back) is listed once, where it first comes."""
    steps = []
    for profile in sorted(tools, key=lambda profile: profile.tool):
        phrase = NEXT_STEPS.get(profile.tool)
        if profile.tool.startswith("desk."):
            business = getattr(profile, "business", None)
            config = getattr(business, "config", None)
            phrase = BUSINESS_BLOCK_STEPS.get(getattr(config, "block", None))
        if phrase is not None and phrase not in steps:
            steps.append(phrase)
    return steps
