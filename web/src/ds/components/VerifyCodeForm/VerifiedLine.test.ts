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
  it('only_demo_code_is_labelled_simulated', () => {
    expect(lineText('Verified with a code sent to •••• 0142', 'demo_code', 'en')).toBe(
      'Verified with a code sent to •••• 0142. Simulated verification',
    );
    expect(lineText('Verificado con un código enviado a •••• 0142', 'demo_code', 'es')).toBe(
      'Verificado con un código enviado a •••• 0142. Verificación simulada',
    );
    // Words that already end a sentence take the label after a space, not a second full stop.
    expect(lineText('You confirmed it’s you.', 'demo_code', 'en')).toBe('You confirmed it’s you. Simulated verification');
    // Any other assurance shows the screen's words alone.
    for (const assurance of ['none', 'owner_session'] as const) {
      expect(lineText('Verified with a code sent to •••• 0142', assurance, 'en')).toBe('Verified with a code sent to •••• 0142');
      expect(lineText('Verificado con un código enviado a •••• 0142', assurance, 'es')).toBe(
        'Verificado con un código enviado a •••• 0142',
      );
    }
  });
});
