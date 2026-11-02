// Types for build-tokens.mjs, so TypeScript callers (the token tests) get a checked signature.

export interface TokenEntry {
  name: string;
  value: string;
  usage: string;
}

/**
 * A color or shadow token: a value per theme. Dark is required; light, when the token has one,
 * overrides it in the light theme.
 */
export interface ThemedValues {
  dark: string;
  light?: string | undefined;
}

export interface ThemedToken {
  name: string;
  value: ThemedValues;
  usage: string;
}

export type ColorToken = ThemedToken;

export interface TypeStyle {
  name: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  /** `italic`, for a reading page's quotations; the builder refuses any other value. */
  fontStyle?: string;
  letterSpacing?: string;
  /** `uppercase`, only on `badge-caps`, the lockup's "Preview" badge; the builder refuses anything else. */
  textTransform?: string;
  /** `tabular-nums`, for figures that line up; the builder refuses any other value. */
  fontVariantNumeric?: string;
  opticalSize?: number;
  family?: string;
  usage?: string;
}

export interface DesignTokens {
  name: string;
  version: number;
  color: { themes: { id: string; name: string }[]; tokens: ColorToken[] };
  type: {
    fonts: unknown[];
    families: Record<string, string>;
    groups: { name: string; family: string; styles: TypeStyle[] }[];
  };
  spacing: { tokens: TokenEntry[] };
  radius: { tokens: TokenEntry[] };
  size: { tokens: TokenEntry[] };
  shadow: { tokens: ThemedToken[] };
  motion: { note?: string; tokens: TokenEntry[] };
}

/** The tokens.css text for a tokens object in the design system's list shape; throws on an invalid token. */
export function buildTokensCss(tokens: DesignTokens): string;
