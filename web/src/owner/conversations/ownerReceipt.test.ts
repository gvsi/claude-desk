import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import type { StatusEvent } from '../../api/contracts.ts';
import { useOwnerReceipt } from './ownerReceipt.ts';

it('an_executed_resolved_event_keeps_its_visitor_line_even_with_an_owner_annotation', () => {
  const event: StatusEvent = { type: 'resolved', decision_id: 'dec-executed', state: 'executed',
    visitor_plain: 'Mike Turner approved this', ledger_seq: 3, signature: 'signed' };
  const ownerLine = 'Not shared: their session ended before your answer';
  function Receipt() {
    const view = useOwnerReceipt(event, false, ownerLine);
    return createElement('p', null, view.plain);
  }
  const client = new QueryClient();
  try {
    const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Receipt)));
    expect(markup).toContain(event.visitor_plain);
    expect(markup).not.toContain(ownerLine);
  } finally { client.clear(); }
});
