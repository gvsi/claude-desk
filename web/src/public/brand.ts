/**
 * The business's look on its public page, read from the Desk the kernel serves (`PublicDesk`).
 * Brand colors come from the business, so each one is used only as a plain `#rrggbb`, and the
 * header's field only when the shell's text stays readable over it. Anything else falls back to a
 * design token: the page never shows a color it can't vouch for.
 */
import type { PublicDesk } from '../api/contracts.ts';
import { contrastRatio } from '../ds/contrast.ts';
import type { PublicBrand } from '../ds/index.ts';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The shell's text over the brand field: the design system's two text tokens. */
const INK = 'var(--text-primary)';
const INK_SECONDARY = 'var(--text-secondary)';

/** Where a brand color can't be used: the panel for the field, the hairline for the accent rule. */
const FIELD_FALLBACK = 'var(--bg-panel)';
const ACCENT_FALLBACK = 'var(--line-hairline)';

/** WCAG AA for text. */
const MIN_TEXT_CONTRAST = 4.5;

/**
 * The name setup gives a Desk whose owner gave none: the API's `OWNER_NAME_FALLBACK`
 * (backend/desk/api/setup.py), which a unit test keeps equal to this one. `PublicDesk` has no
 * field that says no name was given, so the page reads exactly this value as "no name"; a
 * contract field for it would replace this.
 */
export const OWNER_NAME_FALLBACK = 'Owner';

/** The owner's name as the Desk carries it, or null when they gave none and it carries setup's fallback. */
export function givenOwnerName(displayName: string): string | null {
  return displayName === OWNER_NAME_FALLBACK ? null : displayName;
}

export interface DeskBrand {
  brand: PublicBrand;
  /**
   * Whom a visitor can ask for: `owner_display_name` ("Mike Turner"), or null when the owner gave
   * no name and the Desk carries setup's fallback (`OWNER_NAME_FALLBACK`).
   */
  ownerName: string | null;
}

function plainHex(value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value) ? value : null;
}

/** The field when both inks keep 4.5:1 over it; a contrast check that throws counts as failing. */
function readableField(color: string | null): string {
  if (color === null) return FIELD_FALLBACK;
  try {
    const readable = [INK, INK_SECONDARY].every((ink) => contrastRatio(ink, color) >= MIN_TEXT_CONTRAST);
    return readable ? color : FIELD_FALLBACK;
  } catch {
    return FIELD_FALLBACK;
  }
}

export function brandFrom(desk: Pick<PublicDesk, 'business_name' | 'desk_name' | 'owner_display_name' | 'brand'>): DeskBrand {
  const name = desk.business_name;
  const brand: Record<string, unknown> = desk.brand ?? {};
  return {
    brand: {
      name,
      tagline: desk.desk_name,
      monogram: Array.from(name.trim())[0] ?? '',
      field: readableField(plainHex(brand.primary)),
      ink: INK,
      inkSecondary: INK_SECONDARY,
      accent: plainHex(brand.accent) ?? ACCENT_FALLBACK,
    },
    ownerName: givenOwnerName(desk.owner_display_name),
  };
}
