import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { RuleSentence, type RuleSentenceProps } from './RuleSentence.tsx';

const LINK: RuleSentenceProps = {
  parts: [{ text: 'Claude can send payment links up to ' }, { text: '$300', key: true }],
  meta: { tools: { titles: ['Payment link'] }, who: 'Anyone' },
};

/** The markup without its tags: what a person reads. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function draw(props: RuleSentenceProps): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(RuleSentence, props));
  return host;
}

it('key_parts_are_strong_and_the_rest_plain', () => {
  const el = draw(LINK);
  const sentence = el.querySelector('.cd-rule-sentence__sentence');
  expect(sentence?.textContent).toBe('Claude can send payment links up to $300');
  expect([...(sentence?.querySelectorAll('strong') ?? [])].map((strong) => strong.textContent)).toEqual(['$300']);
});

it('the_meta_line_names_each_tool_as_user_text_then_who', () => {
  const el = draw({
    parts: [{ text: 'Claude can share customers’ own documents and charges' }],
    meta: { tools: { titles: ['Share a document', 'See charges'] }, who: 'The customer, once verified' },
  });
  const meta = el.querySelector('.cd-rule-sentence__meta');
  expect(meta?.textContent).toBe('Share a document and See charges · The customer, once verified');
  const titles = [...(meta?.querySelectorAll('.cd-user-name[data-copy="user"]') ?? [])].map((title) => title.textContent);
  expect(titles).toEqual(['Share a document', 'See charges']);
});

it('a_group_of_tools_is_the_apps_words_not_user_text', () => {
  const el = draw({ parts: [{ text: "Claude never says it's anything but an AI" }], meta: { tools: 'Every tool', who: 'Everyone' } });
  const meta = el.querySelector('.cd-rule-sentence__meta');
  expect(meta?.textContent).toBe('Every tool · Everyone');
  expect(meta?.querySelector('[data-copy="user"]')).toBeNull();
  expect(meta?.querySelector('.cd-rule-sentence__group')?.textContent).toBe('Every tool');
});

it('a_user_part_is_set_off_as_user_text', () => {
  const el = draw({ parts: [{ text: 'Claude can use ' }, { text: 'emergency callback', user: true }], meta: { tools: { titles: ['Emergency callback'] }, who: 'Anyone' } });
  const sentence = el.querySelector('.cd-rule-sentence__sentence');
  expect(sentence?.querySelector('[data-copy="user"]')?.textContent).toBe('emergency callback');
});

it('the_outcome_is_a_dot_and_its_word', () => {
  expect(draw(LINK).querySelector('.cd-rule-sentence__outcome')).toBeNull();
  for (const [outcome, word, tone] of [
    ['auto', 'Allow', 'handled'],
    ['ask', 'Ask me first', 'held'],
    ['never', 'Never', 'refused'],
  ] as const) {
    const el = draw({ ...LINK, outcome });
    const label = el.querySelector('.cd-rule-sentence__outcome');
    expect(label?.textContent).toBe(word);
    expect(label?.querySelector(`.cd-status-dot--${tone}[aria-hidden="true"]`)).not.toBeNull();
  }
});

it('without_meta_there_is_no_meta_line', () => {
  const el = draw({ parts: LINK.parts });
  expect(el.querySelector('.cd-rule-sentence__meta')).toBeNull();
  expect(text(el.innerHTML)).toBe('Claude can send payment links up to $300');
});

it('a_changed_side_draws_its_line', () => {
  expect(draw({ ...LINK, changed: 'before' }).querySelector('.cd-rule-sentence--before')).not.toBeNull();
  expect(draw({ ...LINK, changed: 'after' }).querySelector('.cd-rule-sentence--after')).not.toBeNull();
  expect(draw(LINK).querySelector('.cd-rule-sentence--before, .cd-rule-sentence--after')).toBeNull();
});
