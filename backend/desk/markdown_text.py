"""What a visitor sees of Claude's prose, which the chats render as Markdown (the owner's decision of
2026-11-01: CommonMark with GFM tables and strikethrough by one tilde or two, no raw HTML, links
clickable by their text).

`read` parses the prose with markdown-it (CommonMark, tables and strikethrough by one tilde or two,
no linkify, raw HTML recognised) and returns what a reader sees of it: the text of every block, a
newline after each, with entities and escapes decoded, emphasis joined to the letters around it,
code as written, table cells, link text, and each ordered list item's number as its list renders
it ("N. ", counted from its start), so formatting can hide no number or word from the reply check's
scan; then link titles and images' alt text and titles, after the whole body, so none splits a
word of it. Every link a reader can click, with its text and target, for the reply check to judge
(the owner's decision of 2026-11-01: every clickable link goes to the business's contact): inline,
reference and autolink forms, with a target of any scheme, and, since the chats autolink as GFM
does, each URL with a scheme or "www." (read as https) and each email address in the visible
reading, code included (`literal_links`). And whether there is an image. Pure, with no I/O.

A numbered list of steps passes (the owner's decision of 2026-11-01): an ordered list that starts at
1 and has at most nine items, as the parser reads it, shows only the numbers 1 to 9, so its numbers
are left out of the visible reading and `list_markers` gives where its typed markers ("1.", "2)")
are in the text, for the raw scan to blank (`blank`). Every other list keeps its numbers in the
visible reading and its markers in the raw text: one that starts at another number ("5. Call us",
"0. a"), one of ten items or more, and any digit the parser doesn't read as a list marker.
`blank_list_markers` is the same blanking for the evals' oracles, so the two can't disagree: plain
code shared by the kernel and the evals, as `desk.rewrites` is, so judging imports no kernel code.

Raw HTML: the visible reading drops it, as a renderer without raw HTML does; the raw reading is what
an escaping renderer shows; the scan reads both. So a tag inside a word joins its letters ("fr<b></b>ee"
reads "free"), and a link or an image written in HTML is neither.

Prose nested deeper than markdown-it follows (`MAX_NESTING`) is dropped from its token stream, so
it raises `TooDeep`, which the reply check refuses rather than trust a reading with text missing.
"""

import re
from dataclasses import dataclass

from markdown_it import MarkdownIt
from markdown_it.token import Token

MAX_NESTING = 20          # markdown-it's own default, named so a reading that reached it is refused
PASSING_ITEMS = 9         # a list from 1 with at most this many items shows only 1 to 9, which may pass
LINE_BREAK = re.compile(r"\r\n?|\n")                # where markdown-it breaks lines
MARKER_PREFIX = re.compile(r"[ \t>*+-]*")           # indentation, quote and bullet marks before an item's marker
# What GFM links in text without any link syntax: a URL with a scheme or "www.", up to a blank or "<", and an
# email address (its extended autolinks). Matched anywhere, so a stricter reading than GFM's own.
URL_LITERAL = re.compile(r"(?:https?://|www\.)[^\s<]+", re.IGNORECASE)
EMAIL_LITERAL = re.compile(r"[A-Za-z0-9.+_-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+")
TRAILING = "?!.,:;*_~'\"()[]{}"                        # punctuation after a literal URL, which a sentence puts there
INLINE_TEXT = frozenset({"text", "code_inline"})
LINE_BREAKS = frozenset({"softbreak", "hardbreak"})


class TooDeep(ValueError):
    """The prose nests blocks deeper than the parser follows, so part of it has no reading."""


@dataclass(frozen=True)
class Link:
    """A link as a reader meets it: the text shown, and where it goes."""

    text: str
    href: str


@dataclass(frozen=True)
class MarkdownText:
    visible: str
    links: tuple[Link, ...]
    images: bool
    list_markers: tuple[tuple[int, int], ...]     # the passing lists' typed markers, as [start, end) in the text


def _parser() -> MarkdownIt:
    # Raw HTML is recognised so the visible reading can leave it out: its tokens add nothing to `visible`.
    # Single tildes strike through as well as double ones, as the chats' renderer (remark-gfm) does.
    parser = MarkdownIt("commonmark", {"html": True, "maxNesting": MAX_NESTING, "strikethrough_single_tilde": True})
    parser.enable(["table", "strikethrough"])
    # markdown-it leaves "javascript:" and other unsafe targets unlinked, but the browser's parser links
    # them (then strips the target): every target is tokenized here, for the reply check to judge.
    parser.validateLink = lambda url: True
    return parser


PARSER = _parser()


