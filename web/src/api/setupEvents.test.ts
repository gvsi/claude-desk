/**
 * The running setup turn's events as the screen reads them: each event's data checked against its
 * name, anything else dropped.
 */
import { describe, expect, it } from 'vitest';

import { readSetupEvent } from './setupEvents.ts';

describe('readSetupEvent', () => {
  it('reads_each_event_the_contract_names', () => {
    expect(readSetupEvent('delta', '{"run":"r_1","text":"Got it: leaks"}')).toEqual({ type: 'delta', run: 'r_1', text: 'Got it: leaks' });
    expect(readSetupEvent('reset', '{"run":"r_1"}')).toEqual({ type: 'reset', run: 'r_1' });
    expect(readSetupEvent('done', '{"run":"r_1"}')).toEqual({ type: 'done', run: 'r_1' });
    expect(readSetupEvent('done', '{"run":null}')).toEqual({ type: 'done', run: null });
    expect(readSetupEvent('error', '{"run":"r_1","error":"model_unavailable"}')).toEqual({ type: 'error', run: 'r_1', error: 'model_unavailable' });
    expect(readSetupEvent('reading', '{"run":"r_2","read":"website","host":"chenco-cpa.example"}')).toEqual({
      type: 'reading',
      run: 'r_2',
      read: 'website',
      host: 'chenco-cpa.example',
    });
    expect(readSetupEvent('reading', '{"run":"r_2","read":"memory","host":null}')).toEqual({ type: 'reading', run: 'r_2', read: 'memory', host: null });
    expect(readSetupEvent('reading', '{"run":"r_2","read":"web_search","host":null}')).toEqual({ type: 'reading', run: 'r_2', read: 'web_search', host: null });
    expect(readSetupEvent('label', '{"run":"r_2","read":"memory","text":"Searched your Claude memory"}')).toEqual({
      type: 'label',
      run: 'r_2',
      read: 'memory',
      text: 'Searched your Claude memory',
    });
  });

  it('drops_what_it_cannot_trust', () => {
    // Not JSON, not an object, or a name the contract doesn't have.
    expect(readSetupEvent('delta', 'Got it')).toBeNull();
    expect(readSetupEvent('delta', '["r_1","Got it"]')).toBeNull();
    expect(readSetupEvent('message', '{"run":"r_1","text":"Got it"}')).toBeNull();
    expect(readSetupEvent('choices', '{"run":"r_1","choices":[]}')).toBeNull();
    // Fields missing or of the wrong kind.
    expect(readSetupEvent('delta', '{"run":"r_1"}')).toBeNull();
    expect(readSetupEvent('delta', '{"text":"Got it"}')).toBeNull();
    expect(readSetupEvent('delta', '{"run":7,"text":"Got it"}')).toBeNull();
    expect(readSetupEvent('done', '{}')).toBeNull();
    expect(readSetupEvent('error', '{"run":"r_1"}')).toBeNull();
    expect(readSetupEvent('reading', '{"run":"r_2","read":"files","host":null}')).toBeNull();
    expect(readSetupEvent('reading', '{"run":"r_2","read":"search","host":null}')).toBeNull();
    expect(readSetupEvent('label', '{"run":"r_2","read":"memory"}')).toBeNull();
  });

  it('takes_only_the_reply_text_from_a_delta', () => {
    // Choices, cards, the plan, the question and the step never come from a delta.
    expect(readSetupEvent('delta', '{"run":"r_1","text":"Got it","choices":[{"text":"Yes"}],"question":"money_limit","step":"tools"}')).toEqual({
      type: 'delta',
      run: 'r_1',
      text: 'Got it',
    });
  });
});
