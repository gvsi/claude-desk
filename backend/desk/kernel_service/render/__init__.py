"""Visitor-visible text the kernel writes itself, in English and Spanish.

Status lines (`status`) are fixed templates, one per decision state plus the reply receipts;
they name the business's owner and nothing else, so they never carry an amount, a date or a
limit. A session reads them in its `last_language`, else English (`language`). Owner alert
previews (`owner_preview`) are English and owner-only.
"""

from typing import Literal

from desk.kernel_service.render import en, es

Language = Literal["en", "es"]
LANGUAGES: dict[str, dict[str, str]] = {"en": en.STATUS, "es": es.STATUS}
STATUS_KEYS = frozenset(en.STATUS)

if any(set(templates) != STATUS_KEYS for templates in LANGUAGES.values()):
    raise RuntimeError("every language has a template for every status line")


def language(last_language: str | None) -> Language:
    """The language a session reads status lines in: its last language when the kernel has
    templates for it, else English."""
    return "es" if last_language == "es" else "en"


def status(key: str, lang: str, *, owner: str) -> str:
    """The status line `key` ("allowed", "held", ...) in `lang`, naming `owner`. An unknown key or
    language raises KeyError: there is no free-text fallback."""
    return LANGUAGES[lang][key].format(owner=owner)


def owner_preview(kind: str) -> str:
    """The preview line of an owner alert of `kind` ("approval", "breaker", "booking")."""
    return en.OWNER_PREVIEWS[kind]