def _ordered_items(tokens: list[Token]) -> dict[int, tuple[int, bool]]:
    """Each ordered list item's token index, with the number its list renders for it and whether its
    list passes: it starts at 1 and has at most `PASSING_ITEMS` items."""
    items: dict[int, tuple[int, bool]] = {}
    lists: list[tuple[int, list[int]] | None] = []     # (start, item indices) per open list; None for bullets
    for index, token in enumerate(tokens):
        if token.type == "ordered_list_open":
            start = token.attrGet("start")
            lists.append((int(start) if start is not None else 1, []))
        elif token.type == "bullet_list_open":
            lists.append(None)
        elif token.type in ("ordered_list_close", "bullet_list_close") and lists:
            closed = lists.pop()
            if closed is not None:
                start, indices = closed
                passes = start == 1 and len(indices) <= PASSING_ITEMS
                items.update((item, (start + count, passes)) for count, item in enumerate(indices))
        elif token.type == "list_item_open" and lists and lists[-1] is not None:
            lists[-1][1].append(index)
    return items


def _marker_spans(text: str, tokens: list[Token], items: dict[int, tuple[int, bool]]) -> tuple[tuple[int, int], ...]:
    """Where the passing lists' items have their typed markers in `text`: each on its item's first
    line, after only indentation, quote and bullet marks and the markers of items before it on that
    line. A marker not found there is left out, and so stays in the raw scan."""
    breaks = list(LINE_BREAK.finditer(text))
    starts = [0, *(found.end() for found in breaks)]
    ends = [*(found.start() for found in breaks), len(text)]
    cursor: dict[int, int] = {}
    spans: list[tuple[int, int]] = []
    for index in sorted(items):
        token = tokens[index]
        if not token.map or token.map[0] >= len(starts):
            continue
        line = token.map[0]
        marker = f"{token.info}{token.markup}"
        at = MARKER_PREFIX.match(text, cursor.get(line, starts[line]), ends[line]).end()
        if not (text.startswith(marker, at) and at + len(marker) <= ends[line]):
            continue
        cursor[line] = at + len(marker)
        if items[index][1]:
            spans.append((at, at + len(marker)))
    return tuple(spans)


def _inline(children: list[Token], links: list[Link], extras: list[str]) -> tuple[str, bool]:
    """An inline token's body text, adding its links to `links`, and its link titles and images' alt
    text and titles to `extras`, which are read after the whole body so none splits a word of it;
    and whether it holds an image."""
    parts: list[str] = []
    images = False
    open_links: list[tuple[Token, int]] = []
    for child in children:
        if child.type in INLINE_TEXT:
            parts.append(child.content)
        elif child.type in LINE_BREAKS:
            parts.append("\n")
        elif child.type == "image":
            images = True
            alt, _ = _inline(child.children or [], links, extras)
            extras.append(alt)
            if title := child.attrGet("title"):
                extras.append(str(title))
        elif child.type == "link_open":
            open_links.append((child, len(parts)))
        elif child.type == "link_close" and open_links:
            opened, first = open_links.pop()
            links.append(Link(text="".join(parts[first:]), href=str(opened.attrGet("href") or "")))
            if title := opened.attrGet("title"):
                extras.append(str(title))
    return "".join(parts), images


def read(text: str) -> MarkdownText:
    """`text` as a reader sees it once rendered (see the module's docstring)."""
    tokens = PARSER.parse(text)
    if any(token.level >= MAX_NESTING - 1 for token in tokens):
        raise TooDeep("the prose nests deeper than the parser follows")
    items = _ordered_items(tokens)
    parts: list[str] = []
    links: list[Link] = []
    extras: list[str] = []
    images = False
    for index, token in enumerate(tokens):
        if index in items:
            number, passes = items[index]
            if not passes:
                parts.append(f"{number}. ")
        elif token.type == "inline":
            shown, has_image = _inline(token.children or [], links, extras)
            parts.append(f"{shown}\n")
            images = images or has_image
        elif token.type in ("code_block", "fence"):
            parts.append(token.content if token.content.endswith("\n") else f"{token.content}\n")
    visible = "".join(parts) + "".join(f"{extra}\n" for extra in extras)
    return MarkdownText(visible=visible, links=(*links, *literal_links(visible)), images=images,
                        list_markers=_marker_spans(text, tokens, items))


def literal_links(visible: str) -> list[Link]:
    """The links the chats make of `visible` text with no link syntax, as GFM does: each URL with a
    scheme or "www." (read as https), without the punctuation a sentence puts after it, and each
    email address (as mailto:) outside those URLs."""
    found: list[Link] = []
    for match in URL_LITERAL.finditer(visible):
        url = match[0].rstrip(TRAILING)
        found.append(Link(text=url, href=url if "://" in url else f"https://{url}"))
    rest = URL_LITERAL.sub(lambda match: " " * len(match[0]), visible)
    found += [Link(text=match[0], href=f"mailto:{match[0]}") for match in EMAIL_LITERAL.finditer(rest)]
    return found


def blank(text: str, spans: tuple[tuple[int, int], ...]) -> str:
    """`text` with each of `spans` blanked out, every other character kept where it was."""
    chars = list(text)
    for start, end in spans:
        chars[start:end] = " " * (end - start)
    return "".join(chars)


def blank_list_markers(text: str) -> str:
    """`text` with the passing lists' typed markers blanked out (`read`'s `list_markers`), as the raw
    scan reads it; prose too deep to read keeps every marker."""
    try:
        return blank(text, read(text).list_markers)
    except TooDeep:
        return text
