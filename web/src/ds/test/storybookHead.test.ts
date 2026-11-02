/**
 * Storybook's preview head: it marks the preview's root with the theme a story draws in before the
 * preview first paints, as the story decorator does once a story renders, so a light-preferring
 * device never flashes paper before a dark story, nor dark before a light one.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const HEAD = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.storybook', 'preview-head.html'), 'utf8');

/** The head's script run against a preview whose address has `search`; the root's mark after it. */
function markFor(search: string): string | undefined {
  const script = /<script>([\s\S]*?)<\/script>/.exec(HEAD)?.[1];
  if (script === undefined) throw new Error('the preview head has a script');
  const root = { dataset: {} as Record<string, string> };
  new Function('location', 'document', script)({ search }, { documentElement: root });
  return root.dataset.theme;
}

describe("Storybook's preview head", () => {
  test('it_marks_the_root_dark_unless_the_address_asks_for_light', () => {
    expect(markFor('?id=ds-button--primary&viewMode=story')).toBe('dark');
    expect(markFor('?id=ds-button--primary&globals=theme:light&viewMode=story')).toBe('light');
    // As Storybook writes it back to the address: encoded, beside other globals.
    expect(markFor('?id=ds-button--primary&globals=theme%3Alight&viewMode=story')).toBe('light');
    expect(markFor('?id=x&globals=viewport%3Aphone%3Btheme%3Alight')).toBe('light');
    expect(markFor('?id=x&globals=theme:dark')).toBe('dark');
    // Something that only looks like it, or a malformed address, draws dark.
    expect(markFor('?id=x&globals=theme:lighter')).toBe('dark');
    expect(markFor('?id=x&globals=%E0%A4%A')).toBe('dark');
    expect(markFor('')).toBe('dark');
  });
});
