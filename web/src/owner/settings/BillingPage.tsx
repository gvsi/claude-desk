import { Card } from '../../ds/index.ts';
import { VisionNote } from './VisionNote.tsx';

/** Settings › Billing, static and marked as vision: the plan, and nothing billed. */
export function BillingPage() {
  return (
    <>
      <VisionNote>Nothing is billed in this prototype.</VisionNote>
      <Card as="section" label="Plan">
        <h2 className="cd-type-section">Plan</h2>
        <p className="cd-settings__plan-line cd-type-body">One business, up to three Desks.</p>
        <p className="cd-settings__plan-line cd-settings__quiet cd-type-meta">Billing would live here, with usage per Desk.</p>
      </Card>
    </>
  );
}
