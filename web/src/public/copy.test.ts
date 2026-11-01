import { expect, it } from 'vitest';

import { PUBLIC_COPY } from './copy.ts';

it('ends the English ask-for message with one sentence stop after the owner name', () => {
  expect(PUBLIC_COPY.en.askForOwner('Bob Smith Jr.')).toBe("I'd like to talk to Bob Smith Jr.");
  expect(PUBLIC_COPY.en.askForOwner('Maria Rivera')).toBe("I'd like to talk to Maria Rivera.");
  expect(PUBLIC_COPY.en.askForOwner('Bob!')).toBe("I'd like to talk to Bob!");
  expect(PUBLIC_COPY.en.askForOwner('Bob?')).toBe("I'd like to talk to Bob?");
});

it('ends the Spanish ask-for message with one sentence stop after the owner name', () => {
  expect(PUBLIC_COPY.es.askForOwner('Bob Smith Jr.')).toBe('Me gustaría hablar con Bob Smith Jr.');
  expect(PUBLIC_COPY.es.askForOwner('Maria Rivera')).toBe('Me gustaría hablar con Maria Rivera.');
  expect(PUBLIC_COPY.es.askForOwner('Bob!')).toBe('Me gustaría hablar con Bob!');
  expect(PUBLIC_COPY.es.askForOwner('Bob?')).toBe('Me gustaría hablar con Bob?');
});
