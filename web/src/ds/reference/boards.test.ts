/**
 * Ties the reference boards to what checks them: each board's render at its own size, a connectors
 * board at its full height (when the renders are on this machine), and the `Boards/*` stories that
 * rebuild the boards from the components, each run at its board's size.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Meta, StoryObj } from '@storybook/react-vite';
import { isExportStory } from 'storybook/internal/csf';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  BOARD_VIEWPORTS,
  REFERENCE_BOARDS,
  boardViewport,
  capturedAtFullHeight,
  isReferenceBoard,
  renderSize,
  renderSizeProblem,
  type ReferenceBoard,
} from './boards.ts';

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

describe('reference boards', () => {
  // Imported once for the checks below. The first import transforms every board story, which can
  // take longer than one test's 5 s while the browser projects run beside this one.
  let stories: BoardStory[] = [];
  beforeAll(async () => {
    stories = await boardStories();
  }, 60_000);

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
      const problem = renderSizeProblem(board, size);
      return problem === null ? [] : [problem];
    });
    expect(problems).toEqual([]);
  });

  it('tall_boards_are_captured_at_full_height', () => {
    // The Connectors tab and Rules boards, and the city office's resident page, which runs past the
    // window, are captured at their full height; every other board at its window's size.
    const full = REFERENCE_BOARDS.filter(capturedAtFullHeight);
    expect(full.filter((board) => !board.startsWith('N-Conn-'))).toEqual(['N-R2-Vision-CityOffice-Resident']);
    expect(full).toEqual(REFERENCE_BOARDS.filter((board) => board.startsWith('N-Conn-') || board === 'N-R2-Vision-CityOffice-Resident'));
    // So its 1512 × 1491 render is its window's width and at least its height.
    expect(renderSizeProblem('N-R2-Vision-CityOffice-Resident', { width: 1512, height: 1491 })).toBeNull();
    expect(renderSizeProblem('N-R2-Vision-Phone', { width: 1512, height: 1491 })).not.toBeNull();
  });

  it('render_size_apart_from_story_window', () => {
    // A board whose story measures its page at another height than the canvas drew it keeps the two
    // apart: the render is checked at the canvas's size, the story runs at the page's own.
    const cases = [
      ['N-R2-Vision-TeamDesk', 1022, 'laptop-1142'],
      ['N-R2-Vision-ClaudeAccount', 1013, 'laptop-994'],
    ] as const;
    for (const [board, height, story] of cases) {
      expect(renderSize(board)).toEqual({ width: 1512, height });
      expect(boardViewport(board)).toBe(story);
      expect(renderSizeProblem(board, { width: 1512, height })).toBeNull();
      expect(renderSizeProblem(board, BOARD_VIEWPORTS[story])).toBe(`${board}: 1512×${BOARD_VIEWPORTS[story].height}, not 1512×${height}`);
    }
    // Every other board's render is its story's window, and a connectors board still at least its height.
    expect(renderSize('N-R2-Vision-Phone')).toEqual({ width: 1512, height: 982 });
    expect(renderSizeProblem('N-R2-Vision-Phone', { width: 1512, height: 982 })).toBeNull();
    expect(renderSizeProblem('N-Conn-02-Payments', { width: 1512, height: 1400 })).toBeNull();
    expect(renderSizeProblem('N-Conn-02-Payments', { width: 1512, height: 900 })).toMatch(/at least 982 tall/);
  });

  it('agents_pages_run_at_their_own_height', () => {
    // Both agents page boards are pages longer than the window, drawn at their width and the page's
    // own height, redrawn at canvas v380: the laptop's 1512 × 2200 and the phone's 390 × 2740.
    expect(boardViewport('N-R2-Agents-01-Page')).toBe('laptop-2200');
    expect(renderSizeProblem('N-R2-Agents-01-Page', { width: 1512, height: 2200 })).toBeNull();
    expect(renderSizeProblem('N-R2-Agents-01-Page', { width: 1512, height: 1800 })).toBe('N-R2-Agents-01-Page: 1512×1800, not 1512×2200');
    expect(boardViewport('N-R2-Agents-06-Phone')).toBe('phone-2740');
    expect(renderSizeProblem('N-R2-Agents-06-Phone', { width: 390, height: 2740 })).toBeNull();
    expect(renderSizeProblem('N-R2-Agents-06-Phone', { width: 390, height: 2100 })).toBe('N-R2-Agents-06-Phone: 390×2100, not 390×2740');
    expect(renderSizeProblem('N-R2-Agents-06-Phone', { width: 390, height: 844 })).toBe('N-R2-Agents-06-Phone: 390×844, not 390×2740');
  });

  it('board_stories_name_reference_boards', () => {
    expect(stories.length).toBeGreaterThan(0);
    const unnamed = stories.filter(({ canvas }) => !(REFERENCE_BOARDS as readonly unknown[]).includes(canvas));
    expect(unnamed.map(({ id, canvas }) => `${id}: ${JSON.stringify(canvas)}`)).toEqual([]);
  }, STORY_IMPORT_TIMEOUT);

  it('every_reference_board_has_a_board_story', () => {
    // Exactly one: a board rebuilt twice would be checked against itself twice, and differ.
    const counts = REFERENCE_BOARDS.map((board) => {
      const naming = stories.filter(({ canvas }) => canvas === board).map(({ id }) => id);
      return `${board}: ${naming.length === 1 ? 'one story' : `${naming.length} stories${naming.length > 1 ? ` (${naming.join('; ')})` : ''}`}`;
    });
    expect(counts).toEqual(REFERENCE_BOARDS.map((board) => `${board}: one story`));
  }, STORY_IMPORT_TIMEOUT);

  it('board_stories_run_at_their_boards_window', () => {
    // The plays measure the board as drawn, so each runs in the window its board was rendered at.
    const wrong = stories.flatMap(({ id, canvas, viewport }) =>
      isReferenceBoard(canvas) && viewport !== boardViewport(canvas)
        ? [`${id}: runs at ${JSON.stringify(viewport)}, drawn at ${boardViewport(canvas)}`]
        : [],
    );
    expect(wrong).toEqual([]);
    // Every window is in use, so the check reads the stories' globals as they are written.
    expect(new Set(stories.map(({ viewport }) => viewport))).toEqual(new Set(Object.keys(BOARD_VIEWPORTS)));
  }, STORY_IMPORT_TIMEOUT);
});
