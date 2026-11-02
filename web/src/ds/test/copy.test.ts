import { afterEach, describe, expect, it } from 'vitest';

import { assertCleanCopy } from './copy.ts';

// Each fragment is attached to the document so computed styles resolve.
function fragment(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function check(html: string): () => void {
  const root = fragment(html);
  return () => assertCleanCopy(root);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('assertCleanCopy', () => {
  it('flags_arrows', () => {
    expect(check('<button>Continue →</button>')).toThrow(/arrow in text: "Continue →"/);
    expect(check('<button aria-label="Next →"></button>')).toThrow(/arrow in aria-label: "Next →"/);
    expect(check('<a href="/more">See more -></a>')).toThrow(/arrow in text/);
    expect(check('<input type="submit" value="Pay ⟶" />')).toThrow(/arrow in value/);
    // Supplemental Arrows-C (U+1F800 to U+1F8FF) are arrows too.
    expect(check('<button>Next \u{1F852}</button>')).toThrow(/arrow in text/);
    const live = fragment('<input type="button" value="Pay" />');
    (live.firstElementChild as HTMLInputElement).value = 'Pay →';
    expect(() => assertCleanCopy(live)).toThrow(/arrow in value: "Pay →"/);
    // Arrows are a design rule, not a voice rule, so user-written text gets no pass.
    expect(check('<p data-copy="user">Go → there</p>')).toThrow(/arrow in text/);
    expect(check('<button>Continue</button>')).not.toThrow();
  });

  it('flags_all_caps_but_allows_acronyms', () => {
    expect(check('<button>SEND NOW</button>')).toThrow(/all caps "SEND", "NOW" in text: "SEND NOW"/);
    expect(check('<input placeholder="SEARCH" />')).toThrow(/all caps "SEARCH" in placeholder/);
    expect(check('<button title="Close PANEL"></button>')).toThrow(/all caps "PANEL" in title/);
    // An option or optgroup shows its label attribute in place of its text.
    expect(check('<select><optgroup label="PICK ONE"><option label="Tuesday">x</option></optgroup></select>')).toThrow(
      /all caps "PICK", "ONE" in label/,
    );
    expect(check('<p>Recibido, ÁREA lista</p>')).toThrow(/all caps "ÁREA"/);
    expect(check('<p>A McDONALD visit</p>')).toThrow(/all caps "DONALD"/);
    for (const acronym of ['I', 'AI', 'PDF', 'QR', 'CPA', 'ZIP', 'SMS', 'USD', 'RFC', 'JSON']) {
      expect(check(`<p>About the ${acronym} here</p>`)).not.toThrow();
    }
    expect(check('<p>I can send both PDFs by SMS.</p>')).not.toThrow();
    // Spanish writes AI as IA: "una IA que responde por Turner Plumbing".
    expect(check('<p lang="es">Estás hablando con Claude, una IA que responde por Turner Plumbing.</p>')).not.toThrow();
    // Someone else's words are shown as they wrote them.
    expect(check('<p data-copy="user">PLEASE CALL ME</p>')).not.toThrow();
  });

  it('allows_a_file_size_in_kilobytes', () => {
    // Settings › Knowledge says how big a file can be, as the board writes it.
    expect(check('<p>Text or Markdown files, up to 100 KB.</p>')).not.toThrow();
    expect(check('<p>That file is too big. Add files up to 100 KB.</p>')).not.toThrow();
    // Only the unit: a longer run of capitals around it still fails.
    expect(check('<p>Up to 100 KBS</p>')).toThrow(/all caps "KBS"/);
  });

  it('allows_the_reading_pages_acronyms', () => {
    // The acronyms the About this prototype documents use, each as they write it.
    for (const word of ['AP2', 'API', 'SymCC', 'CEO', 'CI', 'MCP', 'URL', 'US']) {
      expect(check(`<p>About the ${word} here</p>`), word).not.toThrow();
    }
    // The words on their own, as a label or a heading would show them.
    for (const word of ['AP2', 'SymCC', 'APIs']) expect(check(`<span>${word}</span>`), word).not.toThrow();
    // A plural passes, as "PDFs" does: only the run of capitals is looked up.
    expect(check('<p>Two APIs, three URLs and the CEOs</p>')).not.toThrow();
    expect(check('<p>The SymCC proofs, AP2’s mandates and an MCP server</p>')).not.toThrow();
    // An unlisted run, or a word shouted in capitals, still fails.
    expect(check('<p>The XYZ plan</p>')).toThrow(/all caps "XYZ"/);
    expect(check('<p>WARNING: the API is down</p>')).toThrow(/all caps "WARNING" in text/);
    // AP2 and SymCC pass as whole words, never by their runs: "AP" and "CC" fail on their own or
    // inside any other word.
    expect(check('<p>Ask the AP desk</p>')).toThrow(/all caps "AP"/);
    expect(check('<p>CC the owner</p>')).toThrow(/all caps "CC"/);
    expect(check('<p>The AP3 draft</p>')).toThrow(/all caps "AP"/);
    expect(check('<p>A SymCCC run</p>')).toThrow(/all caps "CCC"/);
    expect(check('<p>The NotSymCC tool</p>')).toThrow(/all caps "CC"/);
    expect(check('<p>Two AP2s</p>')).toThrow(/all caps "AP"/);
  });

  it('flags_exclamation_outside_user_text', () => {
    expect(check('<p>Done!</p>')).toThrow(/exclamation mark in text: "Done!"/);
    expect(check('<p>¡Listo</p>')).toThrow(/exclamation mark in text/);
    expect(check('<button aria-label="Saved!"></button>')).toThrow(/exclamation mark in aria-label/);
    expect(check('<p>Done！</p>')).toThrow(/exclamation mark/);
    expect(check('<p data-copy="user">Thanks so much!</p>')).not.toThrow();
    expect(check('<div data-copy="user"><span>¡Hola!</span></div>')).not.toThrow();
    // The exemption covers only the marked words, not the interface around them.
    expect(check('<div><p data-copy="user">Thanks!</p><p>Sent!</p></div>')).toThrow(/"Sent!"/);
  });

  it('code_is_shown_as_written', () => {
    // An address, a request or a key is machine text: it reads as it is, capitals and all.
    expect(check('<pre data-copy="code">POST /api/a2a/rivera\nX-Agent-Key-Id: demo-7f3a2c</pre>')).not.toThrow();
    expect(check('<code data-copy="code">POST /api/a2a/rivera HTTP/1.1</code>')).not.toThrow();
    // The same words outside code are interface copy, and their capitals fail.
    expect(check('<p>POST /api/a2a/rivera HTTP/1.1</p>')).toThrow(/all caps "POST", "HTTP"/);
    // Arrows are a design rule, so code gets no pass for them, and the label around it none at all.
    expect(check('<code data-copy="code">a -> b</code>')).toThrow(/arrow in text/);
    expect(check('<div><code data-copy="code">POST</code><p>COPY KEY</p></div>')).toThrow(/all caps "COPY", "KEY"/);
  });

  it('ignores_aria_hidden_subtrees', () => {
    expect(check('<span aria-hidden="true">MT</span><span>Mike Turner</span>')).not.toThrow();
    expect(check('<div aria-hidden="true"><span title="NEW">SEND →!</span></div>')).not.toThrow();
    // Only aria-hidden="true" hides; "false" and a missing value are still read.
    expect(check('<span aria-hidden="false">MT</span>')).toThrow(/all caps "MT"/);
    expect(check('<span aria-hidden="">MT</span>')).toThrow(/all caps "MT"/);
    // Style and script text is never shown, in HTML or inside an SVG.
    expect(check('<svg><style>.a{fill:none} /* NOTE -> */</style><title>Turner Plumbing</title></svg>')).not.toThrow();
    expect(check('<svg><title>NEW</title></svg>')).toThrow(/all caps "NEW"/);
  });

  it('allows_capitals_only_on_the_preview_badge', () => {
    // The one all-caps label: the lockup's badge, its word written "Preview" and drawn in capitals.
    expect(check('<span data-ds="preview-badge" style="text-transform: uppercase">Preview</span>')).not.toThrow();
    // Any other word on the badge, or the same word written in capitals, still fails.
    expect(check('<span data-ds="preview-badge" style="text-transform: uppercase">Beta</span>')).toThrow(
      /text-transform uppercase on <span>: "Beta"/,
    );
    expect(check('<span data-ds="preview-badge">PREVIEW</span>')).toThrow(/all caps "PREVIEW"/);
    expect(check('<span data-ds="preview-badge" style="text-transform: uppercase">Preview <b>now</b></span>')).toThrow(/text-transform/);
    // The word in capitals anywhere else still fails, drawn or written.
    expect(check('<span style="text-transform: uppercase">Preview</span>')).toThrow(/text-transform uppercase on <span>: "Preview"/);
    expect(check('<span data-ds="pill" style="text-transform: uppercase">Preview</span>')).toThrow(/text-transform uppercase/);
    expect(check('<p>PREVIEW</p>')).toThrow(/all caps "PREVIEW"/);
    // Small caps are never the badge's look.
    expect(check('<span data-ds="preview-badge" style="font-variant-caps: all-small-caps">Preview</span>')).toThrow(/font-variant-caps/);
  });

  it('flags_uppercase_transform', () => {
    expect(check('<span style="text-transform: uppercase">Needs you</span>')).toThrow(
      /text-transform uppercase on <span>: "Needs you"/,
    );
    // Title case breaks sentence case the same way.
    expect(check('<h2 style="text-transform: capitalize">Needs you</h2>')).toThrow(/text-transform capitalize on <h2>/);
    expect(check('<span style="font-variant-caps: all-small-caps">Needs you</span>')).toThrow(
      /font-variant-caps all-small-caps on <span>/,
    );
    expect(check('<input placeholder="Search" style="text-transform: uppercase" />')).toThrow(/text-transform uppercase on <input>/);
    // Styling someone's own words in capitals still shouts on their behalf.
    expect(check('<p data-copy="user" style="text-transform: uppercase">hello</p>')).toThrow(/text-transform uppercase/);
    expect(check('<span style="text-transform: none">Needs you</span>')).not.toThrow();
    expect(check('<span aria-hidden="true" style="text-transform: uppercase">mr</span>')).not.toThrow();
  });

  it('checks_the_concept_footer', () => {
    const exact = 'Concept prototype by Giovanni Alcantara, not an Anthropic product';
    expect(check(`<footer><p data-ds="concept-footer">${exact}</p></footer>`)).not.toThrow();
    // Read as a person reads it: whitespace collapsed, the aria-hidden mark left out.
    expect(
      check(`<p data-ds="concept-footer"><svg aria-hidden="true"></svg>
        Concept prototype by Giovanni Alcantara,
        not an Anthropic product</p>`),
    ).not.toThrow();
    expect(check('<p data-ds="concept-footer">Concept prototype by Giovanni Alcantara</p>')).toThrow(
      /concept footer reads "Concept prototype by Giovanni Alcantara"/,
    );
    expect(check(`<p data-ds="concept-footer">${exact}.</p>`)).toThrow(/concept footer reads/);
    expect(check(`<p data-ds="concept-footer" aria-hidden="true">${exact}</p>`)).toThrow(/concept footer reads ""/);
    expect(check('<p data-ds="concept-footer">Concept prototype by <b>Giovanni</b> Alcantara<span>,</span> not an Anthropic product</p>')).not.toThrow();
    // The author's name as a link reads the same.
    expect(check('<p data-ds="concept-footer">Concept prototype by <a href="https://example.test/">Giovanni Alcantara</a>, not an Anthropic product</p>')).not.toThrow();
  });

  it('lists_every_problem_in_one_error', () => {
    const run = check('<section><h2>NEEDS YOU</h2><p>Done!</p><button aria-label="Next →">Next</button></section>');
    expect(run).toThrow(Error);
    let message = '';
    try {
      run();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split('\n')).toEqual([
      'Copy check found 3 problems:',
      '- all caps "NEEDS", "YOU" in text: "NEEDS YOU"',
      '- exclamation mark in text: "Done!"',
      '- arrow in aria-label: "Next →"',
    ]);
  });
});
