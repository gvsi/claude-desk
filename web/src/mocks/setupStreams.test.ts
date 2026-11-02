/**
 * The mock's streamed setup turns, as the screens' event stream follows them: the request answers
 * busy at once with the owner's words, the turn's reads and reply stream, and the turn shows in the
 * interview only once its stream says `done`. A turn a test holds is followed until it lands, and
 * with no turn running a stream hears `done` with no run at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RouteKey } from '../api/routes.ts';
import type { SetupState } from '../api/views.ts';
import { START_EXAMPLES } from '../setup/copy.ts';
import { CPA_COPY, holdNextAnswer, MEMORY_LABEL } from './setup.ts';
import { mockStore } from './store.ts';

const CPA = START_EXAMPLES.en.examples[3]!.description;

let starts = 0;

async function startState(description = CPA): Promise<SetupState> {
  const answer = await mockStore.dispatch('startSetup', { body: { description, timezone: 'America/Los_Angeles', idempotency_key: `streamed-${++starts}` } });
  if ('network' in answer || answer.status !== 201) throw new Error('setup must start');
  return answer.body as SetupState;
}

async function send(key: RouteKey, id: string, body?: unknown): Promise<{ status: number; state: SetupState }> {
  const answer = await mockStore.dispatch(key, { params: { id }, query: { cards: '1' }, body });
  if ('network' in answer) throw new Error(`${key} must answer`);
  return { status: answer.status, state: answer.body as SetupState };
}

async function read(id: string): Promise<SetupState> {
  return (await send('setup', id)).state;
}

/** Follows interview `id`'s turn, keeping every event and whether the stream closed. */
function follow(id: string) {
  const heard: [string, Record<string, unknown>][] = [];
  let closed = false;
  const stop = mockStore.followSetup(id, {
    send: (name, data) => heard.push([name, data]),
    close: () => {
      closed = true;
    },
  });
  return { heard, closed: () => closed, stop };
}

const named = (heard: [string, Record<string, unknown>][], name: string) => heard.filter(([n]) => n === name).map(([, data]) => data);

beforeEach(() => {
  mockStore.reset('rivera');
});

