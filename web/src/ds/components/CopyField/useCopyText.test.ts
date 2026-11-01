import { describe, expect, it } from 'vitest';

import { copyResultLine, selectText } from './useCopyText.ts';

describe('copyResultLine', () => {
  it('failed_line_names_what_is_selected', () => {
    // A link says the link is selected, as N-R2-Setup-15-Copy-Failed writes it; anything else, the text.
    expect(copyResultLine('failed', { what: 'link' })).toBe('Copy didn’t work. The link is selected, so copy it yourself.');
    expect(copyResultLine('failed', { what: 'text' })).toBe('Copy didn’t work. The text is selected, so copy it yourself.');
    expect(copyResultLine('failed')).toBe('Copy didn’t work. The text is selected, so copy it yourself.');
    // Spanish follows the same pattern, naming the link or the text.
    expect(copyResultLine('failed', { language: 'es', what: 'link' })).toBe('No se pudo copiar. El enlace está seleccionado para que lo copies tú.');
    expect(copyResultLine('failed', { language: 'es' })).toBe('No se pudo copiar. El texto está seleccionado para que lo copies tú.');
  });

  it('copied_and_idle_lines', () => {
    // Before a press the line has no words, so it takes no room; after a copy, the same words for a link or text.
    expect(copyResultLine('idle', { what: 'link' })).toBe('');
    expect(copyResultLine('copied', { what: 'link' })).toBe('Copied.');
    expect(copyResultLine('copied', { language: 'es' })).toBe('Copiado.');
  });
});

describe('selectText', () => {
  it('selects_a_fields_value_or_an_elements_text', () => {
    // A field's value is selected inside the field, so "…is selected…" is true for an input or a text area too.
    const input = document.createElement('input');
    input.value = 'desk.example/rivera';
    const area = document.createElement('textarea');
    area.value = 'Ask Turner Plumbing’s Desk at desk.example/rivera';
    const words = document.createElement('p');
    words.textContent = 'Chat with Turner Plumbing’s Desk anytime.';
    document.body.append(input, area, words);

    selectText(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    selectText(area);
    expect([area.selectionStart, area.selectionEnd]).toEqual([0, area.value.length]);
    // Any other element: its text, through the document's selection.
    selectText(words);
    expect(document.getSelection()?.toString()).toBe('Chat with Turner Plumbing’s Desk anytime.');
    words.remove();
    input.remove();
    area.remove();
  });
});
