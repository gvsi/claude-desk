import { afterEach, expect, it } from 'vitest';

import { expectUserText } from './expectUserText.ts';

const TITLE = 'Approved by your accountant';

function fragment(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

it('passes when every place the words show is its own user-text element', () => {
  const root = fragment(`<p>Applies to every tool: <span data-copy="user">Quote</span> and <span data-copy="user">${TITLE}</span>.</p><h3><span data-copy="user">${TITLE}</span></h3>`);
  expect(expectUserText(root, TITLE)).toBe(2);
});

it('fails when the words never show', () => {
  expect(() => expectUserText(fragment('<p>Quote</p>'), TITLE)).toThrow(/never shows/);
});

it('fails when an app sentence holds the words in the same text node', () => {
  expect(() => expectUserText(fragment(`<p>Applies to every tool: ${TITLE}.</p>`), TITLE)).toThrow(/not its own user-text element/);
});

it('fails when the words are unmarked in an element of their own', () => {
  expect(() => expectUserText(fragment(`<p>Applies to: <span>${TITLE}</span>.</p>`), TITLE)).toThrow(/not its own user-text element/);
});

it('fails when the user-text element also holds the app words', () => {
  expect(() => expectUserText(fragment(`<p data-copy="user">Applies to: <span>${TITLE}</span>.</p>`), TITLE)).toThrow(/not its own user-text element/);
});
