import { useId } from 'react';

import type { DeskSummary } from '../../api/views.ts';
import { Card, SectionHeader } from '../../ds/index.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { VisionNote } from './VisionNote.tsx';

import './BillingPage.css';

const SAMPLE_USAGE = [
  { value: '128', label: 'Conversations' },
  { value: '41', label: 'Actions' },
  { value: '$18.40', label: 'Model spend' },
] as const;
const SAMPLE_BUDGET = '$18.40 of $50 this month';
const SAMPLE_BUDGET_PERCENT = '37%';
const SAMPLE_INVOICES = [
  { month: 'October 2026', detail: 'Oct 1 to 31 · One business, up to three Desks', amount: '$0.00' },
  { month: 'September 2026', detail: 'Sep 1 to 30 · One business, up to three Desks', amount: '$0.00' },
] as const;

/** Settings › Billing: a labelled preview with sample numbers and nothing billed. */
export function BillingPage() {
  const { business } = useOwnerDesk();
  return <BillingPreview business={business} />;
}

/** The same static preview in Settings and its signed board stories. */
export function BillingPreview({ business }: { business: { name: string; desks: readonly Pick<DeskSummary, 'desk_id' | 'name'>[] } }) {
  const usageId = useId();
  const budgetId = useId();
  const invoicesId = useId();
  const capacity = business.desks.length === 1
    ? 'Up to two more Desks on this plan.'
    : business.desks.length === 2 ? 'Up to one more Desk on this plan.' : null;

  return (
    <div className="cd-billing">
      <VisionNote>Nothing is billed in this prototype. The usage and invoices below are samples.</VisionNote>
      <Card as="section" label="Plan" padding={16}>
        <h2 className="cd-type-section">Plan</h2>
        <p className="cd-billing__plan-line cd-type-body">One business, up to three Desks.</p>
        <p className="cd-billing__plan-line cd-billing__quiet cd-type-meta">Free while Claude Desk is a prototype.</p>
      </Card>
      <section aria-labelledby={usageId} className="cd-billing__section">
        <SectionHeader id={usageId} title="Usage this month" caption="Nov 1 to 30" />
        <Card padding={0}>
          {business.desks.map((desk) => (
            <div className="cd-billing__row cd-billing__usage" key={desk.desk_id}>
              <div className="cd-billing__names">
                <p className="cd-type-body" data-copy="user">{desk.name}</p>
                <p className="cd-billing__business cd-billing__quiet cd-type-meta" data-copy="user">{business.name}</p>
              </div>
              {SAMPLE_USAGE.map(({ value, label }) => (
                <div className="cd-billing__stat" key={label}>
                  <p className="cd-billing__number cd-type-body">{value}</p>
                  <p className="cd-billing__quiet cd-type-meta">{label}</p>
                </div>
              ))}
            </div>
          ))}
          {capacity ? <div className="cd-billing__row"><p className="cd-billing__quiet cd-type-meta">{capacity}</p></div> : null}
        </Card>
      </section>
      <section aria-labelledby={budgetId} className="cd-billing__section">
        <SectionHeader id={budgetId} title="Budget" />
        <Card padding={16}>
          <div className="cd-billing__budget-labels">
            <p className="cd-type-body">Model spend</p>
            <p className="cd-billing__number cd-billing__quiet cd-type-meta">{SAMPLE_BUDGET}</p>
          </div>
          <div className="cd-billing__budget-track" aria-hidden="true">
            <div className="cd-billing__budget-fill" style={{ width: SAMPLE_BUDGET_PERCENT }} />
          </div>
        </Card>
      </section>
      <section aria-labelledby={invoicesId} className="cd-billing__section">
        <SectionHeader id={invoicesId} title="Invoices" />
        <Card padding={0}>
          {SAMPLE_INVOICES.map(({ month, detail, amount }) => (
            <div className="cd-billing__row cd-billing__invoice" key={month}>
              <div>
                <p className="cd-type-body">{month}</p>
                <p className="cd-billing__quiet cd-type-meta">{detail}</p>
              </div>
              <p className="cd-billing__number cd-type-body">{amount}</p>
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}
