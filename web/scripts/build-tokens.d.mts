// Types for build-tokens.mjs, so TypeScript callers (the token tests) get a checked signature.

export interface TokenEntry {
  name: string;
  value: string;
  usage: string;
}

export interface ColorToken {
  name: string;
  value: Record<string, string>;
  usage: string;
}

export interface TypeStyle {
  name: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  letterSpacing?: string;
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
  shadow: { tokens: TokenEntry[] };
  motion: { note?: string; tokens: TokenEntry[] };
}

/** The tokens.css text for a tokens object in the design system's list shape; throws on an invalid token. */
export function buildTokensCss(tokens: DesignTokens): string;
