import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ApprovalAnswer } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures/index.ts';
import { ApprovalCard } from './ApprovalCard.tsx';

/** The words on the card's answer buttons, as markup, for a held request that offers `answers`. */
function answerMarkup(answers: ApprovalAnswer[], personName?: string): string[] {
  const html = renderToStaticMarkup(
    createElement(ApprovalCard, {
      decision: { ...rivera.heldRefund, answers },
      waiting: 'Web chat, 1 min ago',
      personName,
      onAnswer: () => {},
    }),
  );
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('[role="group"] button .cd-button__label')].map((label) => label.innerHTML);
}

describe('ApprovalCard words', () => {
  it('execution_refusal_shows_the_kernel_owner_line_verbatim_with_a_null_fallback', () => {
    const line = (state: typeof rivera.decisions.refused_at_execution.state, owner_plain: string | null) => {
      const html = renderToStaticMarkup(createElement(ApprovalCard, {
        decision: { ...rivera.decisions.refused_at_execution, state, owner_plain },
        waiting: 'Web chat, 4 min ago',
        onAnswer: () => {},
      }));
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return doc.querySelector('.cd-approval-card__status-line')?.textContent;
    };
    const reason = 'Not shared: their session ended when their contact changed';
    expect(line('refused_at_execution', reason)).toBe(reason);
    expect(line('refused_at_execution', null)).toBe("Your rules changed before this ran, so it wasn't done.");
    expect(line('executed', reason)).toBe("You allowed this. It's done.");
  });

  it('rule_answers_alone_have_their_full_words', () => {
    // A side with one answer shows its full words; the kernel never offers a rule answer alone, but
    // the card says what it does if it does. Without a name, Allow's says "this person".
    expect(answerMarkup(['allow_person', 'deny_always'])).toEqual(['Allow only for this person, always', 'Deny always']);
    expect(answerMarkup(['allow_person', 'deny_always'], '  ')).toEqual(['Allow only for this person, always', 'Deny always']);
    // With the verified person's name, it names them as user text.
    expect(answerMarkup(['allow_person', 'deny_once'], 'Dana Whitfield')).toEqual([
      'Allow only for <span class="cd-user-name" data-copy="user">Dana Whitfield</span>, always',
      'Deny this time',
    ]);
  });

  it('two_answers_make_a_menu_button', () => {
    expect(answerMarkup(['allow_once', 'deny_once', 'allow_person', 'deny_always'], 'Dana Whitfield')).toEqual(['Allow', 'Deny']);
    expect(answerMarkup(['allow_once', 'deny_once'])).toEqual(['Allow this time', 'Deny this time']);
  });
});
