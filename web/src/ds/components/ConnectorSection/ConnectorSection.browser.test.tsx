/**
 * A row a confirmed change landed on, with motion on (this project's context emulates reduced
 * motion, so each test that needs motion turns it on for itself): it lights up, holds and lets go,
 * keeps "Updated", and its words cross-fade; a later change lights it up again.
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectUserText } from '../../test/expectUserText.ts';
import { motion } from '../../test/reducedMotion.ts';
import { ConnectorSection, type ConnectorSectionProps } from './ConnectorSection.tsx';

const [quotes, bookings] = rivera.connectors.sections;
if (!quotes || !bookings) throw new Error('The Turner hub fixture lost a section');

/** A place to render sections into, and a way to draw them again with new props. */
function mount(): (props: ConnectorSectionProps) => HTMLElement {
  const el = document.createElement('div');
  el.style.width = '960px';
  document.body.append(el);
  const root = createRoot(el);
  onTestFinished(() => {
    root.unmount();
    el.remove();
  });
  return (props) => {
    flushSync(() => root.render(<ConnectorSection {...props} />));
    return el;
  };
}

/** `section` with the tool named `name` given `changes`. */
function withTool(section: ConnectorSectionProps, name: string, changes: Partial<ConnectorSectionProps['tools'][number]>): ConnectorSectionProps {
  return { ...section, tools: section.tools.map((tool) => (tool.name === name ? { ...tool, ...changes } : tool)) };
}

/** The selected fill, as the browser computes `--bg-selected`. */
const SELECTED = 'rgb(60, 57, 47)';

it.each([680, 688].flatMap((width) => [undefined, '/x'].map((href) => ({ width, href }))))('payment_link_keeps_a_readable_text_column_in_a_$width_px_section_with_href_$href', ({ width, href }) => {
  const payments = rivera.connectors.sections.find((section) => section.connector.id === 'payments');
  const paymentLink = payments?.tools.find((tool) => tool.key === 'native.payment_link');
  if (!payments || !paymentLink) throw new Error('Payments has a payment link');
  const draw = mount();
  const el = draw({
    ...payments,
    tools: [{ ...paymentLink, href, summary: 'Anyone · Up to $300 · Checked by the reviewer' }],
  });
  el.style.width = `${width}px`;
  const row = el.querySelector<HTMLElement>('.cd-connector-section__tool')!;
  const head = row.querySelector<HTMLElement>('.cd-connector-section__tool-head')!;
  const description = row.querySelector<HTMLElement>('.cd-connector-section__tool-description')!;
  const summary = row.querySelector<HTMLElement>('.cd-connector-section__tool-summary')!;
  const outcome = row.querySelector<HTMLElement>('.cd-connector-section__tool-outcome')!;
  expect(head.getBoundingClientRect().width).toBeGreaterThanOrEqual(240);
  expect(description.getBoundingClientRect().width).toBeGreaterThanOrEqual(240);
  expect(description.getBoundingClientRect().height).toBeLessThanOrEqual(4 * parseFloat(getComputedStyle(description).lineHeight));
  expect(summary.getBoundingClientRect().right).toBeLessThanOrEqual(outcome.getBoundingClientRect().left);
  const style = getComputedStyle(row);
  const contentRight = row.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
  for (const part of row.children) {
    expect(part.getBoundingClientRect().right).toBeLessThanOrEqual(contentRight);
  }
});

