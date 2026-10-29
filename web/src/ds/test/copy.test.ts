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
    for (const acronym of ['I', 'AI', 'PDF', 'QR', 'CPA', 'ZIP', 'SMS', 'USD']) {
      expect(check(`<p>About the ${acronym} here</p>`)).not.toThrow();
    }
    expect(check('<p>I can send both PDFs by SMS.</p>')).not.toThrow();
    // Someone else's words are shown as they wrote them.
    expect(check('<p data-copy="user">PLEASE CALL ME</p>')).not.toThrow();
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

  it('ignores_aria_hidden_subtrees', () => {
    expect(check('<span aria-hidden="true">MR</span><span>Maria Rivera</span>')).not.toThrow();
    expect(check('<div aria-hidden="true"><span title="NEW">SEND →!</span></div>')).not.toThrow();
    // Only aria-hidden="true" hides; "false" and a missing value are still read.
    expect(check('<span aria-hidden="false">MR</span>')).toThrow(/all caps "MR"/);
    expect(check('<span aria-hidden="">MR</span>')).toThrow(/all caps "MR"/);
    // Style and script text is never shown, in HTML or inside an SVG.
    expect(check('<svg><style>.a{fill:none} /* NOTE -> */</style><title>Rivera Plumbing</title></svg>')).not.toThrow();
    expect(check('<svg><title>NEW</title></svg>')).toThrow(/all caps "NEW"/);
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
