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
  { cache: 'starting', deskId: RIVERA.deskId, previews: 2 },
  { cache: 'other desk', deskId: RIVERA.emergenciesDeskId, previews: 1 },
  { cache: 'other business', deskId: RIVERA.deskId, previews: 1 },
  { cache: 'none', deskId: RIVERA.emergenciesDeskId, previews: 2 },
])('knowledge_skeleton_with_$cache: $previews previews', async ({ cache, deskId, previews }) => {
  const queryClient = new QueryClient();
  if (cache !== 'none') {
    const business = businessOut(mockStore.world);
    queryClient.setQueryData(DESKS_KEY, [{
      ...business,
      name: cache === 'other business' ? 'A hair salon in Oakland' : business.name,
      desks: [...business.desks, { ...business.desks[0]!, desk_id: RIVERA.emergenciesDeskId, name: 'Emergencies' }],
    }]);
  }
  const pathname = `/app/${deskId}/knowledge`;
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[pathname]}>
        <OwnerFrameSkeleton pathname={pathname} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const cards = screen.container.querySelectorAll('.cd-knowledge__previews > .cd-knowledge-list');
  expect(cards).toHaveLength(previews);
  for (const card of cards) expect(card.querySelectorAll('.cd-knowledge-list__row')).toHaveLength(3);
});
