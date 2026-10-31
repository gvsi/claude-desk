import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { SIGNED_LIMIT_COPY } from './signedLimitCopy.ts';

import './SignedLimitPanel.css';

export interface SignedLimitPanelProps {
  /** The most one charge can be, in the page's words: "$20". The mandate's `per_charge_cents`. */
  perCharge: string;
  /** The most its charges can add up to, in the page's words: "$100". The mandate's `total_cents`. */
  total: string;
  /** How long the limit lasts, in the page's words: "One hour". The mandate's lifetime. */
  duration: string;
  /** Whose wallet signed it, in the page's words: "Signed limit from Alex Kim’s demo wallet". */
  source: string;
  /** The page's language: the panel's own words and its `lang`. */
  language: CopyLanguage;
}

/**
 * A visiting agent's signed spending limit: what one charge can be, what its charges can add up to,
 * how long the limit lasts, and whose wallet signed it. Every value is the page's own static words
 * for the signed mandate, never Claude's; the panel only lays them out. A blank value draws no
 * panel at all, so it never shows part of a limit.
 */
export function SignedLimitPanel({ perCharge, total, duration, source, language }: SignedLimitPanelProps) {
  if ([perCharge, total, duration, source].some((value) => value.trim() === '')) return null;
  const copy = SIGNED_LIMIT_COPY[language];
  const terms: [string, string][] = [
    [copy.perCharge, perCharge],
    [copy.total, total],
    [copy.duration, duration],
  ];
  return (
    <section className="cd-signed-limit" aria-label={copy.region} lang={language}>
      <dl className="cd-signed-limit__terms">
        {terms.map(([name, value]) => (
          <div key={name} className="cd-signed-limit__term">
            <dt className="cd-signed-limit__name cd-type-caption">{name}</dt>
            <dd className="cd-signed-limit__value cd-type-body">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="cd-signed-limit__source cd-type-caption">{source}</p>
    </section>
  );
}
