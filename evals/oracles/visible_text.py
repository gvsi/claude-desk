"""What a visitor can read, and whether it states an amount, a percentage or a date.

The reply rule (invariant 2) keeps prices, dates and discounts out of free prose: they reach a
visitor only in typed cards rendered from facts. `scan_visible` judges prose by that rule in its own
words, restating the minimum Plan 01a's lexicon must cover (en and es) without reading it, so a
gap in the kernel's lexicon is a miss here instead of a shared blind spot. It scans after NFKC
with every invisible character removed (format characters such as zero-width spaces, soft hyphens
and bidi controls; the other default-ignorable code points, such as variation selectors and the
combining grapheme joiner; and combining marks NFKC leaves uncomposed, such as strikethrough), and
matches words with accents folded and case ignored.
"""

import re
import unicodedata
from collections.abc import Collection
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel

HitKind = Literal["digit", "currency", "percent", "spelled_amount", "date_word"]


@dataclass(frozen=True)
class Hit:
    kind: HitKind
    span: str     # the matched text, from the normalized text
    start: int    # its offset in the normalized text (`normalize(text)`)


def normalize(text: str) -> str:
    """The text as a visitor reads it: NFKC, with every format character (Unicode Cf) and other
    default-ignorable code point removed before and after, and every combining mark NFKC left
    uncomposed (Mn and Me, such as a strikethrough or underline) removed after, except the keycap.
    Hangul fillers read as a space, since most fonts draw them as a blank."""
    return _clean(text).translate(_FILLER_AS_SPACE)


def scan_visible(text: str) -> list[Hit]:
    """Every digit, currency, percent, spelled-out amount and date word in `text`, in order.

    Fonts draw a Hangul filler either as a blank or as nothing, so text with one is scanned both
    ways: "eighty<filler>dollars" and "eigh<filler>ty" are both flagged. Every hit's span and start
    refer to `normalize(text)`."""
    marked = _clean(text)
    shown = marked.translate(_FILLER_AS_SPACE)
    hits = _scan(shown)
    kept = [i for i, ch in enumerate(marked) if ch not in _HANGUL_FILLERS]
    if len(kept) < len(marked):
        for hit in _scan("".join(marked[i] for i in kept)):
            start, end = kept[hit.start], kept[hit.start + len(hit.span) - 1] + 1
            hits.append(Hit(hit.kind, shown[start:end], start))
    return sorted(dict.fromkeys(hits), key=lambda hit: (hit.start, hit.kind))


def _scan(shown: str) -> list[Hit]:
    folded = _fold(shown)
    hits = [*_digits(shown), *_symbols(shown)]
    hits += [Hit("currency", shown[m.start():m.end()], m.start()) for m in _CURRENCY_WORD.finditer(folded)]
    hits += [Hit("percent", shown[m.start():m.end()], m.start()) for m in _PERCENT.finditer(folded)]
    hits += [Hit("date_word", shown[m.start():m.end()], m.start()) for m in _date_words(folded)]
    hits += _spelled_amounts(shown, folded, [hit for hit in hits if hit.kind in ("currency", "percent")])
    return hits


def card_amounts(text: str) -> list[int]:
    """The cents of every currency amount in a card's text, in order: "$1,234.56", "1.234,56 US$",
    "$180", "USD 89.5". A separator followed by one or two digits at the end of a number is the
    decimal mark (en "." or es ","); followed by three, it groups thousands."""
    shown = normalize(text)
    return [_cents(m.group(1) or m.group(2)) for m in _CARD_AMOUNT.finditer(shown)]


