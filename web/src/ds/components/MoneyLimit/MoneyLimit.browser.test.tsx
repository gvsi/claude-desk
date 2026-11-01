/**
 * The payment limit's line once a confirmed change set a new limit, with motion on where a test
 * needs it (this project's context emulates reduced motion): it carries "Updated", and only the
 * words that changed cross-fade.
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';

import { expectComputed } from '../../test/expectComputed.ts';
import { motion } from '../../test/reducedMotion.ts';
import { MoneyLimit } from './MoneyLimit.tsx';

/** The limit's line at `dollars`. */
const lineAt = (dollars: string) => `No payment over ${dollars} goes through without asking you, whatever the rules below say.`;

/** A place to draw the limit, and a way to draw it again with a new line. */
function mount(): (line: string, updated?: boolean) => HTMLElement {
  const el = document.createElement('div');
  el.style.width = '928px';
  document.body.append(el);
  const root = createRoot(el);
  onTestFinished(() => {
    root.unmount();
    el.remove();
  });
  const noop = () => undefined;
  return (line, updated) => {
    flushSync(() =>
      root.render(
        <MoneyLimit
          line={line}
          editing={false}
          value=""
          hint="Whole dollars, from 0 to 10,000."
          onEdit={noop}
          onChange={noop}
          onReview={noop}
          onCancel={noop}
          {...(updated === undefined ? {} : { updated })}
        />,
      ),
    );
    return el;
  };
}

it('an_updated_limit_says_so_and_cross_fades_its_amount', async () => {
  await motion();
  const draw = mount();
  draw(lineAt('$500'));
  const el = draw(lineAt('$600'), true);
  const line = el.querySelector<HTMLElement>('.cd-money-limit__line');
  if (!line) throw new Error('no line');
  // The amount alone fades from $500 to $600; "Updated" follows the line, 8 px after it.
  expect(line.querySelector('.cd-cross-fade__was')?.textContent).toBe('$500');
  expect(line.querySelector('.cd-cross-fade__now')?.textContent).toBe('$600');
  const pill = line.querySelector<HTMLElement>('.cd-pill');
  expect(pill?.textContent).toBe('Updated');
  expectComputed(pill?.parentElement ?? line, { animationName: 'cd-landed-updated', animationDuration: '0.2s', marginLeft: '8px' });
  await Promise.all(line.getAnimations({ subtree: true }).map((a) => a.finished));
  await expect.poll(() => line.querySelector('.cd-cross-fade')).toBeNull();
  expect(line.textContent).toBe(`${lineAt('$600')}Updated`);
  // "Change" is still there, beside the line.
  expect(el.querySelector('button')?.textContent).toBe('Change');
});

it('a_limit_that_isnt_updated_has_neither', async () => {
  await motion();
  const draw = mount();
  draw(lineAt('$500'));
  const el = draw(lineAt('$600'));
  expect(el.querySelector('.cd-pill')).toBeNull();
  expect(el.querySelector('.cd-cross-fade')).toBeNull();
  expect(el.querySelector('.cd-money-limit__line')?.textContent).toBe(lineAt('$600'));
});

it('an_updated_limit_is_at_its_end_state_under_reduced_motion', () => {
  const draw = mount();
  draw(lineAt('$500'));
  const el = draw(lineAt('$600'), true);
  const line = el.querySelector<HTMLElement>('.cd-money-limit__line');
  expect(line?.querySelector('.cd-cross-fade')).toBeNull();
  expect(line?.textContent).toBe(`${lineAt('$600')}Updated`);
  expectComputed(line?.querySelector('.cd-pill')?.parentElement ?? el, { animationName: 'none' });
});
