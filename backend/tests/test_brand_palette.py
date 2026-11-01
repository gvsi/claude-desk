"""A Desk's brand colour, picked from a fixed palette.

The owner picks a key (`BrandPalette`) and the colours come only from the code-owned table
(`BRAND_PALETTE`), so every pick keeps the public page's header readable. The web draws the
header's field from `primary` only when both of its text tokens keep 4.5:1 over it
(web/src/public/brand.ts), so this pins every primary to that bar with the tokens it reads.
"""

import json
import re
from pathlib import Path
from typing import get_args

import pytest

from desk.contracts import BRAND_PALETTE, DEFAULT_BRAND_PALETTE, BrandPalette

TOKENS = Path(__file__).resolve().parents[2] / "web" / "src" / "ds" / "tokens.json"
HEADER_INKS = ("text-primary", "text-secondary")   # brand.ts's INK and INK_SECONDARY, over the field
MIN_TEXT_CONTRAST = 4.5                             # WCAG AA for text, brand.ts's MIN_TEXT_CONTRAST
HEX = re.compile(r"#[0-9A-F]{6}")
RGBA = re.compile(r"rgba\((\d+),(\d+),(\d+),([0-9.]+)\)")


def test_the_palette_is_six_keys_in_display_order():
    keys = ("teal", "navy", "forest", "plum", "rust", "slate")
    assert get_args(BrandPalette) == keys
    assert tuple(BRAND_PALETTE) == keys
    assert DEFAULT_BRAND_PALETTE == "teal"
    assert BRAND_PALETTE["teal"] == {"primary": "#1F4E4A", "accent": "#B87333"}   # Rivera's colours
    for key, colours in BRAND_PALETTE.items():
        assert set(colours) == {"primary", "accent"}, key
        assert all(HEX.fullmatch(value) for value in colours.values()), key
    assert len({colours["primary"] for colours in BRAND_PALETTE.values()}) == len(keys)


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


@pytest.mark.parametrize("key", get_args(BrandPalette))
def test_every_primary_keeps_the_header_text_readable(key):
    for name, ink in header_inks().items():
        assert contrast(ink, BRAND_PALETTE[key]["primary"]) >= MIN_TEXT_CONTRAST, (key, name)
