"""Visitor-visible text the kernel writes itself, in English and Spanish.

Status lines (`status`) are fixed templates, one per decision state plus the reply receipts
(an owner's say has its own two: written by the owner, or not sent, which only the owner sees)
and two variants: `tool_unavailable`, the line a `refused_at_execution` takes when a connected
tool's server can't be reached, and `refused_over_mandate`, the line a refusal takes when the
baseline's mandate rule alone refused an agent's charge above what its mandate has left; a
decision's status line is never a receipt (`DECISION_STATUS_KEYS`); they name the business's
owner and nothing else, so they never carry an amount, a date or a limit's value. An action a
visitor or agent asked for that ran says what was done, one line per tool
(`executed_status`), in place of the generic executed line, which only the owner's own setup
actions keep. `status` also serves the kernel's other visitor texts (`MESSAGES`): the verify card's
messages, the Demo inbox's code entry, the one text that carries a code, and the call-back offer a
reply blocked only for its prose shows in place of the handoff card. A session reads them
in its `last_language`, else English (`language`): the language of the visitor's latest message,
recorded at turn start (`turn`), or of Claude's last reply (`reply_check.finalize`). Owner alert
previews (`owner_preview`) are English and owner-only. The owner-only lines (`OWNER_STATUS`: why an
action was refused at execution, a decision's `owner_plain`) sit apart from the status lines, so
`status` can't render one into any visitor text; `owner_line` renders them in the owner's language
(`OWNER_LANGUAGE`).

Clause cards (`render_clause`) are the only visitor text that carries amounts and dates, and
they are rendered by code from a fact, never from text a model wrote; the `owner_said` card holds
the owner's own words, and only the kernel issues it, as it does `payment_confirmed` (a completed
payment link) and `link_cancelled` (a link a rule change cancelled, its amount and what it was for
read from that link's own `payment_link` fact, then the kernel's line). Each template is registered
once (`register_template`) with the fact kinds it renders, the fact ID (or ID prefix) it reads, the
fact statuses that count as current, and a renderer per language that returns the card's headline
(`title`) and details (`lines`), plus a choice per open time on a booking options card.
A card's `text` is the headline and then the details, one per line; the soft checks read it after
its kind's fixed label (`CHECK_LABELS`, `check_text`). A template that names no fact
kinds (handoff, verify_prompt) renders without one. `Template.current` says
whether a fact may still be shown (a status the template renders, not expired), and a fact with
nothing to render, such as hours with no windows, raises `NothingToShow` rather than make an empty
card.

A card that links somewhere (a document or payment link) registers `href_for`, which the reply
check awaits once the cited fact has passed its checks, and passes to `render_clause` as the card's
`href`: the link's path, looked up from the fact by the kernel, so the link's token is in no fact,
and the `href` is the only field of the card that carries it.
"""

from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from datetime import datetime, tzinfo
from typing import TYPE_CHECKING, Literal

from desk.contracts import CardOption, Clause, ClauseTemplate, Fact, RenderedBlock
from desk.kernel_service.render import en, es
from desk.kernel_service.render.cards import Card, DeskInfo, NothingToShow

if TYPE_CHECKING:
    from desk.kernel_service.repo import KernelCtx

