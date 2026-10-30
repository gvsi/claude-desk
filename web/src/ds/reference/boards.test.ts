/**
 * Ties the reference boards to what checks them: each board's render at its own size (when the
 * renders are on this machine) and the `Boards/*` stories that rebuild the boards from the
 * components, each run at its board's size.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { isExportStory } from 'storybook/internal/csf';
import { describe, expect, it } from 'vitest';

import { BOARD_VIEWPORTS, REFERENCE_BOARDS, boardViewport, isReferenceBoard } from './boards.ts';

/** A PNG's width and height, read from its IHDR chunk, or null when the bytes aren't a PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The board stories' folder, read when the test runs. (An `import.meta.glob` here would be expanded
 * when the test file is transformed, and a cached transform can miss a story added since.)
 */
const BOARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'boards');

interface BoardStory {
  /** "Boards/Today, needs you › Default". */
  id: string;
  /** The story's `parameters.canvas`, its own or its meta's. */
  canvas: unknown;
  /** The Storybook viewport it runs at: its own or its meta's `globals.viewport`, else the preview's "canvas". */
  viewport: unknown;
}

/** The viewport a story or meta's `globals` picks, if any. */
function viewportOf(globals: Record<string, unknown> | undefined): unknown {
  const viewport = globals?.viewport as { value?: unknown } | undefined;
  return viewport?.value;
}

/** Every story in `boards/`, with the board it names. */
async function boardStories(): Promise<BoardStory[]> {
  const files = readdirSync(BOARDS_DIR).filter((file) => file.endsWith('.stories.tsx')).sort();
  const modules = await Promise.all(files.map(async (file) => [file, (await import(/* @vite-ignore */ path.join(BOARDS_DIR, file))) as Record<string, unknown>] as const));
  return modules.flatMap(([file, exports]) => {
    const { default: meta, ...stories } = exports as { default: Meta } & Record<string, StoryObj>;
    if (!meta?.title?.startsWith('Boards/')) throw new Error(`${file}: its title must start with "Boards/", got ${String(meta?.title)}`);
    return Object.entries(stories)
      .filter(([name]) => isExportStory(name, meta))
      .map(([name, story]) => ({
        id: `${meta.title} › ${name}`,
        canvas: story.parameters?.canvas ?? meta.parameters?.canvas,
        viewport: viewportOf(story.globals) ?? viewportOf(meta.globals) ?? 'canvas',
      }));
  });
}

// Importing the board stories transforms every component they use. When the whole suite runs, the
// browser projects compete for the same CPU, so these imports get more than the default 5 s.
const IMPORTS_STORIES = { timeout: 60_000 };

describe('reference boards', () => {
  it('every_reference_board_has_a_render', (context) => {
    const dir = process.env.DS_REFERENCE_DIR;
    if (!dir) {
      context.skip('DS_REFERENCE_DIR is not set: the renders stay off the repository, so this runs where they are');
      return;
    }
    const problems = REFERENCE_BOARDS.flatMap((board) => {
      const file = path.join(dir, `${board}.png`);
      if (!existsSync(file)) return [`${board}: no ${board}.png`];
      const size = pngSize(readFileSync(file));
      if (!size) return [`${board}: ${board}.png is not a PNG`];
      // Each board at the one size it is drawn at: 1280×820, 1512×982 for the laptop boards, or the sidebar's 264×982.
      const want = BOARD_VIEWPORTS[boardViewport(board)];
      return size.width === want.width && size.height === want.height ? [] : [`${board}: ${size.width}×${size.height}, not ${want.width}×${want.height}`];
    });
    expect(problems).toEqual([]);
  });

  it('board_stories_name_reference_boards', IMPORTS_STORIES, async () => {
    const stories = await boardStories();
    expect(stories.length).toBeGreaterThan(0);
    const unnamed = stories.filter(({ canvas }) => !(REFERENCE_BOARDS as readonly unknown[]).includes(canvas));
    expect(unnamed.map(({ id, canvas }) => `${id}: ${JSON.stringify(canvas)}`)).toEqual([]);
  });

  it('every_reference_board_has_a_board_story', IMPORTS_STORIES, async () => {
    const stories = await boardStories();
    // Exactly one: a board rebuilt twice would be checked against itself twice, and differ.
    const counts = REFERENCE_BOARDS.map((board) => {
      const naming = stories.filter(({ canvas }) => canvas === board).map(({ id }) => id);
      return `${board}: ${naming.length === 1 ? 'one story' : `${naming.length} stories${naming.length > 1 ? ` (${naming.join('; ')})` : ''}`}`;
    });
    expect(counts).toEqual(REFERENCE_BOARDS.map((board) => `${board}: one story`));
  });

  it('board_stories_run_at_their_boards_window', IMPORTS_STORIES, async () => {
    // The plays measure the board as drawn, so each runs in the window its board was rendered at.
    const stories = await boardStories();
    const wrong = stories.flatMap(({ id, canvas, viewport }) =>
      isReferenceBoard(canvas) && viewport !== boardViewport(canvas)
        ? [`${id}: runs at ${JSON.stringify(viewport)}, drawn at ${boardViewport(canvas)}`]
        : [],
    );
    expect(wrong).toEqual([]);
    // Both windows are in use, so the check reads the stories' globals as they are written.
    expect(new Set(stories.map(({ viewport }) => viewport))).toEqual(new Set(Object.keys(BOARD_VIEWPORTS)));
  });
});
