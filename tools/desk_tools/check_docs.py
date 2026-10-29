"""Check the repository's Markdown docs.

    python -m desk_tools.check_docs [--final] [--root PATH]

Relative links across README.md, AGENTS.md and docs/**/*.md resolve inside the repository (anchors
are ignored). The shipped docs (SHIPPED_DOCS) hold no private reference: no home-directory path in a
link target or code, no run-ledger path or claude.ai artifact or share link anywhere, and no term
from the optional, git-ignored .local/docs-deny.txt (one per line, `#` comments, matched ignoring
case).
Each phrase in DISCLOSURES appears in every doc it names, ignoring case, line breaks and curly
apostrophes. With --final, the shipped docs also hold no placeholder: a value still to be measured
(`[measured: …]`) or a link the owner still has to give (`[owner: …]`).

Exit 0 when every check passes, 1 when any fails (each failure printed as `file:line: what`),
2 on a usage error.
"""

import argparse
import re
import sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

REPO = Path(__file__).resolve().parents[2]

# The docs a reader of the repository is pointed to. Plans, specs, reviews, research and spikes are
# the build's record: they quote placeholders and run paths, so only their links are checked.
SHIPPED_DOCS = (
    "README.md",
    "docs/threat-model.md",
    "docs/architecture-decisions.md",
    "docs/path-to-mvp.md",
    "docs/deploy.md",
    "docs/ci.md",
    "docs/evals.md",
)

# Private anywhere in a shipped doc, and private in a link target or code (where a path is a path,
# not prose such as "the AWS CLI reads ~/.aws").
PRIVATE_ANYWHERE = (".plan-runs/", "claude.ai/artifact", "claude.ai/code/artifact", "claude.ai/share")
PRIVATE_IN_PATHS = ("/Users/", "~/")
DENY_LIST = ".local/docs-deny.txt"

PLACEHOLDERS = ("[measured:", "[owner:")

# Each phrase a reader must find, and the shipped docs that must say it (case and line breaks aside).
DISCLOSURES: dict[str, tuple[str, ...]] = {
    "shows codes to whoever entered the contact": ("README.md", "docs/threat-model.md"),
    "does not establish possession of the contact": ("README.md", "docs/threat-model.md"),
    "whether a contact is on record": ("README.md", "docs/threat-model.md"),
    "cancel a contact's live challenge": ("README.md", "docs/threat-model.md"),
    "use up its hourly limit": ("README.md", "docs/threat-model.md"),
    "verification codes are simulated": ("README.md", "docs/threat-model.md"),
    "payments are mocked": ("README.md", "docs/threat-model.md"),
    "a buggy API process": ("docs/threat-model.md",),
    "out of the attacker's reach": ("docs/threat-model.md",),
}


@dataclass(frozen=True)
class Problem:
    path: str
    line: int
    message: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: {self.message}" if self.line else f"{self.path}: {self.message}"


def linked_docs(root: Path) -> list[Path]:
    """The docs whose relative links must resolve."""
    docs = [root / name for name in ("README.md", "AGENTS.md") if (root / name).is_file()]
    if (root / "docs").is_dir():
        docs += sorted(path for path in (root / "docs").rglob("*.md") if path.is_file())
    return docs


_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_CODE_SPAN = re.compile(r"(`+)(?!`)(.+?)(?<!`)\1(?!`)")
_INLINE_LINK = re.compile(   # [text](target "title") or ![alt](<target>); the target is group 1
    r"!?\[(?:[^\[\]]|\[[^\[\]]*\])*\]"
    r"\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)"
)
_REFERENCE_DEF = re.compile(r"^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)")
_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


def _lines(text: str) -> Iterator[tuple[int, str, bool]]:
    """(line number, line, whether it is inside a fenced code block); fence lines themselves are skipped."""
    fence = None
    for number, line in enumerate(text.splitlines(), start=1):
        if fence is None:
            match = _FENCE.match(line)
            if match:
                fence = match.group(1)
                continue
            yield number, line, False
        elif line.strip().startswith(fence) and set(line.strip()) == {fence[0]}:
            fence = None
        else:
            yield number, line, True


def prose_lines(text: str) -> Iterator[tuple[int, str]]:
    """Each line outside fenced code blocks, with its code spans blanked out."""
    for number, line, fenced in _lines(text):
        if not fenced:
            yield number, _CODE_SPAN.sub(lambda span: " " * len(span.group(0)), line)


