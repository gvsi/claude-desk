import { afterEach, describe, expect, it } from 'vitest';

import { expectComputed } from './expectComputed.ts';

function element(style: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('style', style);
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('expectComputed', () => {
  it('matches_strings_exactly_and_regexps_by_test', () => {
    const el = element('display: flex; width: 264px; padding-top: 24px');
    expect(() => expectComputed(el, { display: 'flex', width: '264px', paddingTop: /^24px$/ })).not.toThrow();
    // Strings are exact: no substring or prefix match.
    expect(() => expectComputed(el, { width: '264' })).toThrow(/width: expected "264", got "264px"/);
    expect(() => expectComputed(el, { paddingTop: /^20px$/ })).toThrow(/paddingTop: expected \/\^20px\$\/, got "24px"/);
    // A global RegExp is tested from the start every time.
    const global = /264px/g;
    expect(() => expectComputed(el, { width: global })).not.toThrow();
    expect(() => expectComputed(el, { width: global })).not.toThrow();
  });

  it('lists_every_mismatch_in_one_error', () => {
    const el = element('display: flex; width: 264px');
    el.dataset.ds = 'sidebar';
    expect(() => expectComputed(el, { display: 'grid', width: '220px', position: 'static' })).toThrow(
      'Computed style of <div data-ds="sidebar"> differs:\n- display: expected "grid", got "flex"\n- width: expected "220px", got "264px"',
    );
    // An empty expectation would prove nothing, so it fails.
    expect(() => expectComputed(el, {})).toThrow(/nothing to check/);
  });
});
