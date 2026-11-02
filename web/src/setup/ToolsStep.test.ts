/** Setup's tool review names the job and uses its signed owner line. */
import { expect, it } from 'vitest';

import { describeEffects } from '../ds/index.ts';
import { businessToolRows, chenBusinessTools } from '../mocks/businessTools.ts';
import { businessOwnerLine } from '../owner/connectors/businessWords.ts';
import type { BusinessToolDef, ProposalCard, SetupMessage } from '../api/views.ts';
import { acceptedAutonomy, reviewTool } from './ToolsStep.tsx';

it('reviews every business block by its title and owner line instead of Claude-facing text', () => {
  const tools = businessToolRows([
    { title: 'Intake', how: '', config: { block: 'intake', questions: ['Which year?'] } },
    { title: 'Booking', how: '', config: { block: 'typed_booking', appointment_type: 'Call', minutes: 20 } },
    { title: 'Payment', how: '', config: { block: 'purpose_payment', purpose: 'Consultation', amount_cents: 0 } },
    { title: 'Urgent', how: '', config: { block: 'urgent', urgent_when: 'A deadline is today' } },
  ]);
  expect(tools).toHaveLength(4);
  for (const tool of tools) {
    const row = { ...tool, description_confirmed: '<img src="x"> Claude-facing description' };
    expect(reviewTool(row, [])).toMatchObject({
      name: tool.business?.title,
      description: `${businessOwnerLine(tool.business?.config)} ${describeEffects(tool.effects, tool.reversible)}`,
    });
  }
  const intro = chenBusinessTools[0];
  if (!intro?.business) throw new Error('Chen has an intro call tool');
  for (const business of [
    null, { ...intro.business, title: '' }, { ...intro.business, title: '  ', description: '' },
    { ...intro.business, config: { block: 'unknown' } } as never,
    { ...intro.business, config: null } as never,
  ]) {
    expect(reviewTool({ ...intro, business }, [])).toMatchObject({
      name: business?.title.trim() ? business.title : 'A connected tool',
      description: [businessOwnerLine(business?.config), describeEffects(intro.effects, intro.reversible)].filter(Boolean).join(' '),
    });
  }
});

it("reads a job's accepted choice from the setup card it was made from, by its title and setup", () => {
  const def = { title: 'Book a free intro call', description: 'Books a call.', config: { block: 'typed_booking', appointment_type: 'Free intro call', minutes: 20 } } as const;
  const card = (state: ProposalCard['state'], autonomy: 'auto' | 'ask', changes: Partial<NonNullable<ProposalCard['job']>> = {}, decided = true): SetupMessage => ({
    role: 'claude', text: '', choices: [], owner_decided: decided, card: {
      proposal_id: 'p-000000000001', kind: 'job', state, superseded_by: null, connector: null,
      job: { job: 'schedule', title: def.title, why: '', how: '', can_do_today: true, autonomy, config: { ...def.config }, ...changes },
    },
  });
  const plain: SetupMessage = { role: 'claude', text: 'Here is your plan.', choices: [], card: null };
  expect(acceptedAutonomy(def, [plain, card('accepted', 'auto')])).toBe('auto');
  expect(acceptedAutonomy(def, [card('accepted', 'ask')])).toBe('ask');
  // The stored setup comes back with its keys in any order.
  expect(acceptedAutonomy(def, [card('accepted', 'auto', { config: { minutes: 20, block: 'typed_booking', appointment_type: 'Free intro call' } })])).toBe('auto');
  // Only the owner's own decision counts: a card setup accepted for them ("Use your suggestions") wasn't their choice.
  expect(acceptedAutonomy(def, [card('accepted', 'auto', {}, false)])).toBeNull();
  expect(acceptedAutonomy(def, [{ ...card('accepted', 'auto'), owner_decided: undefined }])).toBeNull();
  // Only an accepted card with the same title and setup counts.
  for (const state of ['proposed', 'declined', 'changed'] as const) expect(acceptedAutonomy(def, [card(state, 'auto')])).toBeNull();
  expect(acceptedAutonomy(def, [card('accepted', 'auto', { title: 'Book a call' })])).toBeNull();
  expect(acceptedAutonomy(def, [card('accepted', 'auto', { config: { ...def.config, minutes: 30 } })])).toBeNull();
  expect(acceptedAutonomy(def, [card('accepted', 'auto', { config: null })])).toBeNull();
  expect(acceptedAutonomy(def, [plain])).toBeNull();
  // Two that match and disagree say nothing.
  expect(acceptedAutonomy(def, [card('accepted', 'auto'), card('accepted', 'ask')])).toBeNull();
  // An intake's questions match in their order only.
  const intake: BusinessToolDef = { title: 'Intake', description: '', config: { block: 'intake', questions: ['One?', 'Two?'] } };
  const asked = (questions: string[]) => card('accepted', 'auto', { job: 'intake', title: 'Intake', config: { block: 'intake', questions } });
  expect(acceptedAutonomy(intake, [asked(['One?', 'Two?'])])).toBe('auto');
  expect(acceptedAutonomy(intake, [asked(['Two?', 'One?'])])).toBeNull();
  expect(acceptedAutonomy(intake, [asked(['One?'])])).toBeNull();
});
