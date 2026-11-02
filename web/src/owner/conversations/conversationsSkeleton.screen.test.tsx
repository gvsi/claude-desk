import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { businessOut } from '../../mocks/readModels.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { OwnerFrameSkeleton } from '../OwnerFrameSkeleton.tsx';
import { DESKS_KEY } from '../useDesks.ts';

it.each([
  { cache: 'starting', deskId: RIVERA.deskId, captions: 1 },
  { cache: 'other desk', deskId: RIVERA.emergenciesDeskId, captions: 0 },
  { cache: 'other business', deskId: RIVERA.deskId, captions: 0 },
  { cache: 'none', deskId: RIVERA.emergenciesDeskId, captions: 1 },
].flatMap((row) => [false, true].map((open) => ({ ...row, open }))))(
  'conversations_frame_with_$cache and open=$open: $captions caption shapes',
  async ({ cache, deskId, captions, open }) => {
    const queryClient = new QueryClient();
    if (cache !== 'none') {
      const business = businessOut(mockStore.world);
      queryClient.setQueryData(DESKS_KEY, [{
        ...business,
        name: cache === 'other business' ? 'Maple Street Rentals' : business.name,
        desks: [...business.desks, { ...business.desks[0]!, desk_id: RIVERA.emergenciesDeskId, name: 'Emergencies' }],
      }]);
    }
    const pathname = `/app/${deskId}/conversations${open ? '/ses-visitor-web' : ''}`;
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[pathname]}>
          <OwnerFrameSkeleton pathname={pathname} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.container.querySelectorAll('[data-skeleton-anchor="conversations-caption"]')).toHaveLength(captions);
    expect(screen.container.querySelectorAll('[data-skeleton-anchor="conversation-row-0"]')).toHaveLength(1);
  },
);
