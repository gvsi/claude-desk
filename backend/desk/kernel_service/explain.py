"""Proof failures in the owner's words.

A check that fails carries the first request it found (`counterexample_raw`, a request_json, as
`desk-prove` and the bounded check report it). The owner reads it as one sentence: who could do
what, and why that is wrong ("Dana could get a $500 refund without asking you.").

A sentence holds only fixed phrases, amounts the kernel formats, and the display names of the
Desk's own people. A counterexample the kernel can't read gets a fixed sentence instead, never
any text from the request. The same phrases tell the owner what a decision or a setup probe was
asked for (`asked`).
"""

from collections.abc import Mapping
from typing import Any

from desk.contracts import AUTO_MONEY_HARD_CAP_CENTS, BusinessToolDef, ProofReport, is_business_tool

# What each tool lets someone do: the phrase alone, and with the request's amount where the
# action has one.
PHRASES: dict[str, tuple[str, str | None]] = {
    "native.quote": ("get a quote", "get a quote for {amount}"),
    "native.find_slots": ("see open times", None),
    "native.book": ("book a visit", None),
    "native.release_document": ("receive a private document", None),
    "native.payment_link": ("get a payment link", "get a payment link for {amount}"),
    "native.charge_mandate": ("be charged", "be charged {amount}"),
    "native.capture_lead": ("leave their details", None),
    "native.request_callback": ("ask for a callback", None),
    "native.start_verification": ("get a verification code sent", None),
    "payments.list_charges": ("see payment history", None),
    "payments.create_refund": ("get a refund", "get a {amount} refund"),
    "native.fetch_website": ("read a website", None),
    "native.read_memory": ("read your memory", None),
    "native.web_search": ("search the web", None),
}

BUSINESS_PHRASES: dict[str, tuple[str, str | None]] = {
    "intake": ("leave their details through {title}", None),
    "typed_booking": ("book {title}", None),
    "purpose_payment": ("pay for {title}", "pay {amount} for {title}"),
    "urgent": ("report something urgent through {title}", None),
}

# Why what the counterexample does is wrong, by the check that found it.
WITHOUT_ASKING = " without asking you."
TAILS: dict[str, str] = {
    "auto_within_cards": WITHOUT_ASKING,
    "baseline_auto": WITHOUT_ASKING,
    "money_needs_card": WITHOUT_ASKING,
    "review_only_narrows": " without asking you, just because the reviewer's scores were high.",
    "hold_within_cards": " with your approval, even though your rules say never.",
    "baseline_approvable": " with your approval, even though your rules say never.",
}
# Checks whose failure has no request to show: the whole sentence.
CANT_CHECK = "Your rules couldn't be checked, so nothing changed."
SENTENCES: dict[str, str] = {
    "never_errors": "One of your rules could fail to apply, so these rules weren't turned on.",
    "lint": CANT_CHECK,                  # the compiled rules aren't in a shape the kernel runs
    "prover": CANT_CHECK,                # the prover's answer couldn't be trusted
}
UNREADABLE = "Your rules allow something they shouldn't, so they weren't turned on."


def explain_report(report: ProofReport, people: Mapping[str, str]) -> ProofReport:
    """`report` with every failing check's `counterexample_plain` written here, in the owner's
    words, whatever the report carried. A timed-out report is returned as it is: it found nothing,
    and the owner is told the rules can't be checked right now."""
    if report.timed_out:
        return report
    checks = [check if check.ok else check.model_copy(update={
        "counterexample_plain": explain_counterexample(check.name, check.counterexample_raw, people)})
        for check in report.checks]
    return report.model_copy(update={"checks": checks})


def explain_counterexample(check: str, raw: Any, people: Mapping[str, str]) -> str:
    """The failed `check` in the owner's words: subject + " could " + phrase + tail. `raw` is
    the check's counterexample and `people` maps the Desk's person IDs to display names. A check
    with nothing to show has a sentence of its own; a counterexample (or a check) the kernel can't
    read gets `UNREADABLE`. Never raises."""
    if check in SENTENCES:
        return SENTENCES[check]
    tail = TAILS.get(check)
    try:
        said = _said(raw, people) if tail is not None else None
    except (KeyError, TypeError, ValueError, AttributeError, IndexError):
        said = None
    return UNREADABLE if said is None else said + tail


def _said(raw: Any, people: Mapping[str, str]) -> str | None:
    """"<subject> could <phrase>" for a request_json, or None when it can't be read."""
    if not isinstance(raw, Mapping) or not isinstance(raw.get("context"), Mapping):
        return None
    action = raw.get("action")
    phrases = PHRASES.get(action) if isinstance(action, str) else None
    subject = _subject(raw.get("principal"), raw.get("entities"), people)
    if phrases is None or subject is None:
        return None
    plain, with_amount = phrases
    amount = raw["context"].get("amount_cents")
    phrase = with_amount.format(amount=money(amount)) if with_amount and _is_amount(amount) else plain
    return f"{subject} could {phrase}"


def _subject(principal: Any, entities: Any, people: Mapping[str, str]) -> str | None:
    """Who the request comes from: a visiting agent, the owner's own setup, a stranger, a person
    the Desk knows by name, or a verified customer it doesn't; None when that can't be read."""
    if not isinstance(principal, Mapping) or not isinstance(entities, list):
        return None
    match principal.get("type"):
        case "Agent":
            return "A visiting agent"
        case "Owner":
            return "Setup"
        case "Visitor":
            pass
        case _:
            return None
    attrs = next((e.get("attrs") for e in entities if isinstance(e, Mapping) and e.get("uid") == principal), None)
    if not isinstance(attrs, Mapping) or not isinstance(attrs.get("verified"), bool):
        return None
    if not attrs["verified"]:
        return "A stranger"
    person_id = attrs.get("person_id")
    name = people.get(person_id) if isinstance(person_id, str) else None
    return name or "A verified customer"


def _is_amount(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def money(cents: int) -> str:
    """`$500`, or `$12.50`, with thousands separators."""
    dollars, rest = divmod(cents, 100)
    return f"${dollars:,}" + (f".{rest:02d}" if rest else "")


def percent(bp: int) -> str:
    """`50%`, or `12.5%`, from basis points."""
    return f"{bp // 100}%" if bp % 100 == 0 else f"{bp / 100:g}%"


def asked(subject: str, verb: str, tool: str, amount_cents: int | None, discount_bp: int | None, *,
          business: BusinessToolDef | None = None) -> str:
    """"<subject> <verb> to <what>." in the owner's words, `verb` being "asked" for a decision and
    "asks" for a setup probe: what the tool lets someone do, with the amount the kernel worked out
    where the tool has one (shown only from $0 to `AUTO_MONEY_HARD_CAP_CENTS`) and the discount
    asked for. Business definitions come from this Desk's resolved adapter, never call args.
    Their titles stay quoted data. A name that is no tool is never repeated."""
    from desk.kernel_service.adapters.base import quoted

    phrases = (BUSINESS_PHRASES.get(business.config.block) if is_business_tool(tool) and business is not None
               else PHRASES.get(tool))
    if phrases is None:
        return f"{subject} {verb} for something this Desk can't do."
    plain, with_amount = phrases
    fields = {"title": quoted(business.title)} if business is not None else {}
    if with_amount is not None and amount_cents is not None and 0 <= amount_cents <= AUTO_MONEY_HARD_CAP_CENTS:
        what = with_amount.format(amount=money(amount_cents), **fields)
    else:
        what = plain.format(**fields)
    if discount_bp:
        what += f" with {percent(discount_bp)} off"
    return f"{subject} {verb} to {what}."
