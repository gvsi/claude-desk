"""A Desk's brand colour, picked from a fixed palette.

The owner picks a key (`BrandPalette`) and the colours come only from the code-owned table
(`BRAND_PALETTE`), so every pick keeps the public page's header readable. "none" is a pick too, of
no colours: the web's neutral header. The web draws the header's field from `primary` only when
both of its text tokens keep 4.5:1 over it (web/src/public/brand.ts), so this pins every primary
to that bar with the tokens it reads.

A business write either picks a key (`brand_palette`, with an empty `brand`) or passes a brand as
before; a brand passed back with a `palette` key (setup's renames send the stored one) names one of
the table's keys, and the kernel stores the table's colours for it, whatever colours came with it.
Reads serve `effective_brand`: a pick's table colours, a free-form brand as stored, and teal for
a Desk that has stored nothing.
"""

import json
import re
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from desk.contracts import (BRAND_PALETTE, DEFAULT_BRAND_PALETTE, BrandPalette, BusinessSeed, effective_brand,
                            stored_brand)
from desk.kernel_api import DeskBusinessRequest

TOKENS = Path(__file__).resolve().parents[2] / "web" / "src" / "ds" / "tokens.json"
HEADER_INKS = ("text-primary", "text-secondary")   # brand.ts's INK and INK_SECONDARY, over the field
MIN_TEXT_CONTRAST = 4.5                             # WCAG AA for text, brand.ts's MIN_TEXT_CONTRAST
HEX = re.compile(r"#[0-9A-F]{6}")
RGBA = re.compile(r"rgba\((\d+),(\d+),(\d+),([0-9.]+)\)")
COLOURED = tuple(key for key in get_args(BrandPalette) if key != "none")


def test_the_palette_is_eight_keys_in_display_order():
    keys = ("none", "teal", "clay", "navy", "forest", "plum", "rust", "slate")
    assert get_args(BrandPalette) == keys
    assert tuple(BRAND_PALETTE) == keys
    assert DEFAULT_BRAND_PALETTE == "teal"
    assert BRAND_PALETTE["none"] == {}                                             # the web's neutral header
    assert BRAND_PALETTE["teal"] == {"primary": "#1F4E4A", "accent": "#B87333"}   # Rivera's colours
    assert BRAND_PALETTE["clay"] == {"primary": "#773624", "accent": "#D97757"}
    for key in COLOURED:
        assert set(BRAND_PALETTE[key]) == {"primary", "accent"}, key
        assert all(HEX.fullmatch(value) for value in BRAND_PALETTE[key].values()), key
    assert len({BRAND_PALETTE[key]["primary"] for key in COLOURED}) == len(COLOURED)


def _channels(color: str) -> tuple[float, float, float, float]:
    if HEX.fullmatch(color):
        return int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16), 1.0
    match = RGBA.fullmatch(color.replace(" ", ""))
    assert match is not None, color
    r, g, b, a = match.groups()
    return int(r), int(g), int(b), float(a)


def _luminance(r: float, g: float, b: float) -> float:
    def linear(v: float) -> float:
        s = v / 255
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)


