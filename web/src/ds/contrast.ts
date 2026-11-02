// WCAG 2.2 contrast for the design tokens: every color pair the components use is
// listed once in CONTRAST_PAIRS, with ratios computed from tokens.json in each theme it is
// drawn in, and every color token is either in a pair, in DECORATIVE_COLORS with the
// reason, or in ON_BRAND_COLORS, checked on the owner's colour.

import tokens from './tokens.json' with { type: 'json' };

type Rgba = { r: number; g: number; b: number; a: number };

export type ContrastPair = {
  /** The text or mark color token. */
  readonly fg: string;
  /** The color token it sits on. */
  readonly ground: string;
  /** A different fill under the foreground, such as the selected thumb beside its track. */
  readonly fgGround?: string;
  /** What the ground sits on: an opaque token, or a translucent one with `under` beneath it. */
  readonly over?: string;
  /** The opaque token under a translucent `over`, such as the app under a card's fill. */
  readonly under?: string;
  /** The control's own opacity when it is drawn faded as a whole: its label and fill fade together over `over`. */
  readonly opacity?: number;
  /** 4.5:1 for text; 3:1 for focus edges, dots, the mark and text at 24 px and up. */
  readonly min: 4.5 | 3;
  readonly use: string;
  /** The themes the pair is drawn in, when it isn't drawn in both. */
  readonly themes?: readonly Theme[];
};

export type Theme = 'dark' | 'light';

/** The themes every pair is checked in, unless it names its own. */
export const THEMES: readonly Theme[] = Object.freeze(['dark', 'light']);

/**
 * Each theme's color values. Light takes a token's light value, or its dark one where it has none,
 * as the CSS inherits it; an alias then resolves against the light values.
 */
