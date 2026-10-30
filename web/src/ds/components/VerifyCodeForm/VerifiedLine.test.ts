import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Assurance } from '../../../api/contracts.ts';
import { VerifiedLine } from './VerifiedLine.tsx';

/** The words the line shows. */
function lineText(text: string, assurance: Assurance, language: 'en' | 'es'): string {
  const html = renderToStaticMarkup(createElement(VerifiedLine, { text, assurance, language }));
  const words = /<span class="cd-system-line__text">([^<]*)<\/span>/.exec(html)?.[1];
  if (words === undefined) throw new Error(`no line text in ${html}`);
  return words;
}

describe('VerifiedLine', () => {
  it('every_assurance_but_the_owner_session_is_labelled_simulated', () => {
    expect(lineText('Verified with a code sent to •••• 0142', 'demo_code', 'en')).toBe(
      'Verified with a code sent to •••• 0142. Simulated verification',
    );
    expect(lineText('Verificado con un código enviado a •••• 0142', 'demo_code', 'es')).toBe(
      'Verificado con un código enviado a •••• 0142. Verificación simulada',
    );
    // Words that already end a sentence take the label after a space, not a second full stop.
    expect(lineText('You confirmed it’s you.', 'demo_code', 'en')).toBe('You confirmed it’s you. Simulated verification');
    // The label fails toward honesty: every assurance but the owner's own session carries it,
    // `none` and a value this build doesn't know included.
    const unverifiedOrUnknown: Assurance[] = ['none', 'sms_code' as Assurance, '' as Assurance];
    for (const assurance of unverifiedOrUnknown) {
      expect(lineText('Verified with a code sent to •••• 0142', assurance, 'en')).toBe(
        'Verified with a code sent to •••• 0142. Simulated verification',
      );
      expect(lineText('Verificado con un código enviado a •••• 0142', assurance, 'es')).toBe(
        'Verificado con un código enviado a •••• 0142. Verificación simulada',
      );
    }
    // Only the owner's own session shows the screen's words alone.
    expect(lineText('Verified with a code sent to •••• 0142', 'owner_session', 'en')).toBe('Verified with a code sent to •••• 0142');
    expect(lineText('Verificado con un código enviado a •••• 0142', 'owner_session', 'es')).toBe(
      'Verificado con un código enviado a •••• 0142',
    );
  });
});
