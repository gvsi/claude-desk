"""Make the reply check's lookalike table, desk/kernel_service/lexicon/lookalikes.txt.

    uv run python -m scripts.lookalikes                         # remake the table
    uv run python -m scripts.lookalikes --check                 # exit 1 unless the committed table is what this makes
    uv run python -m scripts.lookalikes --source FILE [--check]  # the same, remaking (or checking) the kept lines too

The source is Unicode's confusables.txt, version 18.0.0. `--source` reads the published file, and
only when its sha256 is the one below:

    curl -sO https://www.unicode.org/Public/18.0.0/security/confusables.txt

scripts/unicode/confusables-18.0.0-kept.txt holds that file's header and the mapping lines the
table is made from, each as it is there, so the table can be remade and checked without the
download, and each kept line can be found in the published file with `grep -F`.

A line is kept when its source is one character outside ASCII that NFKD leaves as it is and its
prototype is one ASCII letter or digit. For a letter, the character must be a letter too: general
category L in Python's Unicode database or, for a code point newer than that database, a name that
says LETTER or DIGIT (a digit newer than the database whose prototype is O or l, such as OUTLINED
DIGIT ZERO). For a digit, it may be anything that database doesn't already count as a numeral
(category N), since the scan reads numerals as they are. The table has one
`<code point>\\t<prototype>\\t# <name>` line per kept line, in code point order, under a header that
states the source and this filter. A test checks that the committed table is exactly what this
makes.
"""

import argparse
import hashlib
import re
import string
import sys
import unicodedata
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
KEPT = BACKEND / "scripts" / "unicode" / "confusables-18.0.0-kept.txt"
TABLE = BACKEND / "desk" / "kernel_service" / "lexicon" / "lookalikes.txt"
SOURCE_SHA256 = "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92"

# A mapping line: `<source> ;\t<prototype> ;\tMA\t# ( <glyphs> → <glyphs> ) <SOURCE NAME> → <PROTOTYPE NAME>\t#`
# and a path, the comment starting `#*` when the source isn't an identifier character. The glyphs
# may hold any character or none (the line for U+2028 shows none), and the names never a `)`.
CODES = r"[0-9A-F]{4,6}(?: [0-9A-F]{4,6})*"
NAME = r"[A-Z0-9][A-Z0-9 ,\-]*"
LINE = re.compile(rf"(?P<source>{CODES}) ;\t(?P<prototype>{CODES}) ;\tMA\t#\*? \(.*\) (?P<name>{NAME}?) → {NAME}\t#")

KEPT_NOTE = """\
# The header and the lines of Unicode's confusables.txt that backend/scripts/lookalikes.py makes
# the reply check's lookalike table from, each as it is in the published file (sha256
# {sha256}).
# Remake it with `python -m scripts.lookalikes --source confusables.txt`.
#
"""

HEADER = """\
# Characters that look like one ASCII letter or digit, made by backend/scripts/lookalikes.py from
# Unicode's confusables.txt (version {version}, {date}): every character outside ASCII that NFKD
# leaves as it is and whose prototype there is a single ASCII letter or digit. For a letter, the
# character is a letter: general category L in Python's Unicode database ({unidata}) or, for a code
# point newer than that, a name that says LETTER or DIGIT. For a digit, it is anything that database
# doesn't count as a numeral.
# The prose scan reads each letter as its Latin letter before the lexicons run, so "Tuеsday" with a
# Cyrillic е is read as Tuesday. Letters drawn as a bare stroke have the prototype l, and the scan
# also reads them as i, since they stand for I as readily as for l ("ΝΙΝΕ"). It reads each digit
# lookalike as a digit, and the letters shaped like O and l next to one as 0 and 1, so "ЗОО" with
# a Cyrillic З and О is a number.
# One `<code point>\\t<letter or digit>` per line, the character's name after a `#`.

"""


def published(path: Path) -> str:
    """The published confusables.txt at `path`. Raises ValueError when it isn't that file."""
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        raise ValueError(f"{path} isn't Unicode's confusables.txt 18.0.0 (sha256 {SOURCE_SHA256})")
    return data.decode("utf-8")


def _kept(ch: str, prototype: str, name: str) -> bool:
    """Whether the table holds `ch`, whose prototype is `prototype` and whose name is `name`."""
    if ord(ch) < 0x80 or unicodedata.normalize("NFKD", ch) != ch:
        return False
    category = unicodedata.category(ch)
    if prototype in string.digits:
        return category[0] != "N"
    newer = category == "Cn" and not {"LETTER", "DIGIT"}.isdisjoint(name.split())
    return prototype in string.ascii_letters and (category[0] == "L" or newer)


def _mappings(text: str) -> list[tuple[str, str, str, str]]:
    """`(character, prototype, name, line)` for each mapping line of `text` whose source and
    prototype are one code point each, in file order. Raises ValueError on a line that is neither
    a comment, blank nor a mapping."""
    found = []
    # split on "\n" only: the glyphs in the comments are quoted as they are, so a line may hold
    # characters that str.splitlines() breaks on
    for number, line in enumerate(text.split("\n"), start=1):
        if not line.strip() or line.startswith("#"):
            continue
        match = LINE.match(line)
        if match is None:
            raise ValueError(f"line {number} isn't a mapping line: {line[:60]!r}")
        source, prototype = match["source"].split(), match["prototype"].split()
        if len(source) == 1 and len(prototype) == 1:
            found.append((chr(int(source[0], 16)), chr(int(prototype[0], 16)), match["name"], line))
    return found


def _field(text: str, label: str) -> str:
    match = re.search(rf"^# {label}: (.+)$", text, re.MULTILINE)
    if match is None:
        raise ValueError(f"confusables.txt has no {label} line")
    return match.group(1)


def kept_lines(source: str) -> str:
    """The kept file's text from the published confusables.txt: a note, the file's own header (its
    first comment lines) and the mapping lines the table is made from, in file order."""
    header = []
    for line in source.split("\n"):
        if not line.startswith("#"):
            break
        header.append(line + "\n")
    lines = [line + "\n" for ch, prototype, name, line in _mappings(source) if _kept(ch, prototype, name)]
    return KEPT_NOTE.format(sha256=SOURCE_SHA256) + "".join(header) + "\n" + "".join(lines)


def table(text: str | None = None) -> str:
    """The table's text, as the committed file must hold it, from `text` (the kept lines, by
    default the committed ones, or the published file)."""
    text = KEPT.read_text(encoding="utf-8") if text is None else text
    entries = sorted((ord(ch), prototype, name) for ch, prototype, name, _ in _mappings(text)
                     if _kept(ch, prototype, name))
    header = HEADER.format(version=_field(text, "Version"), date=_field(text, "Date").split(",")[0],
                           unidata=unicodedata.unidata_version)
    return header + "".join(f"{code:04X}\t{prototype}\t# {name}\n" for code, prototype, name in entries)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, help="the published confusables.txt; remake the kept lines from it")
    parser.add_argument("--check", action="store_true", help="compare with the committed files; write nothing")
    args = parser.parse_args()
    made = {}
    if args.source is not None:
        made[KEPT] = kept_lines(published(args.source))
    made[TABLE] = table(made.get(KEPT))
    stale = [path for path, text in made.items() if not path.exists() or path.read_text(encoding="utf-8") != text]
    if args.check:
        for path in made:
            verdict = "isn't" if path in stale else "is"
            print(f"{path.relative_to(BACKEND)} {verdict} what scripts/lookalikes.py makes")
        return 1 if stale else 0
    for path in stale:
        path.write_text(made[path], encoding="utf-8")
        print(f"wrote {path.relative_to(BACKEND)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