const COLORS: Readonly<Record<Theme, ReadonlyMap<string, string>>> = {
  dark: new Map(tokens.color.tokens.map((t) => [t.name, t.value.dark])),
  light: new Map(tokens.color.tokens.map((t) => [t.name, t.value.light ?? t.value.dark])),
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUM = String.raw`\s*(\d+(?:\.\d+)?)\s*`;
const RGB = new RegExp(`^rgba?\\(${NUM},${NUM},${NUM}(?:,${NUM})?\\)$`, 'i');
const ALIAS = /^\{([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\}$/;
const VAR = /^var\(\s*--([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\s*\)$/;

function parseColor(input: string, theme: Theme, depth = 0): Rgba {
  if (depth > 16) throw new Error(`Color alias chain is too deep at ${input}`);
  const color = input.trim();
  // A ghost control's own ground: nothing, so only its label is drawn.
  if (color === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const colors = COLORS[theme];
  const named = ALIAS.exec(color)?.[1] ?? VAR.exec(color)?.[1] ?? (colors.has(color) ? color : undefined);
  if (named !== undefined) {
    const value = colors.get(named);
    if (value === undefined) throw new Error(`Unknown color token: ${input}`);
    return parseColor(value, theme, depth + 1);
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

/**
 * An opaque color token's value as `#rrggbb`, its aliases followed, for code that must hand a color
 * to something that reads no CSS, such as the web app's QR code. Throws on a translucent token.
 */
export function tokenHex(name: string): string {
  const { r, g, b, a } = parseColor(name, 'dark');
  if (a !== 1) throw new Error(`${name} is not an opaque color`);
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** `top` alpha-composited over `bottom` (source-over); over an opaque `bottom` the result is opaque. */
function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = bottom.a === 1 ? 1 : top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * WCAG contrast of a pair as it is drawn. Each color is a color token name, a `{token}` alias, a
 * `var(--token)`, a hex color, an `rgb()`/`rgba()` color or `transparent`. The ground sits on
 * `over`, and a translucent `over` on an opaque `under`; at an `opacity` under 1 the label and the
 * ground fade together over what is beneath them. Throws on anything it can't read, and on layers
 * that don't end on something opaque. `fgGround` names the fill under the foreground when it
 * differs from the adjacent ground, as an inset thumb edge beside its track does. Tokens read their values in `theme`, dark unless asked.
 */
export function pairContrast(
  { fg, ground, fgGround, over, under, opacity = 1 }: Omit<ContrastPair, 'min' | 'use' | 'themes'>,
  theme: Theme = 'dark',
): number {
  if (under !== undefined && over === undefined) throw new Error(`${under} is under nothing; name the layer it sits under as over`);
  if (!(opacity > 0 && opacity <= 1)) throw new Error(`opacity ${opacity} is not in (0, 1]`);
  let beneath: Rgba | undefined;
  if (over !== undefined) {
    beneath = parseColor(over, theme);
    if (under !== undefined) {
      const base = parseColor(under, theme);
      if (base.a !== 1) throw new Error(`${under} is translucent; contrast needs an opaque color underneath`);
      beneath = composite(beneath, base);
    }
    if (beneath.a !== 1) throw new Error(`${over} is translucent; contrast needs an opaque color underneath`);
  }
  if (opacity !== 1 && beneath === undefined) throw new Error(`a control at opacity ${opacity} needs what it sits on as over`);

  const groundColor = parseColor(ground, theme);
  const fade = (c: Rgba): Rgba => ({ ...c, a: c.a * opacity });
  const label = fade(composite(parseColor(fg, theme), fgGround === undefined ? groundColor : parseColor(fgGround, theme)));
  const fill = fade(groundColor);
  const back = beneath === undefined ? fill : composite(fill, beneath);
  if (back.a !== 1) throw new Error(`${ground} is translucent; pass the opaque color it sits over`);
  // The control fades as one: under its label is only what's beneath it, not its faded fill
  // again. Compositing is associative, so at full opacity this is the label over the fill.
  const front = beneath === undefined ? label : composite(label, beneath);
  const [light, dark] = [luminance(front), luminance(back)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * WCAG contrast ratio of `fg` on `ground`, as `pairContrast` measures it in the dark theme: a
 * translucent `ground` over `over`, and a translucent `over` over `under`.
 */
export function contrastRatio(fg: string, ground: string, over?: string, under?: string): number {
  return pairContrast({ fg, ground, over, under });
}

function pairs(
  fgs: readonly string[],
  grounds: readonly string[],
  min: 4.5 | 3,
  use: string,
  over?: string,
  beneath: Pick<ContrastPair, 'under' | 'opacity' | 'themes'> = {},
): ContrastPair[] {
  return fgs.flatMap((fg) =>
    grounds.map((ground) => ({ fg, ground, ...(over === undefined ? {} : { over }), ...beneath, min, use })),
  );
}

const TEXT = ['text-primary', 'text-secondary', 'text-tertiary', 'accent-blue'] as const;

const MARKS = ['accent-blue', 'line-focus', 'status-handled', 'status-held', 'status-refused', 'status-info'] as const;
const SURFACES = ['bg-app', 'bg-panel', 'bg-surface', 'bg-selected'] as const;
/** Where the mark sits without its tile: a page, the sidebar and the phone top bar, and the intro dialog. */
const MARK_GROUNDS = ['bg-app', 'bg-panel', 'bg-surface'] as const;

export const CONTRAST_PAIRS: readonly ContrastPair[] = Object.freeze([
  ...pairs(TEXT, ['bg-app', 'bg-panel', 'bg-surface', 'bg-muted', 'bg-selected'], 4.5, 'Text and links on the app, panels, raised surfaces, quiet fills and the selected row.'),
  ...pairs(TEXT, ['fill-card', 'fill-bubble', 'fill-count', 'fill-hover', 'fill-secondary'], 4.5, "Text and links in cards, bubbles, count pills, hovered rows and secondary buttons on the app background, a busy secondary button's text-secondary label included.", 'bg-app'),
  ...pairs(TEXT, ['fill-secondary', 'fill-hover'], 4.5, "Text and links on secondary buttons and hovered rows inside the composer, menus and dialogs, a busy secondary button's text-secondary label included.", 'bg-surface'),
  ...pairs(['text-primary', 'text-secondary'], ['fill-secondary-hover'], 4.5, 'Text on a hovered secondary button on the app background.', 'bg-app'),
  ...pairs(['text-primary', 'text-secondary'], ['fill-secondary-hover'], 4.5, 'Text on a hovered secondary button inside the composer and menus.', 'bg-surface'),
  ...pairs(['button-primary-text'], ['button-primary', 'button-primary-hover'], 4.5, 'Text on the primary button, at rest, on hover and while busy.'),
  ...pairs(MARKS, SURFACES, 3, 'Focus edges and status dots on the app, panels, raised surfaces and the selected row.'),
  ...pairs(MARKS, ['fill-card'], 3, 'Focus edges and status dots inside cards.', 'bg-app'),
  ...pairs(MARKS, ['fill-hover'], 3, 'Focus edges and status dots on a hovered conversation or attempt row.', 'bg-app'),
  ...pairs(['line-focus'], ['bg-muted'], 3, "The focus edge inside the reviewer bar's Start over."),
  ...pairs(['line-focus'], ['fill-hover'], 3, 'The focus edge just inside a menu item that has focus, on its hover fill in a menu.', 'bg-surface'),
  ...pairs(['line-focus'], ['fill-hover'], 3, 'The focus edge just inside a sidebar row that has focus while it is hovered.', 'bg-panel'),
  ...pairs(
    ['line-focus'],
    ['fill-secondary', 'fill-secondary-hover', 'button-danger-fill', 'button-danger-fill-hover'],
    3,
    'The focus edge just inside a secondary or danger button on a page, at rest and hovered.',
    'bg-app',
  ),
  ...pairs(
    ['line-focus'],
    ['fill-secondary', 'fill-secondary-hover', 'button-danger-fill', 'button-danger-fill-hover'],
    3,
    "The focus edge just inside a secondary or danger button in a card, such as a held request's answers, at rest and hovered.",
    'fill-card',
    { under: 'bg-app' },
  ),
  ...pairs(['line-focus'], ['fill-secondary', 'fill-secondary-hover'], 3, 'The focus edge just inside a secondary button in a dialog or a menu, at rest and hovered.', 'bg-surface'),
  ...pairs(['bg-app'], ['button-primary', 'button-primary-hover'], 3, "The primary button's focus edge, 2 px of the page's own dark just inside its fill, at rest and hovered."),
  ...pairs(
    ['mark-ink-light', 'mark-clay'],
    MARK_GROUNDS,
    3,
    "The Claude Desk mark without its tile, its light ink and clay dome: on a page and in the public page's footer, in the sidebar and the phone top bar, and at the top of the first-visit intro dialog. On the light theme's paper the ink is mark-ink, and the dome is exempt (LIGHT_THEME_EXEMPTIONS).",
    undefined,
    { themes: ['dark'] },
  ),
  ...pairs(
    ['mark-ink'],
    MARK_GROUNDS,
    3,
    "The same mark on the light theme's paper, where its ink is the drawing's dark ink.",
    undefined,
    { themes: ['light'] },
  ),
  ...pairs(['mark-ink'], ['illustration-card'], 3, "The mark's dark ink, without its tile, on the intro illustration's light reply card."),
  ...pairs(['mark-tile'], ['bg-app'], 3, "The mark's white tile on the app's ground, as the design system's stories show it alone.", undefined, { themes: ['dark'] }),
  ...pairs(['mark-ink', 'mark-clay'], ['mark-tile'], 3, "The mark's drawing on its tile: the ink, and the clay dome."),
  ...pairs(['mark-ink'], ['mark-clay'], 3, "The mark's dark ink where it crosses the clay dome, on its tile and on the intro's light card."),
  ...pairs(['clay'], ['bg-app'], 3, "Claude's writing dots on the page, and the About pages' app icon: its clay field, the icon's edge, on the page."),
  ...pairs(['clay'], ['bg-panel'], 3, "Claude's writing dots in the Ask Claude panel."),
  ...pairs(['button-primary'], ['bg-app', 'bg-panel'], 3, 'The switch track when on, on a page and in the sidebar.'),
  ...pairs(['bg-app'], ['button-primary'], 3, 'The switch knob when on, against its track.'),
  ...pairs(['text-secondary'], ['fill-secondary'], 3, 'The switch knob when off, against its track in the sidebar.', 'bg-panel'),
  ...pairs(['text-primary', 'text-secondary'], ['fill-hover'], 4.5, "The switch row's label and description while it is hovered in the sidebar.", 'bg-panel'),
  ...pairs(TEXT, ['fill-card'], 4.5, "Text and links in reply cards in the public page's about column.", 'bg-panel'),
  ...pairs(MARKS, ['fill-card'], 3, "Focus edges and status marks in reply cards in the public page's about column.", 'bg-panel'),
  ...pairs(['text-secondary'], ['fill-count'], 4.5, "Count pills on the sidebar's nav rows.", 'bg-panel'),
  ...pairs(['text-secondary'], ['fill-count'], 4.5, "A count pill on the sidebar's current nav row.", 'bg-selected'),
  ...pairs(['text-primary'], ['fill-hover'], 4.5, "The reviewer bar's Start over button while it is hovered.", 'bg-muted'),
  ...pairs(['text-primary'], ['fill-bubble'], 4.5, "The owner's words in a bubble in the Ask Claude panel.", 'bg-panel'),
  ...pairs(['text-primary'], ['fill-card'], 4.5, "The passcode typed into the intro dialog's field.", 'bg-surface'),
  ...pairs(['illustration-ink', 'illustration-ink-secondary'], ['illustration-card'], 4.5, "Names, messages and meta lines on the intro illustration's light cards."),
  ...pairs(['illustration-ink'], ['illustration-avatar'], 4.5, 'The initials on an intro illustration card.'),
  ...pairs(['illustration-handled'], ['illustration-card'], 3, "The check and the receipt dots on the intro illustration's light cards."),
  ...pairs(['qr-ink'], ['qr-tile'], 3, "The QR code's dark modules on its sand tile, on Share's printable card."),
  ...pairs(['line-field'], ['bg-surface', 'bg-app'], 3, "A text field's outline, its boundary, on a dialog or a page."),
  ...pairs(['line-focus'], ['bg-surface', 'bg-app'], 3, "A text field's 2 px focused edge against its ground, on a dialog or a page."),
  ...['bg-app', 'bg-panel', 'bg-surface'].map((over): ContrastPair => ({
    fg: 'line-focus', fgGround: 'bg-selected', ground: 'fill-count', over, min: 3,
    use: "The selected segmented thumb's inset edge against its track; the fill beneath the edge is the thumb's, not the track's.",
  })),
  ...pairs(['line-field'], ['fill-card'], 3, "The outline of an inline CopyField's value, such as the agents page's address, in a card.", 'bg-app'),
  ...pairs(['button-danger-text'], ['button-danger-fill', 'button-danger-fill-hover'], 4.5, 'A danger button in a card, such as Deny this time on a held request, at rest and on hover.', 'fill-card', { under: 'bg-app' }),
  ...pairs(['button-danger-text'], ['fill-card'], 4.5, 'A danger-ghost button in a card: a refusal in red words with no fill.', 'bg-app'),
  ...pairs(['button-danger-text'], ['fill-hover'], 4.5, 'A danger-ghost button in a card while it is hovered.', 'fill-card', { under: 'bg-app' }),
  ...pairs(['button-danger-text'], ['bg-app'], 4.5, 'A danger-ghost button on the app background.'),
  ...pairs(['button-danger-text'], ['button-danger-fill', 'button-danger-fill-hover', 'fill-hover'], 4.5, 'Danger and danger-ghost buttons on the app background, at rest and on hover.', 'bg-app'),
  // A busy button's pairs are listed only for a page, a card on it and a dialog, and for a ghost
  // button the sidebar and the reviewer bar: every Button sits on one. Its spinner's arc is drawn in
  // the busy label color at full strength, so these 4.5:1 pairs cover it too, where a graphic needs
  // 3:1 (tokens.test.ts requires them at 3:1 for the spinner). None is listed on bg-selected,
  // where a busy secondary label would read 4.45 and a busy danger one 3.98; the guard
  // no_button_on_the_selected_ground (guards.test.ts) keeps Buttons off that ground.
  ...pairs(['text-secondary'], ['fill-secondary'], 4.5, "A busy secondary answer in a card: its text-secondary label on the button's fill.", 'fill-card', { under: 'bg-app' }),
  ...pairs(['text-secondary', 'accent-blue'], ['fill-card'], 4.5, "Who an entry went to, an owner's time, and the link under an owner's alert, in the Demo inbox's entries inside its sheet.", 'bg-surface'),
  ...pairs(MARKS, ['fill-card'], 3, "Focus edges and status dots in the Demo inbox's entries inside its sheet.", 'bg-surface'),
  ...pairs(['text-primary'], ['fill-secondary'], 4.5, "Try again on an entry that failed to open, inside the Demo inbox's sheet.", 'fill-card', { under: 'bg-surface' }),
  ...pairs(['text-secondary'], ['fill-count'], 4.5, "The count on the Demo inbox's button.", 'fill-secondary', { under: 'bg-app' }),
  ...pairs(['text-primary'], ['fill-secondary'], 4.5, "Code in a card on the agents page: a CodeBlock or a CopyField's box, and a secondary button's label beside it.", 'fill-card', { under: 'bg-app' }),
  ...pairs(['text-primary', 'text-secondary'], ['fill-card'], 4.5, "An agent's signed limit in the agents page's \"Send an agent\" card: its amounts, their names and whose wallet signed it, on its own fill over the card's.", 'fill-card', { under: 'bg-app' }),
  ...pairs(['button-danger-text'], ['bg-surface'], 4.5, "Deny's answers in its menu on a held request, This time and Always, in red words on the raised surface."),
  ...pairs(['button-danger-text'], ['fill-hover'], 4.5, "Deny's answers in its menu while one is hovered or has focus.", 'bg-surface'),
]);

/**
 * The pairs the light theme draws below their minimum, and why each is allowed: the mark is a logo,
 * which WCAG exempts, so its clay dome and its lone tile are drawn as they are on the paper. Each
 * is listed for the dark theme, where it holds.
 */
export const LIGHT_THEME_EXEMPTIONS: readonly { readonly fg: string; readonly ground: string; readonly reason: string }[] = Object.freeze([
  ...MARK_GROUNDS.map((ground) => ({
    fg: 'mark-clay',
    ground,
    reason: "The mark's clay dome on the paper, 2.6 to 3.0:1: the logo's own color, and its dark ink lines, 16.8:1 and up, set the bell off the ground.",
  })),
  {
    fg: 'mark-tile',
    ground: 'bg-app',
    reason: "The mark's white tile alone on the paper, as only the design system's stories draw it: the app shows the tile inside the app icon, on its clay field, and the drawing on the tile carries its own contrast.",
  },
]);

/**
 * The colours drawn on an owner's chosen colour, each with the minimum it keeps there: 4.5:1 for
 * words, 3:1 for a status dot. That colour isn't a token, so no pair here can list it: it is checked
 * against these where it is chosen, and every colour of the owner's palette is tested for them.
 */
export const ON_BRAND_COLORS: Readonly<Record<string, { readonly min: 4.5 | 3; readonly use: string }>> = Object.freeze({
  'text-on-brand': {
    min: 4.5,
    use: "The names on an owner's chosen colour, in the public header and Profile's header-colour preview. A colour is used only where it keeps 4.5:1 with both inks.",
  },
  'text-on-brand-secondary': { min: 4.5, use: "The second line on an owner's chosen colour, checked with text-on-brand." },
  'status-handled-on-brand': {
    min: 3,
    use: "The open-status dot on an owner's chosen colour in the public header, beside the words that say the business is open.",
  },
});

export const DECORATIVE_COLORS: Readonly<Record<string, string>> = Object.freeze({
  'line-hairline': 'A seam between regions that already differ in fill; it carries no meaning of its own.',
  'line-card': "A card's edge; the card's content, not its border, is what a person reads.",
  'line-control':
    "A chip or outlined pill's outline, or the recorded-history link's underline, 2.0:1 on the app background in the dark theme and 1.6:1 in the light one: flagged, because the control's own text identifies it.",
  'line-control-hover': 'The hover state of those outlines; the pointer is already on the control.',
  scrim: 'It dims the page behind a dialog that blocks it; no text or control sits on it.',
  clay: "The field behind the intro illustration's light cards and behind the app icon's white tile; nothing is read on it, and the cards and the tile carry their own contrast. As the icon's edge it is listed against the page.",
  'mark-hairline': "The edge of the mark's tile in the About pages' app icon; the tile itself carries the mark's contrast.",
  'illustration-line': "The booked box's outline on an intro illustration card; the words inside it say what it is.",
  'illustration-arc': "Two soft arcs on the intro illustration's clay field, behind the cards; they carry nothing.",
  'qr-hairline': "The inset edge of the QR code's sand tile; the code's modules carry its contrast.",
  'connector-stripe': 'A third-party brand mark beside its name; nothing is read on it.',
  'connector-google-blue': 'A third-party brand mark beside its name; nothing is read on it.',
});