def code_segments(text: str) -> Iterator[tuple[int, str]]:
    """Each code span, and each line of a fenced code block, with its line number."""
    for number, line, fenced in _lines(text):
        if fenced:
            yield number, line
        else:
            yield from ((number, span.group(2)) for span in _CODE_SPAN.finditer(line))


def link_targets(text: str) -> Iterator[tuple[int, str]]:
    for number, line in prose_lines(text):
        for match in _INLINE_LINK.finditer(line):
            yield number, match.group(1)
        definition = _REFERENCE_DEF.match(line)
        if definition:
            yield number, definition.group(1)


def check_links(root: Path) -> list[Problem]:
    problems = []
    inside = root.resolve()
    for doc in linked_docs(root):
        for number, raw in link_targets(doc.read_text()):
            target = raw[1:-1] if raw.startswith("<") and raw.endswith(">") else raw
            if not target or target.startswith("#") or target.startswith("//") or _SCHEME.match(target):
                continue
            path = unquote(target.split("#", 1)[0].split("?", 1)[0])
            resolved = root / path.lstrip("/") if path.startswith("/") else doc.parent / path
            where = doc.relative_to(root).as_posix()
            if not resolved.resolve().is_relative_to(inside):   # it may exist here, but not in a clone
                problems.append(Problem(where, number, f"broken link {target} (it leaves the repository)"))
            elif not resolved.exists():
                problems.append(Problem(where, number, f"broken link {target}"))
    return problems


def shipped_docs(root: Path) -> list[tuple[str, str]]:
    """(path, text) of each shipped doc in the tree; one not written yet is skipped here."""
    return [(name, (root / name).read_text()) for name in SHIPPED_DOCS if (root / name).is_file()]


def deny_terms(root: Path) -> list[tuple[int, str]]:
    path = root / DENY_LIST
    if not path.is_file():
        return []
    terms = []
    for number, line in enumerate(path.read_text().splitlines(), start=1):
        term = line.strip()
        if term and not term.startswith("#"):
            terms.append((number, term.casefold()))
    return terms


def check_private(root: Path) -> list[Problem]:
    problems = []
    terms = deny_terms(root)
    for name, text in shipped_docs(root):
        found: dict[int, set[str]] = {}
        for number, line in enumerate(text.splitlines(), start=1):
            found.setdefault(number, set()).update(p for p in PRIVATE_ANYWHERE if p in line)
            folded = line.casefold()
            found[number].update(f"a term from {DENY_LIST}, line {at}" for at, term in terms if term in folded)
        paths = list(code_segments(text)) + list(link_targets(text))
        for number, segment in paths:
            found.setdefault(number, set()).update(f"{p} in a link or code" for p in PRIVATE_IN_PATHS if p in segment)
        for number in sorted(found):
            for what in sorted(found[number]):
                problems.append(Problem(name, number, f"private reference ({what})"))
    return problems


def _normalized(text: str) -> str:
    return " ".join(text.replace("\u2019", "'").casefold().split())


def check_disclosures(root: Path) -> list[Problem]:
    problems = []
    required: dict[str, list[str]] = {}
    for phrase, paths in DISCLOSURES.items():
        for path in paths:
            required.setdefault(path, []).append(phrase)
    for path, phrases in required.items():
        doc = root / path
        if not doc.is_file():
            problems.append(Problem(path, 0, "missing (it must carry the required disclosures)"))
            continue
        text = _normalized(doc.read_text())
        problems += [Problem(path, 0, f'missing the disclosure "{p}"') for p in phrases if _normalized(p) not in text]
    return problems


def check_placeholders(root: Path) -> list[Problem]:
    problems = []
    for name, text in shipped_docs(root):
        for number, line in enumerate(text.splitlines(), start=1):
            problems += [Problem(name, number, f"placeholder {p}") for p in PLACEHOLDERS if p in line]
    return problems


def check(root: Path, final: bool = False) -> list[Problem]:
    problems = check_links(root) + check_private(root) + check_disclosures(root)
    if final:
        problems += check_placeholders(root)
    return problems


def main(argv: list[str] | None = None, out: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(prog="python -m desk_tools.check_docs", description=__doc__.split("\n\n")[0])
    parser.add_argument("--final", action="store_true", help="also refuse placeholders in the shipped docs")
    parser.add_argument("--root", type=Path, default=REPO, help="the repository root (default: this checkout)")
    args = parser.parse_args(argv)
    problems = check(args.root.resolve(), final=args.final)
    for problem in problems:
        out(f"docs-check: {problem}")
    if problems:
        out(f"docs-check: {len(problems)} problem{'s' if len(problems) != 1 else ''}")
        return 1
    out("docs-check: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
