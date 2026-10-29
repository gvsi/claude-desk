/**
 * The design canvas boards the design system is checked against: only the current N- boards on
 * the "Claude Desk ·" pages, each listed once. A story names its board in `parameters.canvas`, or
 * says `'none'` and explains in `parameters.canvasNote` (usually naming the nearest board).
 */
export const REFERENCE_BOARDS = [
  'N-Today-NeedsYou',
  'N-Conv-Live',
  'N-Conv-Agent',
  'N-Conv-TakeOver',
  'N-Reviewer-Arrival',
  'N-Public-Rivera',
  'N-Public-Handoff',
  'N-Public-Verify',
  'N-Rules-Rivera',
  'N-Rules-ChatChange',
  'N-Safety',
  'N-Switcher',
  'N-Settings-Integrations',
  'N-Settings-ToolChanged',
] as const;

export type ReferenceBoard = (typeof REFERENCE_BOARDS)[number];

export function isReferenceBoard(value: unknown): value is ReferenceBoard {
  return typeof value === 'string' && (REFERENCE_BOARDS as readonly string[]).includes(value);
}

/**
 * Throws unless the story's parameters tie it to the canvas: `canvas` is a reference board, or
 * `'none'` with a `canvasNote` that says why and what is nearest.
 */
export function assertCanvasParameter(parameters: Readonly<Record<string, unknown>>): void {
  const { canvas, canvasNote } = parameters;
  const hasNote = typeof canvasNote === 'string' && canvasNote.trim() !== '';
  if (canvas === 'none') {
    if (!hasNote) {
      throw new Error("parameters.canvas is 'none', so parameters.canvasNote must say why and name the nearest board");
    }
    return;
  }
  if (!isReferenceBoard(canvas)) {
    throw new Error(
      `parameters.canvas must be one of the reference boards (${REFERENCE_BOARDS.join(', ')}) or 'none' with a canvasNote; got ${JSON.stringify(canvas)}`,
    );
  }
  if (canvasNote !== undefined && !hasNote) {
    throw new Error('parameters.canvasNote, when given, must say what differs from the board');
  }
}
