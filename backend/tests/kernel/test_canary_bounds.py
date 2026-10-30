"""Canary scans are bounded.

Every document's canary is looked for wherever text could carry the document out, so the cost of a
scan grows with the text and with the canaries it looks for. A scan with no canaries returns before
it reads the text; one with many reads the text once for all of them, however many there are.
"""

from desk.kernel_service import labels, reply_check


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
