import { expect, it } from 'vitest';

import type { BusinessToolDef } from '../api/views.ts';
import { isBusinessToolName } from '../owner/connectors/catalog.ts';
import { businessToolRows, chenBusinessTools, seedBusinessTools } from './businessTools.ts';
import { rulesView } from './readModels.ts';
import { mockStore } from './store.ts';

const booking = {
  title: 'Book a free intro call',
  how: 'Books a free 20-minute intro call with Linda for a new client.',
  config: { block: 'typed_booking' as const, appointment_type: 'Free intro call', minutes: 20 },
};
const intake: { title: string; how: string; config: Extract<BusinessToolDef['config'], { block: 'intake' }> } = {
  title: 'New client intake',
  how: 'Saves the answers for Linda.',
  config: { block: 'intake' as const, questions: ['Which tax years do you need help with?'] },
};

it('turns accepted jobs into business rows in order with the kernel block profiles', () => {
  const rows = businessToolRows([booking, intake]);
  expect(rows.map((row) => row.tool)).toEqual(['desk.book-a-free-intro-call', 'desk.new-client-intake']);
  expect(rows.every((row) => isBusinessToolName(row.tool))).toBe(true);
  expect(rows).toEqual([
    expect.objectContaining({
      source: 'business', status: 'needs_review', review_reason: 'new',
      business: { title: booking.title, description: booking.how, config: booking.config },
      effects: ['change'], reversible: true,
      description_confirmed: "Books one open time on the business's calendar for this kind of appointment.",
      pending_definition_text: null, pending_sha256: null, cards: [],
    }),
    expect.objectContaining({
      source: 'business', status: 'needs_review', review_reason: 'new',
      business: { title: intake.title, description: intake.how, config: intake.config },
      effects: ['change'], reversible: true,
      description_confirmed: "Saves the person's name, contact details and answers to the business's questions, so the owner can follow up.",
      pending_definition_text: null, pending_sha256: null, cards: [],
    }),
  ]);
});

it('retains empty descriptions and zero-dollar payments with their fixed block profiles', () => {
  const rows = businessToolRows([
    { ...booking, how: '' },
    { title: 'Take a deposit', how: '', config: { block: 'purpose_payment', purpose: 'Consultation', amount_cents: 0 } },
  ]);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.business?.description).toBe('');
  expect(rows[0]?.description_confirmed).toBe("Books one open time on the business's calendar for this kind of appointment.");
  expect(rows[1]).toMatchObject({
    business: { description: '', config: { block: 'purpose_payment', purpose: 'Consultation', amount_cents: 0 } },
    effects: ['charge'], reversible: false,
    description_confirmed: "Creates a secure payment link for this purpose, for the amount the owner set.",
  });
});

it('deduplicates against taken names and earlier jobs while keeping suffixes within 40 characters', () => {
  const taken = new Set(['desk.book-a-free-intro-call', 'desk.book-a-free-intro-call-2']);
  expect(businessToolRows([booking, booking], taken).map((row) => row.tool)).toEqual([
    'desk.book-a-free-intro-call-3', 'desk.book-a-free-intro-call-4',
  ]);
  expect([...taken]).toEqual(['desk.book-a-free-intro-call', 'desk.book-a-free-intro-call-2']);
  expect(businessToolRows([booking, booking]).map((row) => row.tool)).toEqual([
    'desk.book-a-free-intro-call', 'desk.book-a-free-intro-call-2',
  ]);

  const longJob = { ...booking, title: 'A'.repeat(55) };
  const rows = businessToolRows(Array.from({ length: 12 }, () => longJob));
  expect(rows[0]?.tool).toBe(`desk.${'a'.repeat(40)}`);
  expect(rows[1]?.tool).toBe(`desk.${'a'.repeat(38)}-2`);
  expect(rows[11]?.tool).toBe(`desk.${'a'.repeat(37)}-12`);
  expect(new Set(rows.map((row) => row.tool)).size).toBe(12);
  expect(rows.every((row) => isBusinessToolName(row.tool))).toBe(true);
});

it('uses a deduplicated job slug for symbols and starts every slug with a letter', () => {
  const titles = ['!!!', '🎉', '123', '123 Intro call', '  CALL / 2026  '];
  const rows = businessToolRows(titles.map((title) => ({ ...booking, title })), ['desk.job']);
  expect(rows.map((row) => row.tool)).toEqual([
    'desk.job-2', 'desk.job-3', 'desk.job-4', 'desk.intro-call', 'desk.call-2026',
  ]);
  expect(rows.every((row) => isBusinessToolName(row.tool))).toBe(true);
  expect(rows.map((row) => row.business?.title)).toEqual(titles);
});