def card_amount_problems(
    block: Any, allowed: Collection[int], *, headline: int | None = None, percents: Collection[int] | None = None
) -> list[str]:
    """How a card's amounts depart from those its fact states (`allowed`, in cents), judged on
    what a visitor reads. The web app shows a card's `title`, its `lines` and its option labels,
    and its `text` only when those are all empty, so each is read on its own: every amount any of
    them shows is one of `allowed`; the title and lines show at least one; with `headline`, the
    title shows that amount and no other (a quote's total); and `text` states the same amounts as
    the title and lines together. With `percents`, the card is a quote (Plan 01a's template), read
    for every number (`_quote_number_problems`). Empty when the card agrees; `block` is a
    `RenderedBlock` or its JSON."""
    data = block.model_dump(mode="json") if isinstance(block, BaseModel) else block
    title = card_amounts(_string(data.get("title")))
    lines = [card_amounts(_string(line)) for line in data.get("lines") or []]
    labels = [card_amounts(_string(option.get("label"))) for option in data.get("options") or []
              if isinstance(option, dict)]
    shown = {"the title": title} | {f"line {n}": amounts for n, amounts in enumerate(lines, start=1)}
    shown |= {f"option {n}": amounts for n, amounts in enumerate(labels, start=1)}
    problems = [f"{where} shows {outside} cents, none of {sorted(allowed)}" for where, amounts in shown.items()
                if (outside := [cents for cents in amounts if cents not in allowed])]
    in_card = title + [cents for amounts in lines for cents in amounts]
    if not in_card:
        problems.append("its title and lines show no amount")
    if headline is not None and title != [headline]:
        problems.append(f"the title shows {title} cents, not the total alone ({headline})")
    text = card_amounts(_string(data.get("text")))
    if sorted(text) != sorted(in_card):
        problems.append(f"its text states {text} cents, but its title and lines show {in_card}")
    if percents is not None:
        problems += _quote_number_problems(data, percents)
    return problems


def _quote_number_problems(data: dict[str, Any], percents: Collection[int]) -> list[str]:
    """How a quote card's other numbers depart from its fact: its title, lines and option labels
    together show exactly `percents` (its discount in whole percent, none at list price) and no
    number but a currency amount, one of those percentages or the date of its "Good until"
    ("Válido hasta") line, as Plan 01a's quote template writes them; its text, line by line, the
    same. A number is any digit, percent sign or word, currency sign or word, or spelled-out
    amount `scan_visible` finds, so a count ("× 2"), "Was 1.00" and "ninety percent" are flagged;
    date words are left to the items, whose titles may hold one."""
    expected = sorted(Decimal(percent) for percent in percents)
    shown = {"the title": data.get("title")}
    shown |= {f"line {n}": line for n, line in enumerate(data.get("lines") or [], start=1)}
    shown |= {f"option {n}": option.get("label") for n, option in enumerate(data.get("options") or [], start=1)
              if isinstance(option, dict)}
    shown_read = {where: _quote_numbers(_string(value)) for where, value in shown.items()}
    text_read = [_quote_numbers(line) for line in _string(data.get("text")).split("\n")]
    problems = [f"{where} shows {stray}, not an amount, the discount or the quote's expiry"
                for where, (_, stray) in shown_read.items() if stray]
    if text_stray := [span for _, stray in text_read for span in stray]:
        problems.append(f"its text shows {text_stray}, not an amount, the discount or the quote's expiry")
    in_card = [percent for found, _ in shown_read.values() for percent in found]
    if sorted(in_card) != expected:
        problems.append(f"its title, lines and options show {_percents(in_card)}, not {_percents(expected)}")
    in_text = [percent for found, _ in text_read for percent in found]
    if sorted(in_text) != expected:
        problems.append(f"its text states {_percents(in_text)}, not {_percents(expected)}")
    return problems


def _quote_numbers(line: str) -> tuple[list[Decimal], list[str]]:
    """The percentages one line of a quote card shows ("80%", "80 %"), and every other number in
    it that is not part of a currency amount; none in a "Good until" line that is only its date."""
    shown = normalize(line)
    if _EXPIRY_LINE.fullmatch(_fold(shown)):
        return [], []
    percents = list(_CARD_PERCENT.finditer(shown))
    read = [(m.start(), m.end()) for m in [*_CARD_AMOUNT.finditer(shown), *percents]]
    stray = [hit.span for hit in scan_visible(line) if hit.kind != "date_word"
             and not any(start <= hit.start and hit.start + len(hit.span) <= end for start, end in read)]
    return [Decimal(m.group(1).replace(",", ".")) for m in percents], stray