Language = Literal["en", "es"]
LANGUAGES: dict[str, dict[str, str]] = {"en": en.STATUS, "es": es.STATUS}
STATUS_KEYS = frozenset(en.STATUS)
# The receipts `reply_check` gives a checked reply (`reply_checked`, `reply_handed_off`) and an owner's
# say (`owner_said`, and `owner_say_blocked`, which only the owner sees, since that say was never sent).
RECEIPT_KEYS = frozenset({"reply_checked", "reply_handed_off", "owner_said", "owner_say_blocked"})
# What a decision's status line, its `visitor_plain`, can be: a status line that is no receipt, so no
# owner-only line (`decide.status_line` refuses any other key).
DECISION_STATUS_KEYS = STATUS_KEYS - RECEIPT_KEYS
MESSAGES: dict[str, dict[str, str]] = {"en": en.MESSAGES, "es": es.MESSAGES}
MESSAGE_KEYS = frozenset(en.MESSAGES)
EXECUTED: dict[str, dict[str, str]] = {"en": en.EXECUTED, "es": es.EXECUTED}
# Owner-only lines (why an action was refused at execution: a decision's `owner_plain`, `owner_line`):
# outside `STATUS_KEYS`, so no decision's status line can take one.
OWNER_STATUS: dict[str, dict[str, str]] = {"en": en.OWNER_STATUS, "es": es.OWNER_STATUS}
OWNER_STATUS_KEYS = frozenset(en.OWNER_STATUS)
# The language the owner reads the owner-only lines in. The kernel keeps no owner language, so this is
# English for every owner; an owner-language source, once there is one, replaces this line. Never the
# session's language: these lines are the owner's, not the visitor's.
OWNER_LANGUAGE: Language = "en"
OPEN_STATUS: dict[str, Callable[[bool, datetime | None, datetime], str]] = {"en": en.open_status,
                                                                            "es": es.open_status}

if any(set(templates) != STATUS_KEYS for templates in LANGUAGES.values()):
    raise RuntimeError("every language has a template for every status line")
if not RECEIPT_KEYS < STATUS_KEYS:
    raise RuntimeError("every receipt is a status line, and some status line is a decision's")
if any(set(templates) != MESSAGE_KEYS for templates in MESSAGES.values()) or MESSAGE_KEYS & STATUS_KEYS:
    raise RuntimeError("every language has every message, and no message shares a status line's key")
if (any(set(lines) != OWNER_STATUS_KEYS for lines in OWNER_STATUS.values())
        or OWNER_STATUS_KEYS & (STATUS_KEYS | MESSAGE_KEYS)):
    raise RuntimeError("every language has every owner-only line, and none shares a visitor text's key")
if any(set(lines) != set(en.EXECUTED) for lines in EXECUTED.values()):
    # so a tool with a line has one in whatever language the session reads by the time it runs
    raise RuntimeError("every language has an executed line for the same tools")
if set(es.AGENT_TOOLS) != set(en.AGENT_TOOLS) or len(es.AGENT_CARD) != len(en.AGENT_CARD):
    raise RuntimeError("every language has the whole Agent Card and a label for every agent tool")


def language(last_language: str | None) -> Language:
    """The language a session reads status lines in: its last language when the kernel has
    templates for it, else English."""
    return "es" if last_language == "es" else "en"


def status(key: str, lang: str, *, owner: str | None = None, **fields: str) -> str:
    """The status line `key` ("allowed", "held", ...) in `lang`, naming `owner`, or the message
    `key` ("verify_started", "inbox_code_body", ...) filled with its `fields`. An unknown key or
    language, or a field the template names and the call doesn't give, raises KeyError: there is
    no free-text fallback."""
    template = LANGUAGES[lang][key] if key in STATUS_KEYS else MESSAGES[lang][key]
    return template.format(**fields, **({"owner": owner} if owner is not None else {}))


def executed_status(tool: str, lang: str, *, owner: str) -> str:
    """What an executed `tool` did, in `lang`, naming `owner`: the receipt a visitor or agent sees
    for an action that ran ("Quoted from Maria Rivera's price list"). A tool without a line raises
    KeyError: there is no generic fallback, so execution checks for the line before anything runs."""
    return EXECUTED[lang][tool].format(owner=owner)


def open_status_text(is_open: bool, boundary: datetime | None, as_of: datetime, lang: str, tz: tzinfo) -> str:
    """The public header's open-now line in `lang` ("Open status"), shown verbatim: `boundary` is
    when an open business closes (None: open through the week ahead) or a closed one opens, both it
    and `as_of` read in the business's time zone `tz`, with the cards' time formats."""
    local = boundary.astimezone(tz) if boundary is not None else None
    return OPEN_STATUS[lang](is_open, local, as_of.astimezone(tz))


