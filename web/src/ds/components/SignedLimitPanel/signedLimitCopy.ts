import type { CopyLanguage } from '../Notice/errorCopy.ts';

/** The panel's own words in each language a visitor reads: its name and the names of its terms. */
export const SIGNED_LIMIT_COPY = {
  en: { region: 'Signed limit', perCharge: 'Per charge', total: 'In total', used: 'Used', duration: 'For' },
  es: { region: 'Límite firmado', perCharge: 'Por cargo', total: 'En total', used: 'Usado', duration: 'Durante' },
} as const satisfies Record<CopyLanguage, { region: string; perCharge: string; total: string; used: string; duration: string }>;