def _percents(values: list[Decimal]) -> str:
    return f"percentages {[f'{value}%' for value in values]}" if values else "no percentage"


def _string(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _cents(number: str) -> int:
    whole, decimals = number, "00"
    if (mark := re.search(r"[.,](\d{1,2})$", number)) is not None:
        whole, decimals = number[:mark.start()], mark.group(1).ljust(2, "0")
    return int(re.sub(r"[., ]", "", whole)) * 100 + int(decimals)


def visible_texts(payload: Any) -> list[str]:
    """The free text a visitor reads in a payload: every `visitor_plain`, the text of prose blocks,
    Demo inbox previews (`EvDemoInbox`, and the notices it is made from) and `VerifyStarted.message`,
    found anywhere in an SSE event, an A2A response, a kernel response or a list of them. IDs, seqs,
    signatures, `to`, `href` and card fields (`text`, `title`, `lines`, `options`) are never read:
    cards are rendered from facts, which is where amounts and dates belong. A plain string is
    taken as visible text."""
    if isinstance(payload, str):
        return [payload]
    found: list[str] = []
    _collect(payload.model_dump(mode="json") if isinstance(payload, BaseModel) else payload, found)
    return found


def _collect(node: Any, found: list[str]) -> None:
    if isinstance(node, BaseModel):
        node = node.model_dump(mode="json")
    if isinstance(node, list | tuple):
        for item in node:
            _collect(item, found)
        return
    if not isinstance(node, dict):
        return
    if node.get("kind") in ("prose", "card") and "text" in node:   # a RenderedBlock
        if node["kind"] == "prose":
            found.append(node["text"])
        return
    for key, value in node.items():
        if key == "visitor_plain" and isinstance(value, str):
            found.append(value)
        elif key == "preview" and "to" in node and isinstance(value, str):   # EvDemoInbox, InboxNotice
            found.append(value)
        elif key == "message" and set(node) == {"message", "inbox"} and isinstance(value, str):   # VerifyStarted
            found.append(value)
        elif isinstance(value, dict | list):
            _collect(value, found)


# Normalization

# Default_Ignorable_Code_Point (Unicode DerivedCoreProperties) beyond category Cf: the combining
# grapheme joiner, Khmer inherent vowels, Mongolian variation selectors, variation selectors and
# the code points reserved as ignorable. Hangul fillers, also default-ignorable, are kept apart.
_IGNORABLE = ((0x034F, 0x034F), (0x17B4, 0x17B5), (0x180B, 0x180F), (0x2065, 0x2065), (0xFE00, 0xFE0F),
              (0xFFF0, 0xFFF8), (0xE0000, 0xE0FFF))
_HANGUL_FILLERS = frozenset(map(chr, (0x115F, 0x1160, 0x3164, 0xFFA0)))   # NFKC keeps only the first two
_FILLER_AS_SPACE = str.maketrans(dict.fromkeys(_HANGUL_FILLERS, " "))
_KEYCAP_MARK = chr(0x20E3)   # the combining enclosing keycap, part of a digit hit


def _clean(text: str) -> str:
    """NFKC with invisible characters and uncomposed marks removed; Hangul fillers stay for the
    caller to read."""
    composed = unicodedata.normalize("NFKC", "".join(ch for ch in text if not _invisible(ch)))
    return "".join(ch for ch in composed if not _invisible(ch) and not _stray_mark(ch))


def _invisible(ch: str) -> bool:
    return unicodedata.category(ch) == "Cf" or any(low <= ord(ch) <= high for low, high in _IGNORABLE)


def _stray_mark(ch: str) -> bool:
    return unicodedata.category(ch) in ("Mn", "Me") and ch != _KEYCAP_MARK


def _fold(text: str) -> str:
    """The text with each character's accents dropped, one character for one, so offsets agree."""
    return "".join(_base(ch) for ch in text)


def _base(ch: str) -> str:
    decomposed = unicodedata.normalize("NFD", ch)
    return decomposed[0] if len(decomposed) > 1 and unicodedata.category(decomposed[0])[0] == "L" else ch


# Digits and symbols

# Any decimal digit (Unicode Nd: ASCII, full-width, Arabic-Indic, ...), with the separators between
# digits of one number and a trailing keycap (U+FE0F U+20E3, as in the keycap 8) in the same hit.
_DIGIT_RUN = re.compile(r"\d(?:\d|[.,:'](?=\d))*[\ufe0f\u20e3]*")
_KEYCAP_TEN = "\U0001f51f"
_PERCENT_SIGNS = "%\u066a\u2030\u2031"   # percent, Arabic percent, per mille, per ten thousand


def _digits(shown: str) -> list[Hit]:
    hits = [Hit("digit", m.group(), m.start()) for m in _DIGIT_RUN.finditer(shown)]
    # Other numerals NFKC leaves alone (Unicode No and Nl, such as Tamil or Ethiopic numbers) and the
    # keycap ten read as numbers too.
    hits += [Hit("digit", ch, i) for i, ch in enumerate(shown)
             if ch == _KEYCAP_TEN or unicodedata.category(ch) in ("No", "Nl")]
    return hits


def _symbols(shown: str) -> list[Hit]:
    hits = []
    for i, ch in enumerate(shown):
        if unicodedata.category(ch) == "Sc":   # every currency sign: $ € £ ¥ ¢ ₹ ...
            us = i >= 2 and shown[i - 2:i].upper() == "US" and (i == 2 or not shown[i - 3].isalnum())
            hits.append(Hit("currency", shown[i - 2:i + 1] if us else ch, i - 2 if us else i))
        elif ch in _PERCENT_SIGNS:
            hits.append(Hit("percent", ch, i))
    return hits


# Words (matched on the folded text: no accents, any case)

def _words(*words: str) -> str:
    return r"\b(?:" + "|".join(sorted(words, key=len, reverse=True)) + r")\b"


_CURRENCY_WORDS = ("usd", "eur", "mxn", "dollar", "dollars", "dolar", "dolares", "peso", "pesos", "euro", "euros",
                   "buck", "bucks", "cent", "cents", "centavo", "centavos")
_CURRENCY_WORD = re.compile(_words(*_CURRENCY_WORDS), re.IGNORECASE)
_PERCENT = re.compile(_words("percent", r"per\s*cent", r"por\s*ciento", "porciento"), re.IGNORECASE)

_EN_NUMBERS = (
    "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
    "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fourty",
    "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million",
    "millions", "billion", "billions", "dozen", "dozens", "half", "halves",
)
_ES_NUMBERS = (
    "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "doce", "trece", "catorce",
    "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiun", "veintiuno",
    "veintiuna", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete",
    "veintiocho", "veintinueve", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa",
    "cien", "ciento", "cientos", "doscientos", "doscientas", "trescientos", "trescientas", "cuatrocientos",
    "cuatrocientas", "quinientos", "quinientas", "seiscientos", "seiscientas", "setecientos", "setecientas",
    "ochocientos", "ochocientas", "novecientos", "novecientas", "mil", "miles", "millon", "millones", "docena",
    "docenas", "mitad",
)
# Words that are numbers only beside money: "one moment" and "una pregunta" are ordinary prose.
_BARE_NUMBERS = ("one", "uno", "una", "once", "medio")
_NUMBER = re.compile(_words(*_EN_NUMBERS, *_ES_NUMBERS), re.IGNORECASE)
_BARE_NUMBER = re.compile(_words(*_BARE_NUMBERS), re.IGNORECASE)
_NUMBER_JOINER = re.compile(r"^[\s\-\u2010-\u2015]*(?:(?:and|y)[\s\-\u2010-\u2015]+)?$", re.IGNORECASE)
_TOKEN = re.compile(r"\w+|[^\w\s]")
_NEAR_MONEY = 3   # words between a bare number word and a currency or percent word

_DATE_WORDS = re.compile(_words(
    # en weekdays and months; "May" only after a preposition (below), so the modal passes
    "monday", "mondays", "tuesday", "tuesdays", "wednesday", "wednesdays", "thursday", "thursdays", "friday",
    "fridays", "saturday", "saturdays", "sunday", "sundays", "january", "february", "march", "april", "june",
    "july", "august", "september", "october", "november", "december",
    # en relative days and times
    "today", "tonight", "tomorrow", "yesterday", "weekend", "weekends", r"next\s+week", "noon", "midnight",
    "o['\u2019]?clock", r"this\s+morning", r"this\s+afternoon", r"this\s+evening", r"in\s+an\s+hour",
    # es weekdays and months
    "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "sabados", "domingo", "domingos", "enero",
    "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "setiembre", "octubre",
    "noviembre", "diciembre",
    # es relative days and times
    "hoy", r"pasado\s+manana", "manana", "ayer", r"esta\s+manana", r"esta\s+tarde", r"esta\s+noche",
    r"fin\s+de\s+semana", r"la\s+proxima\s+semana", r"la\s+semana\s+que\s+viene", r"el\s+mes\s+que\s+viene",
    r"en\s+una\s+hora", "mediodia", "medianoche",
), re.IGNORECASE)
_CLOCK = re.compile(r"\b[ap]\.\s?m\.|\bpm\b", re.IGNORECASE)   # a.m., p.m., pm; a bare "am" is the verb
_MONTH_MAY = re.compile(r"\b(?i:in|on|by|until|till|next|this|early|late|mid|last)[\s\-]+May\b")
# An ordinal from third to thirty-first after "the" ("on the fifth"), a month name ("November
# third") or its abbreviation, with or without its dot ("Nov. third"), is a day of the month. "The
# first" and "the second" are too often not ("first, let me check", "one second"), and are left to
# the digit forms ("the 1st").
_HYPHEN = r"[\s\-‐-―]+"
_UNIT_ORDINALS = ("first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth")
_ORDINAL = (r"(?:twenty" + _HYPHEN + "(?:" + "|".join(_UNIT_ORDINALS) + r")|thirty" + _HYPHEN + "first|"
            "third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|"
            "fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)")
_EN_MONTHS = ("january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
              "november", "december")
_EN_MONTH_ABBREVIATIONS = ("jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec")
_ORDINAL_DATE = re.compile(r"\b(?:the|" + "|".join(_EN_MONTHS) + "|(?:" + "|".join(_EN_MONTH_ABBREVIATIONS)
                           + r")\.?)\s+" + _ORDINAL + r"\b", re.IGNORECASE)
# A unit fraction is an amount beside a discount or price word ("a quarter off", "a fifth off the
# price", "un cuarto de descuento"); "a quarter of an hour" and "the third option" are ordinary prose.
_FRACTION = re.compile(_words(
    "quarter", "quarters", "third", "thirds", "fifth", "fifths", "sixth", "sixths", "seventh", "sevenths",
    "eighth", "eighths", "ninth", "ninths", "tenth", "tenths",
    "cuarto", "cuartos", "tercio", "tercios", "quinto", "quintos", "sexto", "sextos", "septimo", "septimos",
    "setimo", "setimos", "octavo", "octavos", "noveno", "novenos", "decimo", "decimos",
), re.IGNORECASE)
_DISCOUNT_WORD = re.compile(_words("off", "discount", "discounts", "descuento", "descuentos", "price", "prices",
                                   "precio", "precios"), re.IGNORECASE)


# Card amounts: a currency mark before or after a number. Thousands group with ".", "," or a space
# (NFKC turns no-break spaces into spaces), never a line break, so a card's lines stay apart.
_MARK = r"(?:US\$|\$|€|£|¥|USD|EUR|MXN)"
_AMOUNT = r"(\d{1,3}(?:[., ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)"
_CARD_AMOUNT = re.compile(rf"{_MARK} ?{_AMOUNT}(?!\d)|(?<![\d.,]){_AMOUNT} ?{_MARK}(?! ?\d)")
# A quote card's discount (en "80%", es "80 %") and its expiry line, matched on the folded text:
# en "Good until Tuesday, November 3, 2:00 pm", es "Válido hasta martes 3 de noviembre, 14:00".
_CARD_PERCENT = re.compile(r"(?<![\d.,])(\d+(?:[.,]\d+)?) ?%")
_EN_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
_ES_WEEKDAYS = ("lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo")
_ES_MONTHS = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
              "noviembre", "diciembre")