describe('streamed setup turns', () => {
  it('answers_busy_at_once_and_lands_the_reply_when_its_stream_ends', async () => {
    const started = await startState();
    const id = started.interview_id;
    await send('setupConsent', id, { allow: true });
    mockStore.streamSetupTurns(true, { answersAtOnce: true });
    const before = await read(id);
    const answered = await send('setupAnswer', id, { question: before.question, text: 'Both, about evenly' });
    expect(answered.status).toBe(202);
    expect(answered.state.busy).toBe(true);
    expect(answered.state.messages).toEqual([...before.messages, { role: 'owner', text: 'Both, about evenly', choices: [], card: null }]);
    expect((await read(id)).messages).toEqual(answered.state.messages);

    const stream = follow(id);
    await vi.waitFor(() => expect(stream.closed()).toBe(true));
    const deltas = named(stream.heard, 'delta').map(({ text }) => text as string);
    expect(deltas.length).toBeGreaterThan(1);
    // Each delta is the whole reply so far, and the last is the reply the interview saves.
    deltas.forEach((text, at) => expect(text.startsWith(deltas[at - 1] ?? '')).toBe(true));
    const landed = await read(id);
    expect(landed.busy).toBe(false);
    const reply = landed.messages.slice(answered.state.messages.length).filter((m) => m.role === 'claude' && m.card === null && m.text !== '' && m.choices.length === 0);
    expect(deltas.at(-1)).toBe(reply.map((m) => m.text).join('\n\n'));
    const run = named(stream.heard, 'delta')[0]?.run;
    expect(typeof run).toBe('string');
    expect(stream.heard.at(-1)).toEqual(['done', { run }]);
    // No choices, cards or step ever ride on a delta.
    for (const data of named(stream.heard, 'delta')) expect(Object.keys(data).sort()).toEqual(['run', 'text']);
  });

  it('holds_an_answer_until_its_streamed_turn_lands_then_answers_200_with_it', async () => {
    const id = (await startState()).interview_id;
    await send('setupConsent', id, { allow: true });
    mockStore.streamSetupTurns();
    const before = await read(id);
    const answering = send('setupAnswer', id, { question: before.question, text: 'Both, about evenly' });
    let answered = false;
    void answering.then(() => {
      answered = true;
    });
    // While the request waits, the interview reads busy with the owner's words.
    const meanwhile = await read(id);
    expect(meanwhile.busy).toBe(true);
    expect(meanwhile.messages.at(-1)).toMatchObject({ role: 'owner', text: 'Both, about evenly' });
    const stream = follow(id);
    await vi.waitFor(() => expect(stream.closed()).toBe(true));
    // The stream says done, then the request answers with the landed turn.
    expect(stream.heard.at(-1)?.[0]).toBe('done');
    const { status, state } = await answering;
    expect(answered).toBe(true);
    expect(status).toBe(200);
    expect(state.busy).toBe(false);
    expect(state).toEqual(await read(id));
  });

  it('reads_first_then_writes_after_yes_use_it', async () => {
    const id = (await startState()).interview_id;
    mockStore.streamSetupTurns();
    const consented = await send('setupConsent', id, { allow: true });
    expect(consented.status).toBe(202);
    expect(consented.state).toMatchObject({ busy: true, consent: true });
    expect(consented.state.messages.at(-1)).toMatchObject({ role: 'owner', text: 'Yes, use it' });
    const stream = follow(id);
    await vi.waitFor(() => expect(stream.closed()).toBe(true));
    // The reads run at once: one reading per read in the order the interview saves their labels
    // (the memory first), then each label in that same order with the saved words, then the reply.
    const saved = (await read(id)).messages.filter((m) => m.role === 'tool_label').map((m) => m.text);
    expect(saved[0]).toBe(MEMORY_LABEL);
    const names = stream.heard.map(([name]) => name);
    expect(names.slice(0, saved.length * 2)).toEqual([...saved.map(() => 'reading'), ...saved.map(() => 'label')]);
    const reads = named(stream.heard, 'reading').map(({ read: what }) => what);
    expect(reads[0]).toBe('memory');
    expect(named(stream.heard, 'label').map(({ read: what }) => what)).toEqual(reads);
    expect(named(stream.heard, 'label').map(({ text }) => text)).toEqual(saved);
    expect(new Set(names.slice(saved.length * 2, -1))).toEqual(new Set(['delta']));
    expect(names.at(-1)).toBe('done');
    // The first question, with its choices, docks once the turn lands: it isn't part of the reply.
    expect(named(stream.heard, 'delta').at(-1)?.text).toBe(CPA_COPY.opening.join('\n\n'));
  });

  it('gives_a_late_stream_every_read_started_and_ended_in_order', async () => {
    const id = (await startState()).interview_id;
    mockStore.streamSetupTurns();
    let release: () => void = () => {};
    mockStore.planStream('setup', {
      pauseAfter: 1,
      until: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    await send('setupConsent', id, { allow: true });
    const first = follow(id);
    await vi.waitFor(() => expect(named(first.heard, 'delta')).toHaveLength(1));
    // Comes in after the reads ended: it hears them in the same order, then the reply so far.
    const late = follow(id);
    expect(late.heard).toEqual(first.heard);
    release();
    await vi.waitFor(() => expect(late.closed()).toBe(true));
  });

  it('writes_with_no_reads_after_no_i_will_type_it', async () => {
    const id = (await startState()).interview_id;
    mockStore.streamSetupTurns();
    expect((await send('setupConsent', id, { allow: false })).status).toBe(202);
    const stream = follow(id);
    await vi.waitFor(() => expect(stream.closed()).toBe(true));
    expect(stream.heard.map(([name]) => name).filter((name) => name !== 'delta')).toEqual(['done']);
  });

  it('gives_a_late_stream_the_reply_so_far_then_follows_it', async () => {
    const id = (await startState()).interview_id;
    await send('setupConsent', id, { allow: false });
    let release: () => void = () => {};
    mockStore.planStream('setup', {
      pauseAfter: 2,
      until: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    mockStore.streamSetupTurns();
    const question = (await read(id)).question;
    const answering = send('setupAnswer', id, { question, text: 'Mostly individuals' });
    const first = follow(id);
    await vi.waitFor(() => expect(named(first.heard, 'delta')).toHaveLength(2));
    const late = follow(id);
    expect(late.heard).toEqual([['delta', named(first.heard, 'delta')[1]]]);
    release();
    await vi.waitFor(() => expect(late.closed()).toBe(true));
    expect(late.heard.at(-1)?.[0]).toBe('done');
    expect((await answering).status).toBe(200);
  });

  it('says_done_with_no_run_when_nothing_runs', async () => {
    const id = (await startState()).interview_id;
    const stream = follow(id);
    expect(stream.heard).toEqual([['done', { run: null }]]);
    expect(stream.closed()).toBe(true);
  });

  it('follows_a_held_turn_until_it_lands', async () => {
    const id = (await startState()).interview_id;
    await send('setupConsent', id, { allow: false });
    const question = (await read(id)).question;
    const land = holdNextAnswer(mockStore.world, id);
    expect((await send('setupAnswer', id, { question, text: 'Mostly individuals' })).state.busy).toBe(true);
    const stream = follow(id);
    expect(stream.heard).toEqual([]);
    land();
    expect(stream.heard).toHaveLength(1);
    expect(stream.heard[0]?.[0]).toBe('done');
    expect(stream.closed()).toBe(true);
  });

  it('lands_in_the_request_when_turns_do_not_stream', async () => {
    const id = (await startState()).interview_id;
    const consented = await send('setupConsent', id, { allow: true });
    expect(consented.status).toBe(200);
    expect(consented.state.busy).toBe(false);
  });
});