def owner_line(key: str) -> str:
    """The owner-only line `key` ("refused_desk_deleted", ...) in `OWNER_LANGUAGE`. Any other key,
    a status line's included, raises KeyError: there is no free-text fallback."""
    return OWNER_STATUS[OWNER_LANGUAGE][key]


def agent_card(lang: str, *, business: str, owner: str, slug: str, tools: Collection[str]) -> list[RenderedBlock]:
    """The Agent Card of a Desk in `lang`: prose blocks naming who answers (an AI, Claude, within
    `owner`'s rules), what an agent can do there (the labels of `tools`, in the order the card
    lists them), the endpoint and how to sign, and that agent keys aren't business credentials.
    A tool without a label is left out rather than named; nothing carries an amount or a key. An
    empty `business` or `owner` (a name the public page withholds) reads as fixed words ("this
    business", "the owner"), never as a blank."""
    module = en if lang == "en" else es
    labels = [label for tool, label in module.AGENT_TOOLS.items() if tool in tools]
    listed = module.listing(labels) if labels else module.AGENT_CARD_NO_TOOLS
    business = business if business.strip() else module.AGENT_CARD_BUSINESS
    owner = owner if owner.strip() else module.AGENT_CARD_OWNER
    return [RenderedBlock(kind="prose", text=line.format(business=business, owner=owner, slug=slug, tools=listed))
            for line in module.AGENT_CARD]


def owner_preview(kind: str) -> str:
    """The preview line of an owner alert of `kind` ("approval", "breaker", "booking")."""
    return en.OWNER_PREVIEWS[kind]


# ---- Clause cards ---------------------------------------------------------------------------------

Renderer = Callable[[Fact | None, DeskInfo], Card]
HrefFor = Callable[["KernelCtx", Fact], Awaitable[str]]   # the card's link, from its fact


@dataclass(frozen=True)
class Template:
    name: ClauseTemplate
    fact_kinds: frozenset[str]            # empty: the clause names no fact
    key: str | None                       # the fact ID it reads, or the ID's prefix when it ends in ":"
    statuses: frozenset[str]              # the fact statuses it renders as current
    renderers: dict[str, Renderer]        # by language
    href_for: HrefFor | None = None       # a card that links: its `href`, awaited once the fact passes its checks

    def reads(self, fact: Fact) -> bool:
        """Whether the fact is of a kind and ID this template renders."""
        if fact.kind not in self.fact_kinds:
            return False
        if self.key is None:
            return True
        return fact.fact_id.startswith(self.key) if self.key.endswith(":") else fact.fact_id == self.key

    def current(self, fact: Fact, now: datetime) -> bool:
        """Whether the fact may still be shown: a status this template renders, and not expired."""
        return fact.status in self.statuses and (fact.expires_at is None or fact.expires_at > now)


TEMPLATES: dict[str, Template] = {}


def register_template(template: ClauseTemplate, fact_kinds: Collection[str], renderer_en: Renderer,
                      renderer_es: Renderer, *, key: str | None = None,
                      statuses: Collection[str] = ("available",), href_for: HrefFor | None = None) -> Template:
    """Registers how the clause `template` renders, once per template. `href_for` gives a linking
    card its `href` from its fact; it raises `NothingToShow` when the link can't be followed."""
    if template in TEMPLATES:
        raise ValueError(f"the {template} template is already registered")
    if href_for is not None and not fact_kinds:
        raise ValueError("a card links only from a fact")
    registered = Template(name=template, fact_kinds=frozenset(fact_kinds), key=key, statuses=frozenset(statuses),
                          renderers={"en": renderer_en, "es": renderer_es}, href_for=href_for)
    TEMPLATES[template] = registered
    return registered