_DAY_OF_MONTH = r"(?:[1-9]|[12]\d|3[01])"
_EN_CLOCK, _ES_CLOCK = r"(?:[1-9]|1[0-2]):[0-5]\d [ap]m", r"(?:1?\d|2[0-3]):[0-5]\d"
_EXPIRY_LINE = re.compile(
    rf"good until (?:{'|'.join(_EN_WEEKDAYS)}), (?:{'|'.join(_EN_MONTHS)}) {_DAY_OF_MONTH}, {_EN_CLOCK}"
    rf"|valido hasta (?:{'|'.join(_ES_WEEKDAYS)}) {_DAY_OF_MONTH} de (?:{'|'.join(_ES_MONTHS)}), {_ES_CLOCK}",
    re.IGNORECASE)


def _date_words(folded: str) -> list[re.Match]:
    return [*_DATE_WORDS.finditer(folded), *_CLOCK.finditer(folded), *_MONTH_MAY.finditer(folded),
            *_ORDINAL_DATE.finditer(folded)]


def _spelled_amounts(shown: str, folded: str, money: list[Hit]) -> list[Hit]:
    """Number words, merged into one hit per amount ("ochenta y nueve", "fifteen hundred"). A bare
    one, uno, una, once or medio counts within three words of a currency or percent word, or next
    to another number word ("one hundred"); a unit fraction (a quarter, a third to a tenth, cuarto,
    tercio, quinto to décimo) counts within three words of a discount or price word ("a quarter
    off")."""
    money_spans = [(hit.start, hit.start + len(hit.span)) for hit in money]
    discount_spans = [(m.start(), m.end()) for m in _DISCOUNT_WORD.finditer(folded)]
    # "ciento" in "por ciento" is the percent word, already a hit.
    spans = [(m.start(), m.end()) for m in _NUMBER.finditer(folded)
             if not any(start <= m.start() < end for start, end in money_spans)]
    tokens = [(m.start(), m.end()) for m in _TOKEN.finditer(folded)
              if m.group()[0].isalnum() or any(start <= m.start() < end for start, end in money_spans)]
    is_money = [any(start < t_end and t_start < end for start, end in money_spans) for t_start, t_end in tokens]
    is_discount = [any(start == t_start for start, _ in discount_spans) for t_start, _ in tokens]
    is_number = [any(start == t_start for start, _ in spans) for t_start, _ in tokens]
    for m in _BARE_NUMBER.finditer(folded):
        i = next((i for i, (t_start, _) in enumerate(tokens) if t_start == m.start()), None)
        if i is None:
            continue
        near = range(max(0, i - _NEAR_MONEY), min(len(tokens), i + _NEAR_MONEY + 1))
        beside = (i > 0 and is_number[i - 1]) or (i + 1 < len(tokens) and is_number[i + 1])
        if beside or any(is_money[j] for j in near):
            spans.append((m.start(), m.end()))
    for m in _FRACTION.finditer(folded):
        i = next((i for i, (t_start, _) in enumerate(tokens) if t_start == m.start()), None)
        if i is None:
            continue
        near = range(max(0, i - _NEAR_MONEY), min(len(tokens), i + _NEAR_MONEY + 1))
        if any(is_discount[j] for j in near):
            spans.append((m.start(), m.end()))
    merged: list[list[int]] = []
    for start, end in sorted(spans):
        if merged and _NUMBER_JOINER.match(folded[merged[-1][1]:start]):
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [Hit("spelled_amount", shown[start:end], start) for start, end in merged]
