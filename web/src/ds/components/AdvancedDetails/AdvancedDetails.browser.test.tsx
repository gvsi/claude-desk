import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { AdvancedDetails } from './AdvancedDetails.tsx';
import { jsonText } from './detailsJson.ts';

afterEach(() => vi.restoreAllMocks());

it('wraps long JSON values at 390 and 1440 under their own indentation and copies the exact text', async () => {
  const value = {
    description: 'Makes a one-time link for a quote, with the customer’s name and the agreed work. '.repeat(12),
    tools: [{ description: 'description_without_breaks_'.repeat(40), escaped: 'Says "hi"\nthen <b>bye</b>' }],
    effects: ['charge'],
  };
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  for (const width of [390, 1440]) {
    await page.viewport(width, width === 390 ? 844 : 900);
    const screen = await render(
      <div style={{ maxWidth: 738, padding: 'var(--space-16)' }}>
        <AdvancedDetails fields={[]} code={{ label: 'As your Desk lists it', value }} onCopy={(text) => navigator.clipboard.writeText(text)}>
          {(toggle) => toggle}
        </AdvancedDetails>
      </div>,
    );
    await screen.getByRole('button', { name: 'Details' }).click();
    await document.fonts.ready;
    const pre = screen.container.querySelector('pre')!;
    expect(pre.scrollWidth, `JSON width at ${width}`).toBeLessThanOrEqual(pre.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(pre.textContent).toBe(jsonText(value));

    // Measure real rendered fragments at two nesting depths, including an unbroken string.
    for (const key of pre.querySelectorAll('.cd-advanced-details__json-key')) {
      if (key.textContent !== '"description"') continue;
      const text = key.nextElementSibling!.nextElementSibling!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const fragments = [...range.getClientRects()];
      expect(fragments.length, `description wraps at ${width}`).toBeGreaterThan(1);
      const start = key.getBoundingClientRect().left;
      const blockStart = pre.getBoundingClientRect().left + parseFloat(getComputedStyle(pre).paddingLeft);
      expect(start).toBeGreaterThan(blockStart);
      for (const continuation of fragments.slice(1)) {
        expect(continuation.left, `continuation at ${width}`).toBeGreaterThanOrEqual(start - 0.5);
      }
    }
    await screen.getByRole('button', { name: 'Copy', exact: true }).click();
    expect(writeText).toHaveBeenLastCalledWith(jsonText(value));
    await screen.unmount();
  }
});
