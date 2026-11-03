import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { EffectTags, effectTags } from './EffectTags.tsx';

it('effect_tags_name_the_weightiest_effect_and_whether_it_can_be_undone', () => {
  // As the boards tag each tool: Payment link, Share a document, See charges, Refund.
  expect(effectTags(['charge'], false)).toEqual(['Money', "Can't be undone"]);
  expect(effectTags(['private_data', 'send_message'], false)).toEqual(['Private data', "Can't be undone"]);
  expect(effectTags(['private_data'], true)).toEqual(['Private data']);
  expect(effectTags(['pay_out', 'private_data'], false)).toEqual(['Money', "Can't be undone"]);
  // Confirm it's them sends a code it can't take back; a quote or a booking can be undone; reading changes nothing.
  expect(effectTags(['send_message'], false)).toEqual(["Can't be undone"]);
  expect(effectTags(['change'], true)).toEqual([]);
  expect(effectTags(['read'], true)).toEqual([]);
  // Reading is never undone, so a read-only tool never says it can't be.
  expect(effectTags(['read'], false)).toEqual([]);
  // A tool with no effect this build knows is never shown as harmless.
  expect(effectTags([], false)).toEqual(["Can't be undone"]);
});

it('effect_tags_draw_a_pill_each_and_nothing_without_one', () => {
  const html = renderToStaticMarkup(createElement(EffectTags, { effects: ['charge'], reversible: false }));
  const host = document.createElement('div');
  host.innerHTML = html;
  expect([...host.querySelectorAll('.cd-effect-tags .cd-pill')].map((pill) => pill.textContent)).toEqual(['Money', "Can't be undone"]);
  expect(renderToStaticMarkup(createElement(EffectTags, { effects: ['read'], reversible: true }))).toBe('');
});
