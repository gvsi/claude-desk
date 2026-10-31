/** Setup's tool review names the job and uses the kernel's confirmed description. */
import { expect, it } from 'vitest';

import { describeEffects } from '../ds/index.ts';
import { chenBusinessTools } from '../mocks/businessTools.ts';
import { reviewTool } from './ToolsStep.tsx';

it('reviews a business tool by its title and confirmed description', () => {
  for (const tool of chenBusinessTools) {
    expect(reviewTool(tool, [])).toMatchObject({
      name: tool.business?.title,
      description: `${tool.description_confirmed} ${describeEffects(tool.effects, tool.reversible)}`,
    });
  }
  const intro = chenBusinessTools[0];
  if (!intro?.business) throw new Error('Chen has an intro call tool');
  for (const business of [null, { ...intro.business, title: '  ' }]) {
    expect(reviewTool({ ...intro, business }, [])).toMatchObject({
      name: 'A connected tool',
      description: `A connected tool ${describeEffects(intro.effects, intro.reversible)}`,
    });
  }
});
