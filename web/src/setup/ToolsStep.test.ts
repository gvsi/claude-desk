/** Setup's tool review uses the same business title and description as the owner's rules. */
import { expect, it } from 'vitest';

import { describeEffects } from '../ds/index.ts';
import { chenBusinessTools } from '../mocks/businessTools.ts';
import { reviewTool } from './ToolsStep.tsx';

it('reviews a business tool by its title and description', () => {
  for (const tool of chenBusinessTools) {
    expect(reviewTool(tool, [])).toMatchObject({
      name: tool.business?.title,
      description: `${tool.business?.description} ${describeEffects(tool.effects, tool.reversible)}`,
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
