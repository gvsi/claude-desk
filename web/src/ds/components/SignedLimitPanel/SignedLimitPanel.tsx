import './SignedLimitPanel.css';

export interface SignedLimitPanelProps {
  /** The most one charge can be, in whole cents: the signed mandate's `per_charge_cents`. */
  perChargeCents: number;
  /** The most its charges can add up to, in whole cents: the signed mandate's `total_cents`. */
  totalCents: number;
  /**
   * What its charges have used so far, in whole cents, summed by the screen from the charges the
   * ledger records against this mandate. The owner's view of an agent's conversation shows it; the
   * agents page doesn't.
   */
  usedCents?: number;
  /**
   * Writes an amount in cents as the page writes money: the web app's `formatCents` ("$20",
   * "$40.50"). The design system formats no money itself.
   */
  formatCents: (cents: number) => string;
  /** How long the limit lasts, from the mandate's lifetime, in the page's words: "One hour". */
  duration: string;
  /** Whose wallet signed it, in the page's words: "Signed limit from Alex Kim’s demo wallet". */
  source: string;
}

/** True for an amount the panel can show exactly: a whole number of cents, zero or more. */
function isWholeCents(cents: number | undefined): cents is number {
  return Number.isInteger(cents) && (cents as number) >= 0;
}

/**
 * A visiting agent's signed spending limit: what one charge can be, what its charges can add up to
 * (and, for the owner, what they have used), how long the limit lasts, and whose wallet signed it.
 * Every amount is the mandate's own whole cents, written by the page's formatter; an amount that
 * isn't whole cents draws no panel at all, so no limit is ever shown that the mandate doesn't hold.
 */
export function SignedLimitPanel({ perChargeCents, totalCents, usedCents, formatCents, duration, source }: SignedLimitPanelProps) {
  const amounts = [perChargeCents, totalCents, ...(usedCents === undefined ? [] : [usedCents])];
  if (!amounts.every(isWholeCents)) return null;
  const terms: [string, string][] = [
    ['Per charge', formatCents(perChargeCents)],
    ['In total', formatCents(totalCents)],
    ...(usedCents === undefined ? [] : ([['Used', formatCents(usedCents)]] as [string, string][])),
    ['For', duration],
  ];
  return (
    <section className="cd-signed-limit" aria-label="Signed limit">
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