it('a_landed_row_lights_up_holds_and_lets_go', async () => {
  await motion();
  const draw = mount();
  const el = draw(withTool(bookings, 'Book a visit', { landed: 1 }));
  const [find, book] = [...el.querySelectorAll<HTMLElement>('.cd-connector-section__tool')];
  if (!find || !book) throw new Error('Bookings has two rows');
  // Only the landed row lights up and says "Updated".
  expect(find.querySelector('.cd-landed-glow')).toBeNull();
  expect(find.textContent).not.toContain('Updated');
  const glow = book.querySelector<HTMLElement>('.cd-landed-glow');
  if (!glow) throw new Error('the landed row has its glow');
  expect(book.querySelector('.cd-pill')?.textContent).toBe('Updated');
  expectComputed(book.querySelector('.cd-landed-updated') ?? book, { animationName: 'cd-landed-updated', animationDuration: '0.2s' });
  // Lit on motion-fast, held, then let go on motion-base: the fill is the selected one while held.
  const [light, letGo] = glow.getAnimations();
  if (!light || !letGo) throw new Error('the glow lights up and lets go');
  await light.finished;
  expect(getComputedStyle(glow).backgroundColor).toBe(SELECTED);
  await letGo.finished;
  expect(getComputedStyle(glow).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  // "Updated" stays.
  expect(book.querySelector('.cd-pill')?.textContent).toBe('Updated');
});

it('a_landed_rows_words_cross_fade', async () => {
  await motion();
  const draw = mount();
  draw(quotes);
  // The change lands as the new words arrive: the old fade out over the new as they fade in.
  const el = draw(withTool(quotes, 'Quote', { summary: 'Anyone · No discounts · Weekdays, all day', landed: 1 }));
  const summary = el.querySelector<HTMLElement>('.cd-connector-section__tool-summary');
  if (!summary) throw new Error('the row has its words');
  const was = summary.querySelector<HTMLElement>('.cd-cross-fade__was');
  const now = summary.querySelector<HTMLElement>('.cd-cross-fade__now');
  expect(was?.textContent).toBe('Anyone · No discounts');
  expect(was).toHaveAttribute('aria-hidden', 'true');
  expect(now?.textContent).toBe('Anyone · No discounts · Weekdays, all day');
  expectComputed(was ?? summary, { animationName: 'cd-cross-fade-out', animationDuration: '0.2s' });
  expectComputed(now ?? summary, { animationName: 'cd-cross-fade-in', animationDuration: '0.2s' });
  // Once faded, only the new words are left.
  await Promise.all(summary.getAnimations({ subtree: true }).map((fade) => fade.finished));
  await expect.poll(() => summary.querySelector('.cd-cross-fade__was')).toBeNull();
  expect(summary.textContent).toBe('Anyone · No discounts · Weekdays, all day');
});

it('a_row_that_isnt_landed_changes_its_words_at_once', async () => {
  await motion();
  const draw = mount();
  draw(quotes);
  const el = draw(withTool(quotes, 'Quote', { summary: 'Anyone · No discounts · Weekdays, all day' }));
  expect(el.querySelector('.cd-cross-fade')).toBeNull();
  expect(el.querySelector('.cd-landed-glow')).toBeNull();
  expect(el.querySelector('.cd-connector-section__tool-summary')?.textContent).toBe('Anyone · No discounts · Weekdays, all day');
});

it('a_later_change_lights_the_row_up_again', async () => {
  await motion();
  const draw = mount();
  const first = draw(withTool(quotes, 'Quote', { landed: 1 })).querySelector('.cd-landed-glow');
  const second = draw(withTool(quotes, 'Quote', { landed: 2 })).querySelector<HTMLElement>('.cd-landed-glow');
  expect(second).not.toBe(first);
  expect(second?.getAnimations().map((a) => (a as CSSAnimation).animationName)).toEqual(['cd-landed-light', 'cd-landed-let-go']);
});

it('a_landed_row_is_at_its_end_state_under_reduced_motion', () => {
  const draw = mount();
  draw(quotes);
  const el = draw(withTool(quotes, 'Quote', { summary: 'Anyone · No discounts · Weekdays, all day', landed: 1 }));
  // "Updated" at once, no fill, and only the new words.
  expect(el.querySelector('.cd-pill')?.textContent).toBe('Updated');
  expectComputed(el.querySelector('.cd-landed-updated') ?? el, { animationName: 'none' });
  expectComputed(el.querySelector('.cd-landed-glow') ?? el, { display: 'none' });
  expect(el.querySelector('.cd-cross-fade')).toBeNull();
  expect(el.querySelector('.cd-connector-section__tool-summary')?.textContent).toBe('Anyone · No discounts · Weekdays, all day');
  expect(document.getAnimations().filter((a) => el.contains((a.effect as KeyframeEffect | null)?.target ?? null))).toEqual([]);
});

it('a_tools_name_is_user_text_and_its_link_still_names_it_first', () => {
  const title = 'Approved by your accountant';
  const draw = mount();
  const tool = quotes.tools[0];
  if (!tool) throw new Error('Quotes has a tool');
  // With a link to its page, and without one.
  for (const href of ['connectors/quotes/native.quote', undefined]) {
    const el = draw({ ...quotes, tools: [{ ...tool, name: title, ...(href === undefined ? { href: undefined } : { href }) }] });
    expect(expectUserText(el, title)).toBe(1);
    const link = el.querySelector('.cd-connector-section__tool-link');
    if (href === undefined) expect(link).toBeNull();
    // Its accessible name still leads with the title as a part of its own, before the app's words.
    else expect(link?.getAttribute('aria-label')?.startsWith(`${title}: ${tool.summary}, `)).toBe(true);
  }
});
