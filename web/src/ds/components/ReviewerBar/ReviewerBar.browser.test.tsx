import { expect, it } from 'vitest';

import { rivera } from '../../fixtures/rivera.ts';
import { SEED_OWNER_NAME } from './ReviewerBar.tsx';

it('seed_owner_name_is_the_rivera_fixtures_owner', () => {
  // The skeleton's default name and the stories' fixture both stand for the seed's owner.
  expect(rivera.business.ownerName).toBe(SEED_OWNER_NAME);
});
