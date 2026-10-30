import { describe, expect, test } from 'vitest';

import { describeEffects } from './describeEffects.ts';

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
});