def render_clause(clause: Clause, fact: Fact | None, lang: Language, desk: DeskInfo, *,
                  href: str | None = None) -> RenderedBlock:
    """The card for `clause`, rendered from `fact` (None for a template that names no fact) in
    `lang`, with `href` as its link (what the template's `href_for` gave). The caller has checked
    that the template is registered and reads this fact, and gives `href` exactly when the
    template links. A fact with nothing to render raises `NothingToShow`; one that lacks a claim
    its template needs raises any other error, which the caller answers as an internal error."""
    template = TEMPLATES[clause.template]
    if (href is None) != (template.href_for is None):
        raise ValueError(f"the {clause.template} card links exactly when its template has href_for")
    card = template.renderers[lang](fact, desk)
    return RenderedBlock(kind="card", template=clause.template, text="\n".join([card.title, *card.lines]),
                         fact_id=clause.fact_id, title=card.title, lines=list(card.lines), href=href,
                         options=[CardOption(option_id=option_id, label=label) for option_id, label in card.options])


register_template("quote", {"quote"}, en.quote, es.quote, key="quote:")
register_template("booking_options", {"slots"}, en.booking_options, es.booking_options, key="slots:")
register_template("booking_confirmed", {"booking"}, en.booking_confirmed, es.booking_confirmed, key="booking:",
                  statuses=("committed",))
register_template("hours", {"charter"}, en.hours, es.hours, key="charter:hours")
register_template("policy", {"charter"}, en.charter_text, es.charter_text, key="charter:policy:")
register_template("contact", {"charter"}, en.charter_text, es.charter_text, key="charter:contact")
register_template("callback_confirmed", {"handoff"}, en.callback_confirmed, es.callback_confirmed, key="handoff:",
                  statuses=("committed",))
register_template("owner_said", {"owner_statement"}, en.owner_said, es.owner_said, key="owner:")
register_template("payment_confirmed", {"charge"}, en.payment_confirmed, es.payment_confirmed, key="charge:",
                  statuses=("committed",))
register_template("charges", {"charge"}, en.charges, es.charges, key="charge:", statuses=("committed",))
register_template("refund_issued", {"refund"}, en.refund_issued, es.refund_issued, key="refund:",
                  statuses=("committed",))
register_template("charge_confirmed", {"charge"}, en.charge_confirmed, es.charge_confirmed, key="charge:",
                  statuses=("committed",))
register_template("handoff", (), en.handoff, es.handoff)
# From the link's own fact, which its cancelling has expired. Only `payments.cancelled_links` renders it;
# no status counts as current, so behind `kernel_only_template` a draft citing one is still `stale_fact`.
register_template("link_cancelled", {"payment_link"}, en.link_cancelled, es.link_cancelled, key="payment_link:",
                  statuses=())
register_template("verify_prompt", (), en.verify_prompt, es.verify_prompt)

# What kind of card each template renders, as the soft checks read it (the owner's decision of
# 2026-11-01): a card's text alone ("Service call deposit, $20.00") doesn't say it is a payment link.
# English whatever the reply's language, since the checks' prompts are English; the web app's card
# header where it names the kind, else plain words for it. Every registered template has one, the
# link templates `payment_link` and `document_link` too, which their adapters register.
CHECK_LABELS: dict[ClauseTemplate, str] = {
    "quote": "Quote",
    "booking_options": "Open times",
    "booking_confirmed": "Booking confirmed",
    "payment_link": "Payment link",
    "document_link": "Document link",
    "hours": "Hours",
    "policy": "Policy",
    "contact": "Contact",
    "handoff": "Handed to a person",
    "verify_prompt": "Verification",
    "owner_said": "Message from the owner",
    "charges": "Charges",
    "refund_issued": "Refund issued",
    "charge_confirmed": "Charge confirmed",
    "callback_confirmed": "Callback set",
    "payment_confirmed": "Payment confirmed",
    "link_cancelled": "Payment link cancelled",
}


def check_text(card: RenderedBlock) -> str:
    """A card as the soft checks (Sonnet's and Jev's) read it: its kind's label, then its text
    ("Payment link card: Service call deposit, $20.00")."""
    return f"{CHECK_LABELS[card.template]} card: {card.text}"
