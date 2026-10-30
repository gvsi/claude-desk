/**
 * The design canvas boards the design system is checked against: the N- boards on the "Claude
 * Desk ·" pages that the project owner signed off, each listed once. Each is rebuilt by one
 * `Boards/*` story and compared by eye with its render at 1280×820 (`reference/README.md`). A story
 * names its board in `parameters.canvas`, or says `'none'` and explains in `parameters.canvasNote`
 * (usually naming the nearest board).
 */
export const REFERENCE_BOARDS = [
  // The owner app: Today, the conversations and the decisions made in them.
  'N-Today-Run1',
  'N-Today-Empty-Run1',
  'N-Conv-Run1',
  'N-Conv-Agent-Run1',
  'N-Conv-TakeOver',
  'N-Switcher-Run1',
  'N-Safety-Run1',
  'N-Safety-Record-Run1',
  // The public page.
  'N-Public-Rivera-Run1',
  'N-Public-Handoff-Run1',
  'N-Public-Verify-Run1',
  // Typing, busy buttons and the approval answers, signed as their own boards.
  'N-Typing-Bubble-Run1',
  'N-Typing-Owner-Busy',
  'N-Answers-TwoButtons',
  // The first visit.
  'N-Intro-D',
  // The "Connectors and rules" page, which replaces the Rules and Integrations boards.
  'N-Conn-01-Rules',
  'N-Conn-02-Payments',
  'N-Conn-03-Stripe',
  'N-Conn-04-GoogleCalendar',
  'N-Conn-05-Refund',
  'N-Conn-06-Quote',
  'N-Conn-07-Add-Picker',
  'N-Conn-07b-Add-Picker-ComingSoon',
  'N-Conn-08-GCal-SignIn',
  'N-Conn-09-GCal-Review',
  'N-Conn-10-GCal-Confirm',
  'N-Conn-11-GCal-Done',
  'N-Conn-11b-Payments-Review',
  'N-Conn-12-Chat',
  'N-Conn-13-Changed-Today',
  'N-Conn-14-Changed-Review',
  'N-Conn-15-Changed-After',
  'N-Conn-16-Phone-Rules',
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
