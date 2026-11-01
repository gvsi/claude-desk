/**
 * Receipts under a row that arrives live, with motion on (this project's context emulates reduced
 * motion, so the test turns it on for itself). A receipt already shown before its row arrived
 * (`shownBefore`: it moved under the reply with it) shows at once; the others land.
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { motion } from '../../test/reducedMotion.ts';
import { ClaudeMessage } from '../ClaudeMessage/ClaudeMessage.tsx';
import { TranscriptRow } from '../TranscriptRow/TranscriptRow.tsx';
import { receiptFromEvent } from './receiptTone.ts';
import { MarginReceipt } from './MarginReceipt.tsx';
import { RulesReceipt } from './RulesReceipt.tsx';

const [quoteRan, , quoteReply] = rivera.events.quoteTurn;

it('a_receipt_shown_before_doesnt_land_again', async () => {
  await motion();
  if (quoteRan?.type !== 'receipt' || quoteReply?.type !== 'message') throw new Error('the quote turn has its receipt and reply');
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  onTestFinished(() => {
    root.unmount();
    el.remove();
  });

  // The reply arrives live with its own check, and the quote's receipt the reader already saw
  // under the question moves under it.
  flushSync(() =>
    root.render(
      <TranscriptRow
        live
        margin={[
          <MarginReceipt key="reply" {...receiptFromEvent(quoteReply)} />,
          <MarginReceipt key="quote" {...receiptFromEvent(quoteRan)} shownBefore />,
        ]}
      >
        <ClaudeMessage blocks={quoteReply.blocks} language={quoteReply.language} ownerName={rivera.business.ownerName} />
      </TranscriptRow>,
    ),
  );
  const [check, quote] = [...el.querySelectorAll('.cd-margin-receipt')];
  if (!check || !quote) throw new Error('both receipts are attached');
  const dotOf = (line: Element) => line.querySelector('.cd-status-dot') ?? line;
  // The reply's check lands on its beat, its dot growing with it.
  expectComputed(check, { animationName: 'cd-transcript-row-land', animationDelay: '0.15s' });
  expectComputed(dotOf(check), { animationName: 'cd-margin-line-dot' });
  // The receipt shown before is already there: no slide, no fade, no dot growing.
  expectComputed(quote, { animationName: 'none' });
  expectComputed(dotOf(quote), { animationName: 'none' });
});

/** `node` rendered on its own in the page, unmounted after the test. */
function renderAlone(node: React.ReactNode): HTMLElement {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  onTestFinished(() => {
    root.unmount();
    el.remove();
  });
  flushSync(() => root.render(node));
  return el;
}

it('a_confirmed_rules_receipt_lands_on_its_own', async () => {
  await motion();
  // Outside a conversation's rows, as under Claude's message in Ask Claude once a change is confirmed.
  const el = renderAlone(<RulesReceipt version={8} />);
  const line = el.querySelector('.cd-margin-receipt');
  if (!line) throw new Error('the receipt is drawn');
  expect(line.textContent).toBe('Confirmed. Version 8 of your rules, checked against the always-on rules.');
  expect(line.querySelector('.cd-margin-line__lead')?.textContent).toBe('Confirmed.');
  // It lands on motion-base, rising as it fades in, its handled dot growing from half size with it.
  expectComputed(line, { animationName: 'cd-margin-line-land', animationDuration: '0.2s' });
  const dot = line.querySelector('.cd-status-dot');
  expect(dot?.className).toContain('handled');
  expectComputed(dot ?? line, { animationName: 'cd-margin-line-dot', animationDuration: '0.2s' });
});

it('a_confirmed_rules_receipt_shows_at_once_under_reduced_motion', () => {
  // This project's context emulates reduced motion: the receipt is there at once, its dot whole.
  const el = renderAlone(<RulesReceipt version={12} />);
  const line = el.querySelector('.cd-margin-receipt');
  if (!line) throw new Error('the receipt is drawn');
  expect(line.textContent).toBe('Confirmed. Version 12 of your rules, checked against the always-on rules.');
  expectComputed(line, { animationName: 'none' });
  expectComputed(line.querySelector('.cd-status-dot') ?? line, { animationName: 'none' });
});
