"""What a visitor sees of Claude's prose, which the chats render as Markdown (the owner's decision of
2026-11-01: CommonMark with GFM tables and strikethrough, no raw HTML, links clickable by their text).

`read` parses the prose with markdown-it (CommonMark, tables and strikethrough, no linkify, HTML left
as the text it is) and returns what a reader sees of it: the text of every block, a newline after
each, with entities and escapes decoded, emphasis joined to the letters around it, code as written,
table cells, link and image text, link titles, and each ordered list item's number as the list
renders it ("N. ", counted from its start), so formatting can hide no number or word from the
reply check's scan. Every link, with its text and target (inline, reference and autolink forms; a
target of any scheme, which the reply check judges), and whether there is an image. Pure, with no
I/O.

Prose nested deeper than markdown-it follows (`MAX_NESTING`) is dropped from its token stream, so
it raises `TooDeep`, which the reply check refuses rather than trust a reading with text missing.
"""

from dataclasses import dataclass

from markdown_it import MarkdownIt
from markdown_it.token import Token

MAX_NESTING = 20          # markdown-it's own default, named so a reading that reached it is refused
INLINE_TEXT = frozenset({"text", "code_inline"})
LINE_BREAKS = frozenset({"softbreak", "hardbreak"})


class TooDeep(ValueError):
    """The prose nests blocks deeper than the parser follows, so part of it has no reading."""


@dataclass(frozen=True)
class Link:
    """A link as a reader meets it: the text shown, and where it goes."""

    text: str
    href: str
    auto: bool                     # an autolink ("<https://…>"), whose text is its own target


@dataclass(frozen=True)
class MarkdownText:
    visible: str
    links: tuple[Link, ...]
    images: bool


def _parser() -> MarkdownIt:
    parser = MarkdownIt("commonmark", {"html": False, "maxNesting": MAX_NESTING}).enable(["table", "strikethrough"])
    # markdown-it leaves "javascript:" and other unsafe targets unlinked, but the browser's parser links
    # them (then strips the target): every target is tokenized here, for the reply check to judge.
    parser.validateLink = lambda url: True
    return parser


PARSER = _parser()


def _list_numbers(tokens: list[Token]) -> dict[int, int]:
    """Each ordered list item's token index, with the number its list renders for it."""
    numbers: dict[int, int] = {}
    lists: list[tuple[int, int] | None] = []     # (start, items so far) per open list; None for a bullet list
    for index, token in enumerate(tokens):
        if token.type == "ordered_list_open":
            start = token.attrGet("start")
            lists.append((int(start) if start is not None else 1, 0))
        elif token.type == "bullet_list_open":
            lists.append(None)
        elif token.type in ("ordered_list_close", "bullet_list_close"):
            lists.pop()
        elif token.type == "list_item_open" and lists and lists[-1] is not None:
            start, count = lists[-1]
            numbers[index] = start + count
            lists[-1] = (start, count + 1)
    return numbers


def _inline(children: list[Token], links: list[Link]) -> tuple[str, bool]:
    """An inline token's visible text, adding its links to `links`; and whether it holds an image."""
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
            alt, _ = _inline(child.children or [], links)
            parts.append(alt)
            if title := child.attrGet("title"):
                parts.append(f"\n{title}\n")
        elif child.type == "link_open":
            open_links.append((child, len(parts)))
        elif child.type == "link_close" and open_links:
            opened, first = open_links.pop()
            links.append(Link(text="".join(parts[first:]), href=str(opened.attrGet("href") or ""),
                              auto=opened.markup == "autolink"))
            if title := opened.attrGet("title"):
                parts.append(f"\n{title}\n")
    return "".join(parts), images


def read(text: str) -> MarkdownText:
    """`text` as a reader sees it once rendered (see the module's docstring)."""
    tokens = PARSER.parse(text)
    if any(token.level >= MAX_NESTING - 1 for token in tokens):
        raise TooDeep("the prose nests deeper than the parser follows")
    numbers = _list_numbers(tokens)
    parts: list[str] = []
    links: list[Link] = []
    images = False
    for index, token in enumerate(tokens):
        if index in numbers:
            parts.append(f"{numbers[index]}. ")
        elif token.type == "inline":
            shown, has_image = _inline(token.children or [], links)
            parts.append(f"{shown}\n")
            images = images or has_image
        elif token.type in ("code_block", "fence"):
            parts.append(token.content if token.content.endswith("\n") else f"{token.content}\n")
    return MarkdownText(visible="".join(parts), links=tuple(links), images=images)
