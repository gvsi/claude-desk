import { describe, expect, test } from 'vitest';

import type { Effect } from '../../../api/contracts.ts';
import { describeEffects, effectPhrases } from './describeEffects.ts';

describe('describeEffects', () => {
  test('money_out_wins', () => {
    expect(describeEffects(['pay_out', 'private_data'], false)).toBe("Moves money out. Can't be undone.");
    // The order the effects arrive in doesn't matter.
    expect(describeEffects(['private_data', 'pay_out'], false)).toBe("Moves money out. Can't be undone.");
  });

  test('charge_reversible', () => {
    expect(describeEffects(['charge'], true)).toBe('Charges money. Can be undone.');
  });

  test('read_only_has_no_suffix', () => {
    expect(describeEffects(['read'], true)).toBe('Changes nothing.');
    expect(describeEffects(['read'], false)).toBe('Changes nothing.');
  });

  test('private_data_alone_has_no_suffix', () => {
    expect(describeEffects(['private_data'], true)).toBe('Touches private data.');
  });

  test('documents_line', () => {
    expect(describeEffects(['private_data', 'send_message'], false)).toBe("Touches private data. Can't be undone.");
    expect(describeEffects(['send_message'], true)).toBe('Sends a message out. Can be undone.');
    expect(describeEffects(['change'], true)).toBe('Changes something. Can be undone.');
  });

  test('effect_phrases_list_every_effect_then_whether_it_can_be_undone', () => {
    // REV-RULES-D's tool details: "Charges money · Can't be undone", every effect in the same words.
    expect(effectPhrases(['charge'], false)).toEqual(['Charges money', "Can't be undone"]);
    expect(effectPhrases(['private_data', 'pay_out'], false)).toEqual(['Moves money out', 'Touches private data', "Can't be undone"]);
    expect(effectPhrases(['change'], true)).toEqual(['Changes something', 'Can be undone']);
    // Reading alone changes nothing; beside another effect it isn't said, since something does change.
    expect(effectPhrases(['read'], false)).toEqual(['Changes nothing']);
    expect(effectPhrases(['read', 'send_message'], true)).toEqual(['Sends a message out', 'Can be undone']);
    expect(effectPhrases(['private_data'], true)).toEqual(['Touches private data']);
    // No effect this build knows is never read as harmless.
    expect(effectPhrases([], false)).toEqual(['Changes something', "Can't be undone"]);
  });

  test('effect_phrases_keep_the_conservative_words_beside_an_unknown_effect', () => {
    // An effect this build doesn't know may change something: it's said, with whether it can be undone,
    // beside the effects it does know, never dropped because one of them is known.
    const future = 'future_effect' as Effect;
    expect(effectPhrases(['private_data', future], false)).toEqual(['Touches private data', 'Changes something', "Can't be undone"]);
    expect(effectPhrases(['private_data', future], true)).toEqual(['Touches private data', 'Changes something', 'Can be undone']);
    expect(effectPhrases(['read', future], false)).toEqual(['Changes something', "Can't be undone"]);
    // Already said by a known change, it isn't said twice.
    expect(effectPhrases(['change', future], false)).toEqual(['Changes something', "Can't be undone"]);
    expect(effectPhrases(['charge', future], false)).toEqual(['Charges money', 'Changes something', "Can't be undone"]);
  });
});
