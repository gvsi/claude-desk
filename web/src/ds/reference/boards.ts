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
  'N-Safety',
  'N-Switcher',
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
  // How Claude works, the money limit and the demo's simulate strip, on the same page.
  'N-Conn-17-Mode',
  'N-Conn-18-Mode-Review',
  'N-Conn-19-Money-Cap',
  'N-Conn-20-Money-Cap-Review',
  'N-Conn-21-Simulate',
  'N-Conn-22-Phone-Mode',
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
