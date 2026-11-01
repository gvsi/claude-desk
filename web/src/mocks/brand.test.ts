import { beforeEach, expect, it } from 'vitest';

import type { BusinessOut } from '../api/views.ts';
import { paletteBrand } from '../public/palette.ts';
import { effectiveBrand } from './brand.ts';
import { RIVERA } from './seed.ts';
import { mockStore } from './store.ts';

beforeEach(() => mockStore.reset('rivera_two_desks'));

it('serves effective palette brands on owner and public reads, shared by the business', async () => {
  const businesses = async () => {
    const answer = await mockStore.dispatch('desks');
    if ('network' in answer) throw new Error('Unexpected network fault');
    return answer.body as BusinessOut[];
  };
  expect((await businesses())[0]?.brand).toEqual(paletteBrand('teal'));
  expect(await mockStore.dispatch('setBusiness', {
    params: { desk_id: RIVERA.deskId },
    body: { name: 'Turner Plumbing', owner_display_name: 'Mike Turner', timezone: 'America/Los_Angeles', brand_palette: 'none', brand: {} },
  })).toMatchObject({ status: 200 });
  expect((await businesses())[0]?.brand).toEqual({ palette: 'none' });
  for (const slug of [RIVERA.slug, RIVERA.emergenciesSlug]) {
    expect(await mockStore.dispatch('publicDesk', { params: { slug } })).toMatchObject({ status: 200, body: { brand: { palette: 'none' } } });
  }
  expect(effectiveBrand({})).toEqual(paletteBrand('teal'));
  expect(effectiveBrand({ palette: 'clay', primary: '#ffffff' })).toEqual(paletteBrand('clay'));
  expect(effectiveBrand({ primary: '#222220' })).toEqual({ primary: '#222220' });
  expect(effectiveBrand({ palette: 'retired' })).toEqual(paletteBrand('teal'));
});
