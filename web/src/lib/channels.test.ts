import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { ShareKit } from '../owner/share/ShareKit.tsx';
import { LiveStep } from '../setup/LiveStep.tsx';
import { COMING_LATER_CHANNELS, WEBSITE_EMBED } from './channels.ts';

it('setup Live and Share read their channel names and lines from the same source', () => {
  // Changing the shared objects must reach both consumers, including the embed in Live's Share it.
  for (const channel of [WEBSITE_EMBED, ...COMING_LATER_CHANNELS]) {
    const original = { ...channel };
    channel.name = `Shared ${channel.key}`;
    channel.line = `Shared line for ${channel.key}`;
    try {
      const live = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() },
        createElement(LiveStep, {
          state: { interview_id: 'i1', desk_id: 'd1', slug: 'turner', step: 'live', messages: [], consent: true, question: null },
          business: 'Turner Plumbing', answering: true, onLive: () => {}, reread: async () => null,
        })));
      const share = renderToStaticMarkup(createElement(ShareKit, {
        publicUrl: 'https://desk.example/d/turner', business: 'Turner Plumbing', ownerName: 'Mike Turner', urgentCallback: false,
      }));
      for (const markup of [live, share]) {
        expect(markup).toContain(channel.name);
        expect(markup).toContain(channel.line);
      }
    } finally {
      Object.assign(channel, original);
    }
  }
});
