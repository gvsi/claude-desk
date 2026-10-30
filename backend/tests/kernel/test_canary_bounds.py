"""Canary scans are bounded.

Every document's canary is looked for wherever text could carry the document out, so the cost of a
scan grows with the text and with the canaries it looks for. A scan with no canaries returns before
it reads the text; one with many reads the text once for all of them, however many there are.
"""

import random
import time
from collections.abc import Mapping

from desk.kernel_service import labels, reply_check

from .test_labels_hardening import disguises


def test_a_scan_with_no_canaries_reads_nothing(monkeypatch):
    """With no canary to look for, or only canaries with no letters or digits to match, a scan
    returns at once, before it reads the text, so a long reply on a Desk with no documents costs the
    reply check nothing here."""
    read, reading = [], labels._reading
    monkeypatch.setattr(labels, "_reading", lambda text: read.append(text) or reading(text))
    long = "si ya está confirmada " * 4_000
    for canaries in ({}, labels.NO_CANARIES, {"doc-1": "--"}):
        assert labels.canary_spans(long, canaries) == []
        assert labels.find_canaries(long, canaries) == []
        assert labels.find_canaries_in({"reply": long}, canaries) == []
    assert [v.kind for v in reply_check.scan_prose(long)] == []
    assert not any(long in text for text in read)


def one_canary_at_a_time(text: str, canaries: Mapping[str, str]) -> list[tuple[str, int, int]]:
    """The reference the one-pass scan is held to: each canary looked for on its own, in its own
    pass over the reading, as the kernel did before it read the text once for all of them."""
    key, skippable, origin = labels._reading(text)

    def places(wanted: str) -> list[tuple[int, int]]:
        found: list[tuple[int, int]] = []
        matched: dict[int, int] = {}      # letters of `wanted` matched -> the earliest start that did
        for i, letter in enumerate(key):
            moved: dict[int, int] = {}
            for count, start in matched.items():
                if letter == wanted[count] and moved.get(count + 1, start) >= start:
                    moved[count + 1] = start
                if skippable[i] and moved.get(count, start) >= start:
                    moved[count] = start
            if letter == wanted[0] and 1 not in moved:
                moved[1] = origin[i]
            if len(wanted) in moved:
                found.append((moved.pop(len(wanted)), origin[i] + 1))
            matched = moved
        return found

    spans = []
    for document_id, canary in canaries.items():
        wanted = labels.canary_key(canary)
        merged: list[tuple[int, int]] = []
        for start, end in sorted(places(wanted) if wanted else []):
            if merged and start < merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        spans.extend((document_id, start, end) for start, end in merged)
    return spans


# Canaries that share most of their characters, the same canary on two documents, and canaries whose
# letters and digits begin another's, so one pass must keep every canary's places apart.
NEIGHBOURS = {"doc-a": "cdk-0123456789abcdef", "doc-b": "cdk-0123456789abcdee", "doc-c": "cdk-0123456700000000",
              "doc-d": "cdk-fedcba9876543210", "doc-e": "cdk-0123456789abcdef", "doc-f": "cdk-01",
              "doc-g": "cdk-0123456789abcdef0", "doc-h": "CDK-0123-4567", "doc-i": "--", "doc-j": "dk-01"}


def pieces(rng: random.Random) -> str:
    """A piece of text for `test_one_pass_finds_what_each_canary_finds_alone`: a canary as written,
    disguised or cut short, or the letters, digits, separators, accented and lookalike characters
    and combining marks that may lie between a canary's characters or break it."""
    canary = rng.choice(list(NEIGHBOURS.values()))
    choices = [
        lambda: canary, lambda: canary[:rng.randrange(1, len(canary) + 1)],
        lambda: rng.choice(disguises(canary)) if canary.startswith("cdk-") and len(canary) == 20 else canary.upper(),
        lambda: rng.choice(" -. –/"), lambda: rng.choice("éñÇáḃасеЗбȢ"),
        lambda: rng.choice("̧́ଃ"), lambda: rng.choice("0123456789abcdefkx"),
        lambda: "".join(rng.choice("0123456789abcdef") for _ in range(rng.randrange(1, 6))),
    ]
    return rng.choice(choices)()


def test_one_pass_finds_what_each_canary_finds_alone():
    """Reading the text once for every canary finds, for each document, the same places mapped onto
    the same characters as looking for its canary alone, whatever lies between a canary's
    characters, however many canaries share their first characters, and when the letters and
    digits of one canary begin another's."""
    rng = random.Random(7)
    for _ in range(400):
        text = "".join(pieces(rng) for _ in range(rng.randrange(1, 40)))
        canaries = dict(rng.sample(list(NEIGHBOURS.items()), rng.randrange(1, len(NEIGHBOURS) + 1)))
        assert labels.canary_spans(text, canaries) == one_canary_at_a_time(text, canaries), (text, canaries)
    # every disguise of every canary is still found, each in its one place
    for document_id, canary in NEIGHBOURS.items():
        if canary.startswith("cdk-") and len(canary) == 20:
            for disguised in disguises(canary):
                text = f"Reference: {disguised}."
                found = labels.canary_spans(text, NEIGHBOURS)
                assert found == one_canary_at_a_time(text, NEIGHBOURS), disguised
                [(start, end)] = [(start, end) for found_id, start, end in found if found_id == document_id]
                assert (text[:start], labels.canary_key(text[end:])) == ("Reference: ", ""), disguised


def fastest(scan, runs: int = 3) -> float:
    """The fastest of `runs` timings of `scan()`, in seconds, so a busy machine doesn't count."""
    timings = []
    for _ in range(runs):
        started = time.perf_counter()
        scan()
        timings.append(time.perf_counter() - started)
    return min(timings)


def test_a_hundred_canaries_cost_about_what_one_does():
    """A text is read once for all the canaries it is scanned for: 100 KiB of text that holds every
    one of a hundred canaries cut one digit short costs at most a few times what it costs for one of
    them, where a pass per canary would cost a hundred."""
    rng = random.Random(11)
    canaries = {f"doc-{n:03d}": "cdk-" + "".join(rng.choice("0123456789abcdef") for _ in range(16)) for n in range(100)}
    near = " ".join(f"ref {canary[:-1]}x, then" for canary in canaries.values()) + " "
    text = (near * (100 * 1024 // len(near) + 1))[:100 * 1024]
    one = dict(list(canaries.items())[:1])
    assert labels.canary_spans(text, canaries) == []
    assert fastest(lambda: labels.canary_spans(text, canaries)) < 3 * fastest(lambda: labels.canary_spans(text, one))