def contrast(ink: str, field: str) -> float:
    """WCAG contrast of a translucent `ink` composited over an opaque `field`, as web/src/ds/contrast.ts draws it."""
    r, g, b, a = _channels(ink)
    fr, fg, fb, fa = _channels(field)
    assert fa == 1.0, field
    over = (r * a + fr * (1 - a), g * a + fg * (1 - a), b * a + fb * (1 - a))
    light, dark = sorted((_luminance(*over), _luminance(fr, fg, fb)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def header_inks() -> dict[str, str]:
    tokens = {token["name"]: token["value"]["dark"] for token in json.loads(TOKENS.read_text())["color"]["tokens"]}
    return {name: tokens[name] for name in HEADER_INKS}


def test_the_contrast_check_reads_as_the_web_does():
    # white on black is 21:1; the header's primary ink on Rivera's teal, as the web measures it
    assert contrast("#FFFFFF", "#000000") == pytest.approx(21)
    assert contrast(header_inks()["text-primary"], "#1F4E4A") == pytest.approx(7.80, abs=0.01)


@pytest.mark.parametrize("key", COLOURED)
def test_every_primary_keeps_the_header_text_readable(key):
    for name, ink in header_inks().items():
        assert contrast(ink, BRAND_PALETTE[key]["primary"]) >= MIN_TEXT_CONTRAST, (key, name)


NAMES = {"name": "Rivera Plumbing", "owner_display_name": "Maria Rivera", "timezone": "America/Los_Angeles"}


def test_a_business_write_picks_a_key_or_passes_a_brand_not_both():
    assert DeskBusinessRequest(**NAMES).brand_palette is None                      # today's writes are unchanged
    for key in get_args(BrandPalette):
        assert DeskBusinessRequest(**NAMES, brand_palette=key).brand_palette == key
    assert DeskBusinessRequest(**NAMES, brand={"primary": "#22524D"}).brand == {"primary": "#22524D"}
    assert DeskBusinessRequest(**NAMES, brand={"palette": "navy", "primary": "#000000"}).brand["palette"] == "navy"
    refused: list[dict] = [{"brand_palette": key} for key in ("magenta", "Teal", "", "#1F4E4A")]
    navy = {"palette": "navy", **BRAND_PALETTE["navy"]}
    refused += [{"brand_palette": "navy", "brand": brand}       # a pick takes its colours from the table alone
                for brand in ({"primary": "#1F3A5C"}, {"palette": "navy"}, navy)]
    refused += [{"brand_palette": "none", "brand": {"palette": "none"}}]
    refused += [{"brand": {"palette": key}} for key in ("magenta", "", "TEAL")]
    for fields in refused:
        with pytest.raises(ValidationError):
            DeskBusinessRequest(**NAMES, **fields)
    # a new Desk's business holds a passed pick to the same keys
    assert BusinessSeed(**NAMES, brand={"palette": "rust"}).brand == {"palette": "rust"}
    with pytest.raises(ValidationError):
        BusinessSeed(**NAMES, brand={"palette": "magenta"})


def test_a_stored_pick_takes_the_tables_colours():
    navy = {"palette": "navy", **BRAND_PALETTE["navy"]}
    assert stored_brand({}, "navy") == navy
    assert stored_brand({"palette": "navy", "primary": "#000000", "extra": "#123456"}) == navy   # passed back
    assert stored_brand({"primary": "#22524D"}) == {"primary": "#22524D"}                       # no pick: as sent
    assert stored_brand({}) == {}
    assert stored_brand({}, "none") == {"palette": "none"}                                       # no colours, picked
    assert stored_brand({"palette": "none", "primary": "#000000"}) == {"palette": "none"}
    assert stored_brand({}, "clay") == {"palette": "clay", "primary": "#773624", "accent": "#D97757"}
    with pytest.raises(ValueError):
        stored_brand({"palette": "magenta"})                                                     # fails closed


def test_reads_serve_a_pick_a_free_form_brand_or_teal():
    teal = {"palette": "teal", **BRAND_PALETTE["teal"]}
    assert effective_brand({}) == teal                                       # nothing stored: the default pick
    assert effective_brand({"palette": "none"}) == {"palette": "none"}       # no colours, as picked
    for key in COLOURED:                                                     # a pick: the table's colours as they are now
        assert effective_brand({"palette": key, "primary": "#000000"}) == {"palette": key, **BRAND_PALETTE[key]}
    for legacy in ({"primary": "#22524D"}, {"accent": "#C2410C"}, {"primary": "#0F3D3A", "accent": "#C2410C"}):
        assert effective_brand(legacy) == legacy                             # free-form colours, as stored
    assert effective_brand({"palette": "magenta"}) == teal                   # a key the table no longer has
