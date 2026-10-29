"""Visitor-visible text the kernel writes itself, in English and Spanish.

Status lines (`status`) are fixed templates, one per decision state plus the reply receipts;
they name the business's owner and nothing else, so they never carry an amount, a date or a
limit. `status` also serves the kernel's other visitor texts (`MESSAGES`): the verify card's
messages and the Demo inbox's code entry, the one text that carries a code. A session reads them
in its `last_language`, else English (`language`). Owner alert previews (`owner_preview`) are
English and owner-only.

Clause cards (`render_clause`) are the only visitor text that carries amounts and dates, and
they are rendered by code from a fact, never from text a model wrote. Each template is registered
once (`register_template`) with the fact kinds it renders, the fact ID (or ID prefix) it reads,
the fact statuses that count as current, and a renderer per language that returns the card's
headline (`title`) and details (`lines`), plus a choice per open time on a booking options card.
A card's `text` is the headline and then the details, one per line. A template that names no fact
kinds (handoff, verify_prompt) renders without one. `Template.current` says whether a fact may
still be shown (a status the template renders, not expired), and a fact with nothing to render,
such as hours with no windows, raises `NothingToShow` rather than make an empty card.
"""

from collections.abc import Callable, Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from desk.contracts import CardOption, Clause, ClauseTemplate, Fact, RenderedBlock
from desk.kernel_service.render import en, es
from desk.kernel_service.render.cards import Card, DeskInfo, NothingToShow

Language = Literal["en", "es"]
LANGUAGES: dict[str, dict[str, str]] = {"en": en.STATUS, "es": es.STATUS}
STATUS_KEYS = frozenset(en.STATUS)
MESSAGES: dict[str, dict[str, str]] = {"en": en.MESSAGES, "es": es.MESSAGES}
MESSAGE_KEYS = frozenset(en.MESSAGES)

if any(set(templates) != STATUS_KEYS for templates in LANGUAGES.values()):
    raise RuntimeError("every language has a template for every status line")
if any(set(templates) != MESSAGE_KEYS for templates in MESSAGES.values()) or MESSAGE_KEYS & STATUS_KEYS:
    raise RuntimeError("every language has every message, and no message shares a status line's key")


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


def owner_preview(kind: str) -> str:
    """The preview line of an owner alert of `kind` ("approval", "breaker", "booking")."""
    return en.OWNER_PREVIEWS[kind]


# ---- Clause cards ---------------------------------------------------------------------------------

Renderer = Callable[[Fact | None, DeskInfo], Card]


@dataclass(frozen=True)
class Template:
    name: ClauseTemplate
    fact_kinds: frozenset[str]            # empty: the clause names no fact
    key: str | None                       # the fact ID it reads, or the ID's prefix when it ends in ":"
    statuses: frozenset[str]              # the fact statuses it renders as current
    renderers: dict[str, Renderer]        # by language

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
                      statuses: Collection[str] = ("available",)) -> Template:
    """Registers how the clause `template` renders, once per template."""
    if template in TEMPLATES:
        raise ValueError(f"the {template} template is already registered")
    registered = Template(name=template, fact_kinds=frozenset(fact_kinds), key=key, statuses=frozenset(statuses),
                          renderers={"en": renderer_en, "es": renderer_es})
    TEMPLATES[template] = registered
    return registered


def render_clause(clause: Clause, fact: Fact | None, lang: Language, desk: DeskInfo) -> RenderedBlock:
    """The card for `clause`, rendered from `fact` (None for a template that names no fact) in
    `lang`. The caller has checked that the template is registered and reads this fact. A fact
    with nothing to render raises `NothingToShow`; one that lacks a claim its template needs
    raises any other error, which the caller answers as an internal error."""
    card = TEMPLATES[clause.template].renderers[lang](fact, desk)
    return RenderedBlock(kind="card", template=clause.template, text="\n".join([card.title, *card.lines]),
                         fact_id=clause.fact_id, title=card.title, lines=list(card.lines), href=card.href,
                         options=[CardOption(option_id=option_id, label=label) for option_id, label in card.options])


register_template("quote", {"quote"}, en.quote, es.quote, key="quote:")
register_template("booking_options", {"slots"}, en.booking_options, es.booking_options, key="slots:")
register_template("booking_confirmed", {"booking"}, en.booking_confirmed, es.booking_confirmed, key="booking:",
                  statuses=("committed",))
register_template("hours", {"charter"}, en.hours, es.hours, key="charter:hours")
register_template("policy", {"charter"}, en.charter_text, es.charter_text, key="charter:policy:")
register_template("contact", {"charter"}, en.charter_text, es.charter_text, key="charter:contact")
register_template("handoff", (), en.handoff, es.handoff)
register_template("verify_prompt", (), en.verify_prompt, es.verify_prompt)
