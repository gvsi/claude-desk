// WCAG 2.2 contrast for the design tokens: every color pair the components use is
// listed once in CONTRAST_PAIRS, with ratios computed from tokens.json, and every
// color token is either in a pair or in DECORATIVE_COLORS with the reason.

import tokens from './tokens.json' with { type: 'json' };

type Rgba = { r: number; g: number; b: number; a: number };

export type ContrastPair = {
  /** The text or mark color token. */
  readonly fg: string;
  /** The color token it sits on. */
  readonly ground: string;
  /** The opaque token under a translucent ground. */
  readonly over?: string;
  /** 4.5:1 for text; 3:1 for focus rings, dots, the mark and text at 24 px and up. */
  readonly min: 4.5 | 3;
  readonly use: string;
};

const COLORS: ReadonlyMap<string, string> = new Map(tokens.color.tokens.map((t) => [t.name, t.value.dark]));

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUM = String.raw`\s*(\d+(?:\.\d+)?)\s*`;
const RGB = new RegExp(`^rgba?\\(${NUM},${NUM},${NUM}(?:,${NUM})?\\)$`, 'i');
const ALIAS = /^\{([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\}$/;
const VAR = /^var\(\s*--([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\s*\)$/;

function parseColor(input: string, depth = 0): Rgba {
  if (depth > 16) throw new Error(`Color alias chain is too deep at ${input}`);
  const color = input.trim();
  const named = ALIAS.exec(color)?.[1] ?? VAR.exec(color)?.[1] ?? (COLORS.has(color) ? color : undefined);
  if (named !== undefined) {
    const value = COLORS.get(named);
    if (value === undefined) throw new Error(`Unknown color token: ${input}`);
    return parseColor(value, depth + 1);
  }
  const hex = HEX.exec(color)?.[1];
  if (hex !== undefined) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    const channel = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: channel(0), g: channel(2), b: channel(4), a: full.length === 8 ? channel(6) / 255 : 1 };
  }
  const rgb = RGB.exec(color);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as [number, number, number];
    const a = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if ([r, g, b].some((v) => v > 255) || a > 1) throw new Error(`Color out of range: ${input}`);
    return { r, g, b, a };
  }
  throw new Error(`Unsupported color: ${input}`);
}

/** `top` alpha-composited over an opaque `bottom`. */
function composite(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * WCAG contrast ratio of `fg` on `ground`. Each argument is a color token name, a
 * `{token}` alias, a `var(--token)`, a hex color or an `rgb()`/`rgba()` color.
 * A translucent `ground` is composited over `over` first, and `fg` over the result.
 * Throws on anything it can't read, or a translucent ground with nothing opaque under it.
 */
export function contrastRatio(fg: string, ground: string, over?: string): number {
  let base = parseColor(ground);
  if (over !== undefined) {
    const under = parseColor(over);
    if (under.a !== 1) throw new Error(`${over} is translucent; contrast needs an opaque color underneath`);
    base = composite(base, under);
  }
  if (base.a !== 1) throw new Error(`${ground} is translucent; pass the opaque color it sits over`);
  const top = composite(parseColor(fg), base);
  const [light, dark] = [luminance(top), luminance(base)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function pairs(
  fgs: readonly string[],
  grounds: readonly string[],
  min: 4.5 | 3,
  use: string,
  over?: string,
): ContrastPair[] {
  return fgs.flatMap((fg) =>
    grounds.map((ground) => (over === undefined ? { fg, ground, min, use } : { fg, ground, over, min, use })),
  );
}

const TEXT = ['text-primary', 'text-secondary', 'text-tertiary', 'accent-blue'] as const;
const MARKS = ['accent-blue', 'ring-composer', 'status-handled', 'status-held', 'status-refused', 'status-info'] as const;
const SURFACES = ['bg-app', 'bg-panel', 'bg-surface', 'bg-selected'] as const;

export const CONTRAST_PAIRS: readonly ContrastPair[] = Object.freeze([
  ...pairs(TEXT, ['bg-app', 'bg-panel', 'bg-surface', 'bg-muted', 'bg-selected'], 4.5, 'Text and links on the app, panels, raised surfaces, quiet fills and the selected row.'),
  ...pairs(TEXT, ['fill-card', 'fill-bubble', 'fill-count', 'fill-hover', 'fill-secondary'], 4.5, 'Text and links in cards, bubbles, count pills, hovered rows and secondary buttons on the app background.', 'bg-app'),
  ...pairs(TEXT, ['fill-secondary', 'fill-hover'], 4.5, 'Text and links on secondary buttons and hovered rows inside the composer and menus.', 'bg-surface'),
  ...pairs(['text-primary', 'text-secondary'], ['fill-secondary-hover'], 4.5, 'Text on a hovered secondary button on the app background.', 'bg-app'),
  ...pairs(['text-primary', 'text-secondary'], ['fill-secondary-hover'], 4.5, 'Text on a hovered secondary button inside the composer and menus.', 'bg-surface'),
  ...pairs(['button-primary-text'], ['button-primary', 'button-primary-hover'], 4.5, 'Text on the primary button, at rest and on hover.'),
  ...pairs(MARKS, SURFACES, 3, 'Focus rings and status dots on the app, panels, raised surfaces and the selected row.'),
  ...pairs(MARKS, ['fill-card'], 3, 'Focus rings and status dots inside cards.', 'bg-app'),
  ...pairs(['clay'], ['bg-app', 'bg-panel'], 3, 'The Claude Desk mark in the sidebar and on the public page.'),
  ...pairs(['button-primary'], ['bg-app', 'bg-panel'], 3, 'The switch track when on, on a page and in the sidebar.'),
  ...pairs(['bg-app'], ['button-primary'], 3, 'The switch knob when on, against its track.'),
  ...pairs(['text-secondary'], ['fill-secondary'], 3, 'The switch knob when off, against its track in the sidebar.', 'bg-panel'),
]);

export const DECORATIVE_COLORS: Readonly<Record<string, string>> = Object.freeze({
  'line-hairline': 'A seam between regions that already differ in fill; it carries no meaning of its own.',
  'line-card': "A card's edge; the card's content, not its border, is what a person reads.",
  'line-control':
    "A chip or outlined pill's outline, 2.0:1 on the app background: flagged, because the control's own text identifies it.",
  'line-control-hover': 'The hover state of those outlines; the pointer is already on the control.',
});
