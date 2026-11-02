/**
 * Pretty JSON for the details disclosure, as REV-RULES-D draws it: a 2-space indent, an object's
 * fields one per line, a list of plain values on one line (`["charge"]`) and a list holding objects
 * or lists one entry per line. It reads back as the same value (`JSON.parse`), and a field left
 * undefined is left out, as `JSON.stringify` leaves it out.
 */

/** One run of the text: a key, a string, another value (a number, a boolean, null), punctuation, or the layout between them. */
export interface JsonToken {
  kind: 'key' | 'string' | 'value' | 'punct' | 'space';
  text: string;
}

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What JSON leaves out of an object: undefined, a function, a symbol. */
const leftOut = (value: unknown) => value === undefined || typeof value === 'function' || typeof value === 'symbol';

function push(tokens: JsonToken[], value: unknown, depth: number): void {
  const pad = (level: number) => `\n${'  '.repeat(level)}`;
  if (isList(value)) {
    if (value.length === 0) {
      tokens.push({ kind: 'punct', text: '[]' });
      return;
    }
    // A list of plain values reads on one line; one holding objects or lists, an entry per line.
    const flat = value.every((entry) => !isList(entry) && !isObject(entry));
    tokens.push({ kind: 'punct', text: '[' });
    value.forEach((entry, index) => {
      if (index > 0) tokens.push({ kind: 'punct', text: flat ? ', ' : ',' });
      if (!flat) tokens.push({ kind: 'space', text: pad(depth + 1) });
      // A list keeps its length: what JSON can't write there reads as null, as JSON.stringify writes it.
      push(tokens, leftOut(entry) ? null : entry, depth + 1);
    });
    if (!flat) tokens.push({ kind: 'space', text: pad(depth) });
    tokens.push({ kind: 'punct', text: ']' });
    return;
  }
  if (isObject(value)) {
    const fields = Object.entries(value).filter(([, field]) => !leftOut(field));
    if (fields.length === 0) {
      tokens.push({ kind: 'punct', text: '{}' });
      return;
    }
    tokens.push({ kind: 'punct', text: '{' });
    fields.forEach(([key, field], index) => {
      if (index > 0) tokens.push({ kind: 'punct', text: ',' });
      tokens.push({ kind: 'space', text: pad(depth + 1) });
      tokens.push({ kind: 'key', text: JSON.stringify(key) });
      tokens.push({ kind: 'punct', text: ': ' });
      push(tokens, field, depth + 1);
    });
    tokens.push({ kind: 'space', text: pad(depth) });
    tokens.push({ kind: 'punct', text: '}' });
    return;
  }
  if (typeof value === 'string') {
    tokens.push({ kind: 'string', text: JSON.stringify(value) });
    return;
  }
  // A number, a boolean or null, as JSON writes it (a number JSON can't hold reads as null).
  tokens.push({ kind: 'value', text: JSON.stringify(value) ?? 'null' });
}

/** The value's JSON as runs of text to tint. Joined, they are `jsonText(value)`. */
export function jsonTokens(value: unknown): JsonToken[] {
  const tokens: JsonToken[] = [];
  push(tokens, leftOut(value) ? null : value, 0);
  return tokens;
}

/** The value's pretty JSON, exactly as the block shows it and Copy copies it. */
export function jsonText(value: unknown): string {
  return jsonTokens(value).map((token) => token.text).join('');
}
