import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { RenderedBlock } from '../api/contracts.ts';
import { request } from '../api/http.ts';
import { rivera } from '../ds/fixtures/index.ts';
import type { ChatRow } from './chatReducer.ts';
import { paymentLinkMemory } from './paymentLinks.ts';
import { usePaymentLinks } from './usePaymentLinks.ts';

vi.mock('../api/http.ts', () => ({ request: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const read = vi.mocked(request);
let root: Root;
let projected: RenderedBlock[];
let memory = paymentLinkMemory();

function row(id: string, blocks: RenderedBlock[]): ChatRow {
  return { receipts: [], item: { kind: 'message', seq: 1, ev: {
    type: 'message', message_id: id, generation: 0, author: 'desk', language: 'en',
    handoff: false, blocks, visitor_plain: '', ledger_seq: 1, signature: '',
  } } };
}

const link = (token: string) => ({ ...rivera.blocks.payment_link.en, href: `/pay/${token}`, fact_id: `payment_link:${token}` });
function Harness({ rows }: { rows: ChatRow[] }) {
  const project = usePaymentLinks(rows.flatMap(({ item }) => (item.kind === 'message' ? [item.ev] : [])), memory);
  projected = rows.flatMap(({ item }) => item.kind === 'message' ? item.ev.blocks.map(project) : []);
  return null;
}
const draw = async (rows: ChatRow[]) => act(async () => { root.render(createElement(StrictMode, null, createElement(Harness, { rows }))); });
async function visibilityReturn() {
  await act(async () => {
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
}

beforeEach(() => {
  root = createRoot(document.createElement('div'));
  read.mockReset();
  memory = paymentLinkMemory();
});
afterEach(async () => {
  await act(async () => root.unmount());
  Reflect.deleteProperty(document, 'visibilityState');
  vi.restoreAllMocks();
});

it('reads only the open token on visibility returns, at most once per thirty seconds', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  read.mockImplementation(async (_key, opts) => ({ state: opts?.params?.token === 'open' ? 'issued' : opts?.params?.token } as never));
  const rows = [row('links', ['paid', 'cancelled', 'expired', 'open'].map(link))];
  await draw(rows);
  expect(read).toHaveBeenCalledTimes(4);
  expect(projected.map((block) => block.href)).toEqual([null, null, null, '/pay/open']);
  read.mockClear();
  await visibilityReturn();
  expect(read.mock.calls.map(([, opts]) => opts?.params)).toEqual([{ token: 'open' }]);
  clock.mockReturnValue(129_999);
  await visibilityReturn();
  expect(read).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(130_000);
  await visibilityReturn();
  expect(read).toHaveBeenCalledTimes(2);
});

it('retains closed tokens and the visibility bound across a chat page remount', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  read.mockResolvedValue({ state: 'paid' } as never);
  const rows = [row('links', [link('paid')])];
  await draw(rows);
  await act(async () => root.unmount());
  root = createRoot(document.createElement('div'));
  await draw(rows);
  await visibilityReturn();
  expect(read).toHaveBeenCalledTimes(1);
  expect(projected[0]?.href).toBeNull();
  // A new chat gets fresh memory, even if its test fixture reuses the token.
  memory = paymentLinkMemory();
  read.mockResolvedValue({ state: 'issued' } as never);
  await draw(rows);
  await visibilityReturn();
  expect(read).toHaveBeenCalledTimes(3);
  await act(async () => root.unmount());
  root = createRoot(document.createElement('div'));
  await draw(rows);
  clock.mockReturnValue(129_999);
  await visibilityReturn();
  expect(read).toHaveBeenCalledTimes(4); // Mount read only; visibility budget survived.
});

it('follows a pending issued answer once when a confirmation arrived during it', async () => {
  let release!: (value: never) => void;
  read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  read.mockResolvedValue({ state: 'paid' } as never);
  const rows = [row('links', [link('deposit')])];
  await draw(rows);
  await draw([...rows, row('paid', [{ ...rivera.blocks.payment_confirmed.en }])]);
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => release({ state: 'issued' } as never));
  expect(read).toHaveBeenCalledTimes(2);
  expect(projected[0]?.href).toBeNull();
});

it('reads an open link again when a charge is confirmed, since that charge may have paid its quote', async () => {
  read.mockResolvedValueOnce({ state: 'issued' } as never);
  read.mockResolvedValue({ state: 'cancelled' } as never);
  const rows = [row('links', [link('deposit')])];
  await draw(rows);
  expect(projected[0]?.href).toBe('/pay/deposit');
  await draw([...rows, row('charged', [{ ...rivera.blocks.charge_confirmed.en }])]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(projected[0]?.href).toBeNull();
});

it.each(['null', 'throw'])('keeps the button and handles a malformed successful read: %s', async (kind) => {
  const body = kind === 'null' ? null : { get state() { throw new Error('unreadable state'); } };
  read.mockResolvedValue(body as never);
  await draw([row('links', [link('deposit')])]);
  expect(projected[0]?.href).toBe('/pay/deposit');
});