it('omits jobs without config without reserving their names or changing the accepted order', () => {
  const rows = businessToolRows([{ ...booking, config: null }, intake, booking]);
  expect(rows.map((row) => row.tool)).toEqual(['desk.new-client-intake', 'desk.book-a-free-intro-call']);
  expect(businessToolRows([{ ...booking, config: null }])).toEqual([]);
  expect(businessToolRows([])).toEqual([]);
});

it('fails closed for unknown blocks and malformed jobs without consuming a valid job name', () => {
  const malformed: unknown[] = [
    null, undefined, {}, { ...booking, title: null }, { ...booking, title: 'a'.repeat(61) },
    { ...booking, how: null }, { ...booking, how: 'a'.repeat(301) },
    { ...booking, config: undefined }, { ...booking, config: {} },
    { ...booking, config: { block: 'unknown' } }, { ...booking, config: { block: '__proto__' } },
    { ...booking, config: { block: 'intake', questions: 'Not an array' } },
    { ...booking, config: { block: 'intake', questions: [] } },
    { ...booking, config: { block: 'intake', questions: [null] } },
    { ...booking, config: { ...booking.config, appointment_type: 'a'.repeat(61) } },
    { ...booking, config: { ...booking.config, minutes: NaN } },
    { ...booking, config: { block: 'purpose_payment', purpose: 'Deposit', amount_cents: '500' } },
    { ...booking, config: { block: 'urgent', urgent_when: null } },
  ];
  const jobs = [...malformed, booking] as { title: string; how: string; config: BusinessToolDef['config'] | null }[];
  expect(businessToolRows(jobs).map((row) => row.tool)).toEqual(['desk.book-a-free-intro-call']);
});

it('uses stable definition hashes and the fixed payment and urgent profiles', () => {
  const payment = {
    title: 'Take a deposit', how: 'Sends a deposit link.',
    config: { block: 'purpose_payment' as const, purpose: 'Consultation', amount_cents: 5000 },
  };
  const urgent = {
    title: 'Urgent requests', how: 'Alerts Linda.',
    config: { block: 'urgent' as const, urgent_when: 'a deadline is today' },
  };
  const jobs = [booking, intake, payment, urgent];
  const rows = businessToolRows(jobs);
  expect(rows[2]).toMatchObject({
    effects: ['charge'], reversible: false,
    description_confirmed: "Creates a secure payment link for this purpose, for the amount the owner set.",
  });
  expect(rows[3]).toMatchObject({
    effects: ['change'], reversible: true,
    description_confirmed: "Saves an urgent callback request and alerts the owner right away.",
  });
  for (const row of rows) expect(row.definition_sha256).toMatch(/^[a-f0-9]{64}$/);
  const hashes = (input: typeof jobs) => businessToolRows(input).map((row) => row.definition_sha256);
  expect(hashes(structuredClone(jobs))).toEqual(rows.map((row) => row.definition_sha256));
  expect(new Set(hashes(jobs)).size).toBe(4);
  expect(hashes([{ ...booking, title: 'Different title' }])).not.toEqual(hashes([booking]));
  expect(hashes([{ ...booking, how: 'Different description' }])).not.toEqual(hashes([booking]));
  expect(hashes([{ ...booking, config: { ...booking.config, minutes: 30 } }])).not.toEqual(hashes([booking]));
  expect(hashes([{ ...intake, config: { ...intake.config, questions: ['A different question?'] } }])).not.toEqual(hashes([intake]));
  const duplicates = businessToolRows([booking, booking]);
  expect(duplicates[0]?.definition_sha256).toBe(duplicates[1]?.definition_sha256);
});

it('snapshots each accepted definition so later edits cannot change a pinned row', () => {
  const job = structuredClone(intake);
  const rows = businessToolRows([job, job]);
  const before = structuredClone(rows);
  job.config.questions.push('A later setup edit?');
  expect(rows).toEqual(before);
  const first = rows[0]?.business;
  if (first?.config.block !== 'intake') throw new Error('The first job is intake');
  first.config.questions.push('A local row edit?');
  expect(rows[1]).toEqual(before[1]);
});

it('seeds a Desk with independent business rows whose definitions reach the tools read model', () => {
  mockStore.reset('rivera');
  const desk = [...mockStore.world.desks.values()][0];
  if (!desk) throw new Error('The mock has a Desk');
  seedBusinessTools(desk);
  // Chen's rows, beside the urgent tool every Turner copy already has.
  const chen = new Set(chenBusinessTools.map((row) => row.tool));
  const rows = rulesView(desk).tools.filter((row) => row.source === 'business' && chen.has(row.tool));
  expect(rows.map((row) => row.business)).toEqual(chenBusinessTools.map((row) => row.business));
  expect(rows[0]?.description_confirmed).toBe("Books one open time on the business's calendar for this kind of appointment.");
  const intake = rows[1]?.business;
  if (intake?.config.block !== 'intake') throw new Error('The second job is intake');
  intake.config.questions.push('Changed locally');
  expect(chenBusinessTools[1]?.business?.config).not.toEqual(intake.config);
});
