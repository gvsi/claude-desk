/**
 * A tool's card a confirmed change landed on (a business's own job on Rules), with motion on where
 * a test needs it (this project's context emulates reduced motion): it lights up, holds and lets
 * go, keeps "Updated" by the tool's name, and its rules' words cross-fade. A card that offers "Add a
 * rule" takes no fill.
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';

import type { RuleCard } from '../../../api/contracts.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectUserText } from '../../test/expectUserText.ts';
import { motion } from '../../test/reducedMotion.ts';
import { ToolRulesCard, type ToolRulesCardProps } from './ToolRulesCard.tsx';

const INTAKE: RuleCard = {
  card_id: 'intake',
  applies_to: 'desk.new-client-intake',
  mode: 'auto',
  who: 'anyone',
  person_id: null,
  agent_key_id: null,
  max_amount_cents: null,
  max_discount_bp: 0,
  hours: null,
  review: false,
  is_default: false,
  reason: 'New clients answer three questions before they book.',
};

/** The intake job's card, with `rule` its one rule. */
function intakeCard(rule: RuleCard, extra: Partial<ToolRulesCardProps> = {}): ToolRulesCardProps {
  return {
    label: 'New client intake',
    tool: { name: 'New client intake', description: 'Asks three questions.' },
    rules: [{ rule, words: [{ field: 'who', text: rule.who === 'anyone' ? 'Anyone' : 'Verified people' }] }],
    ...extra,
  };
}

/** A place to draw the card, and a way to draw it again with new props. */
function mount(): (props: ToolRulesCardProps) => HTMLElement {
  const el = document.createElement('div');
  el.style.width = '928px';
  document.body.append(el);
  const root = createRoot(el);
  onTestFinished(() => {
    root.unmount();
    el.remove();
  });
  return (props) => {
    flushSync(() => root.render(<ToolRulesCard {...props} />));
    return el;
  };
}

it('a_landed_card_lights_up_holds_lets_go_and_keeps_updated', async () => {
  await motion();
  const el = mount()(intakeCard(INTAKE, { landed: 1 }));
  expect(el.querySelector('.cd-tool-rules__tool .cd-pill')?.textContent).toBe('Updated');
  const glow = el.querySelector<HTMLElement>('.cd-landed-glow');
  if (!glow) throw new Error('the landed card has its fill');
  const [light, letGo] = glow.getAnimations();
  if (!light || !letGo) throw new Error('the fill lights up and lets go');
  await light.finished;
  expect(getComputedStyle(glow).backgroundColor).toBe('rgb(60, 57, 47)');
  await letGo.finished;
  expect(getComputedStyle(glow).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(el.querySelector('.cd-pill')?.textContent).toBe('Updated');
});

it('a_landed_cards_rule_words_cross_fade', async () => {
  await motion();
  const draw = mount();
  draw(intakeCard(INTAKE));
  const asks: RuleCard = { ...INTAKE, mode: 'ask', who: 'verified', reason: 'New clients answer three questions, then wait for your answer.' };
  const el = draw(intakeCard(asks, { landed: 1 }));
  const reason = el.querySelector<HTMLElement>('.cd-rule-row__reason');
  const words = el.querySelector<HTMLElement>('.cd-rule-row__words');
  expect(reason?.querySelector('.cd-cross-fade__was')?.textContent).toBe(INTAKE.reason);
  expect(reason?.querySelector('.cd-cross-fade__now')?.textContent).toBe(asks.reason);
  expect(words?.querySelector('.cd-cross-fade__was')?.textContent).toBe('Anyone');
  expect(words?.querySelector('.cd-cross-fade__now')?.textContent).toBe('Verified people');
  expectComputed(reason?.querySelector('.cd-cross-fade__now') ?? el, { animationName: 'cd-cross-fade-in', animationDuration: '0.2s' });
  await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished));
  await expect.poll(() => el.querySelector('.cd-cross-fade')).toBeNull();
  expect(reason?.textContent).toBe(asks.reason);
});

it('a_card_that_offers_add_a_rule_takes_no_fill', async () => {
  await motion();
  const el = mount()(intakeCard(INTAKE, { landed: 1, onAddRule: () => undefined }));
  // A Button can't sit on the selected ground: "Updated" only.
  expect(el.querySelector('.cd-landed-glow')).toBeNull();
  expect(el.querySelector('.cd-pill')?.textContent).toBe('Updated');
  expect(el.querySelector('button')?.textContent).toBe('Add a rule');
});

it('a_card_that_isnt_landed_has_neither', async () => {
  await motion();
  const draw = mount();
  draw(intakeCard(INTAKE));
  const el = draw(intakeCard({ ...INTAKE, reason: 'Something else.' }));
  expect(el.querySelector('.cd-landed-glow')).toBeNull();
  expect(el.querySelector('.cd-pill')).toBeNull();
  expect(el.querySelector('.cd-cross-fade')).toBeNull();
  expect(el.querySelector('[data-landed]')).toBeNull();
});

it('a_landed_card_is_at_its_end_state_under_reduced_motion', () => {
  const el = mount()(intakeCard(INTAKE, { landed: 1 }));
  expect(el.querySelector('.cd-pill')?.textContent).toBe('Updated');
  expectComputed(el.querySelector('.cd-landed-glow') ?? el, { display: 'none' });
  expectComputed(el.querySelector('.cd-landed-updated') ?? el, { animationName: 'none' });
});

/** A tool title that reads like the app's own sentence, as a business could name a job in setup. */
const TITLE = 'Approved by your accountant';

it('a_tool_title_and_the_titles_a_shared_rule_names_are_user_text', () => {
  const shared: RuleCard = { ...INTAKE, card_id: 'changes', applies_to: 'effect:change', mode: 'ask', reason: 'Changes ask you first.' };
  const el = mount()({
    label: TITLE,
    tool: { name: TITLE, description: 'Asks three questions.' },
    rules: [
      { rule: INTAKE, words: [{ field: 'who', text: 'Anyone' }] },
      { rule: shared, words: [{ field: 'who', text: 'Anyone' }], shared: { lead: 'Applies to every tool that changes something', titles: ['Quote', TITLE, 'New client intake'] } },
    ],
  });
  // The card's name and its shared rule's line: each title its own user-text element.
  expect(expectUserText(el, TITLE)).toBe(2);
  expectUserText(el, 'New client intake');
  // The line reads as it always has: the app's words, the titles joined, one period.
  expect(el.querySelector('.cd-rule-row__shared')?.textContent).toBe(
    `Shared rule. Applies to every tool that changes something:Quote, ${TITLE} and New client intake`,
  );
});

it('a_shared_rule_that_names_no_tool_ends_on_its_group', () => {
  const shared: RuleCard = { ...INTAKE, card_id: 'changes', applies_to: 'effect:change', mode: 'ask', reason: 'Changes ask you first.' };
  const el = mount()({ label: 'Your rules for refund', rules: [{ rule: shared, words: [], shared: { lead: 'Applies to every tool that changes something', titles: [] } }] });
  expect(el.querySelector('.cd-rule-row__shared')?.textContent).toBe('Shared rule. Applies to every tool that changes something.');
  expect(el.querySelector('.cd-rule-row__shared [data-copy="user"]')).toBeNull();
});
