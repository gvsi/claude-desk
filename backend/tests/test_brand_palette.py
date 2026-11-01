"""A Desk's brand colour, picked from a fixed palette.

The owner picks a key (`BrandPalette`) and the colours come only from the code-owned table
(`BRAND_PALETTE`), so every pick keeps the public page's header readable. "none" is a pick too, of
no colours: the neutral header. Header contrast is pinned by the web unit tests.

A business write either picks a key (`brand_palette`, with an empty `brand`) or passes a brand as
before; a brand passed back with a `palette` key (setup's renames send the stored one) names one of
the table's keys, and the kernel stores the table's colours for it, whatever colours came with it.
Reads serve `effective_brand`: a pick's table colours, a free-form brand as stored, and teal for
a Desk that has stored nothing.
"""

import re
from typing import get_args

import pytest
from pydantic import ValidationError

from desk.contracts import (BRAND_PALETTE, DEFAULT_BRAND_PALETTE, BrandPalette, BusinessSeed, effective_brand,
                            stored_brand)
from desk.kernel_api import DeskBusinessRequest

HEX = re.compile(r"#[0-9A-F]{6}")
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
