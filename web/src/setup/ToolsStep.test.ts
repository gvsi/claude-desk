/** Setup's tool review names the job and uses its signed owner line. */
import { expect, it } from 'vitest';

import { describeEffects } from '../ds/index.ts';
import { businessToolRows, chenBusinessTools } from '../mocks/businessTools.ts';
import { businessOwnerLine } from '../owner/connectors/businessWords.ts';
import { reviewTool } from './ToolsStep.tsx';

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
