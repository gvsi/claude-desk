import { expect, it } from 'vitest';

import { chenBusinessTools, seedBusinessTools } from './businessTools.ts';
import { rulesView } from './readModels.ts';
import { mockStore } from './store.ts';

it('seeds a Desk with independent business rows whose definitions reach the tools read model', () => {
  mockStore.reset('rivera');
  const desk = [...mockStore.world.desks.values()][0];
  if (!desk) throw new Error('The mock has a Desk');
  seedBusinessTools(desk);
  const rows = rulesView(desk).tools.filter((row) => row.source === 'business');
  expect(rows.map((row) => row.business)).toEqual(chenBusinessTools.map((row) => row.business));
  expect(rows[0]?.description_confirmed).toBe('Offers open times and books a free intro call, 20 minutes.');
  const intake = rows[1]?.business;
  if (intake?.config.block !== 'intake') throw new Error('The second job is intake');
  intake.config.questions.push('Changed locally');
  expect(chenBusinessTools[1]?.business?.config).not.toEqual(intake.config);
});
