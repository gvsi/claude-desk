/**
 * Ties the reference boards to what checks them: each board's render at the size its board is drawn
 * at (when the renders are on this machine) and the `Boards/*` stories that rebuild the boards from the components.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { isExportStory } from 'storybook/internal/csf';
import { describe, expect, it } from 'vitest';

import { REFERENCE_BOARDS } from './boards.ts';

/** The size the signed owner, public and first-visit boards are rendered at, as the Storybook "Canvas" viewport. */
const RENDER_SIZE = { width: 1280, height: 820 };

/**
 * The Connectors and rules boards are drawn at a 14-inch laptop's width, or a phone's, and a board
 * taller than one screen is captured at its full height: so the width is exact and the height is at
 * least one screen (the Storybook "Board" and "Phone" viewports).
 */
const CONNECTORS_SIZE = { width: 1512, minHeight: 982 };
const CONNECTORS_PHONE_SIZE = { width: 390, minHeight: 844 };

/** The problem with a render's size, or null when it is the size its board is drawn at. */
function sizeProblem(board: string, size: { width: number; height: number }): string | null {
  if (board.startsWith('N-Conn-')) {
    const expected = board === 'N-Conn-16-Phone-Rules' ? CONNECTORS_PHONE_SIZE : CONNECTORS_SIZE;
    return size.width === expected.width && size.height >= expected.minHeight
      ? null
      : `${board}: ${size.width}×${size.height}, not ${expected.width} wide and at least ${expected.minHeight} tall`;
  }
  return size.width === RENDER_SIZE.width && size.height === RENDER_SIZE.height
    ? null
    : `${board}: ${size.width}×${size.height}, not ${RENDER_SIZE.width}×${RENDER_SIZE.height}`;
}

/** A PNG's width and height, read from its IHDR chunk, or null when the bytes aren't a PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The tests that import every board story get more than the default 5 s: the first import
 * transforms each story and its components, and the browser projects run beside them.
 */
const STORY_IMPORT_TIMEOUT = 30_000;

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
      }));
  });
}

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
      const problem = sizeProblem(board, size);
      return problem === null ? [] : [problem];
    });
    expect(problems).toEqual([]);
  });

  it('board_stories_name_reference_boards', async () => {
    const stories = await boardStories();
    expect(stories.length).toBeGreaterThan(0);
    const unnamed = stories.filter(({ canvas }) => !(REFERENCE_BOARDS as readonly unknown[]).includes(canvas));
    expect(unnamed.map(({ id, canvas }) => `${id}: ${JSON.stringify(canvas)}`)).toEqual([]);
  }, STORY_IMPORT_TIMEOUT);

  it('every_reference_board_has_a_board_story', async () => {
    const stories = await boardStories();
    // Exactly one: a board rebuilt twice would be checked against itself twice, and differ.
    const counts = REFERENCE_BOARDS.map((board) => {
      const naming = stories.filter(({ canvas }) => canvas === board).map(({ id }) => id);
      return `${board}: ${naming.length === 1 ? 'one story' : `${naming.length} stories${naming.length > 1 ? ` (${naming.join('; ')})` : ''}`}`;
    });
    expect(counts).toEqual(REFERENCE_BOARDS.map((board) => `${board}: one story`));
  }, STORY_IMPORT_TIMEOUT);
});
