/**
 * Proves the project-level story hooks fail a story, using inline stories composed under the
 * same annotations as every real story (the preview and the a11y addon, set in browser-setup.ts).
 * Each test also runs a clean twin, so a rejection means the hook caught that one problem.
 */
import { composeStory } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

const meta = { title: 'Test/Story hooks' };
const noBoard = { canvas: 'none', canvasNote: 'A probe story for the story hook tests.' };

function probe(render: () => ReactElement, parameters: Record<string, unknown> = noBoard) {
  return composeStory({ render, parameters }, meta, undefined, 'Probe');
}

function a11yStatus(story: ReturnType<typeof probe>): string | undefined {
  return story.reporting.reports.find((report) => report.type === 'a11y')?.status;
}

describe('story hooks', () => {
  it('copy_hook_fails_a_story', async () => {
    await expect(probe(() => <p>Send it now.</p>).run()).resolves.toBeUndefined();
    await expect(probe(() => <p>SEND NOW!</p>).run()).rejects.toThrow(
      /all caps "SEND", "NOW" in text: "SEND NOW!"[\s\S]*exclamation mark in text: "SEND NOW!"/,
    );
  });

  it('axe_fails_a_story', async () => {
    const labelled = probe(() => (
      <label>
        Your name <input />
      </label>
    ));
    await labelled.run();
    expect(a11yStatus(labelled)).toBe('passed');
    // The storybook project turns a failed report into a failed test; here we read the report.
    const unlabelled = probe(() => <input />);
    await unlabelled.run();
    expect(a11yStatus(unlabelled)).toBe('failed');
  });

  it('canvas_parameter_is_required', async () => {
    const text = () => <p>Reply checked against Mike Turner’s rules.</p>;
    await expect(probe(text, {}).run()).rejects.toThrow(/parameters\.canvas/);
    await expect(probe(text, { canvas: 'none' }).run()).rejects.toThrow(/canvasNote/);
    await expect(probe(text, { canvas: 'none', canvasNote: '  ' }).run()).rejects.toThrow(/canvasNote/);
    await expect(probe(text, { canvas: 'N-Conv-Run1' }).run()).resolves.toBeUndefined();
    await expect(probe(text, noBoard).run()).resolves.toBeUndefined();
  });

  it('unknown_board_fails', async () => {
    const text = () => <p>Reply checked against Mike Turner’s rules.</p>;
    await expect(probe(text, { canvas: 'N-Nope' }).run()).rejects.toThrow(/"N-Nope"/);
    // Only the current N- boards count; an older board name is unknown too, as is a board that
    // left the reference list.
    await expect(probe(text, { canvas: 'Today-NeedsYou' }).run()).rejects.toThrow(/"Today-NeedsYou"/);
    await expect(probe(text, { canvas: 'N-Conv-Live' }).run()).rejects.toThrow(/"N-Conv-Live"/);
  });
});
