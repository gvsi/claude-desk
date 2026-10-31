import { expect, it } from 'vitest';

import type { EvMessage, SessionState } from '../api/contracts.ts';
import { messageReceiptVisible } from './messageReceipt.ts';

it('only_external_reply_checks_are_hidden_for_every_contract_shape', () => {
  const cases: { author: EvMessage['author']; handoff: boolean; external: boolean }[] = [
    { author: 'claude', handoff: false, external: false },
    { author: 'claude', handoff: true, external: true },
    { author: 'desk', handoff: false, external: false },
    { author: 'desk', handoff: true, external: true },
    { author: 'owner', handoff: false, external: true },
    { author: 'owner', handoff: true, external: true },
  ];
  const kinds: (SessionState['kind'] | undefined)[] = ['visitor', 'agent', 'owner', undefined];
  for (const { author, handoff, external } of cases) {
    for (const kind of kinds) {
      // The words may be anything: the contract's author and verdict identify the receipt.
      const message: Pick<EvMessage, 'author' | 'handoff' | 'visitor_plain'> = { author, handoff, visitor_plain: 'Unmatched kernel line' };
      expect(messageReceiptVisible(message, kind), `${author}, handoff=${handoff}, session=${kind}`).toBe(kind === 'owner' ? true : external);
    }
  }
});
