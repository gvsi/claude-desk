/**
 * The design canvas boards the design system is checked against: the N- boards on the "Claude
 * Desk ·" pages that the project owner signed off, each listed once. Each is rebuilt by one
 * `Boards/*` story and compared by eye with its render at the board's own size: 1280×820, a
 * 14-inch laptop's 1512×982 or a phone's 390×844, a tall connectors board at its full height
 * (`reference/README.md`). A story names its board in `parameters.canvas`, or says `'none'` and
 * explains in `parameters.canvasNote` (usually naming the nearest board).
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
  // The Connectors tab and the Rules page, which replace the Rules and Integrations boards. The
  // first Rules boards (N-Conn-01-Rules, N-Conn-16-Phone-Rules) are archived.
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
  // The Rules page's preset menu, its payment limit in the payment groups, their reviews, and the
  // demo's simulate strip on a connected tool's page.
  'N-Conn-17-Presets',
  'N-Conn-18-Preset-Review',
  'N-Conn-19-Ceiling',
  'N-Conn-19b-Ceiling-Edit',
  'N-Conn-20-Ceiling-Review',
  'N-Conn-21-Simulate',
  'N-Conn-22-Phone-Presets',
  'N-Conn-23-Connectors',
  'N-Conn-24-Phone-Connectors',
  // Recorded history, replayed into each copy: the pages that list it, at a 14-inch laptop's window.
  'N-History-Conversations',
  'N-History-People',
  'N-History-Safety',
  // The sidebar on its own, with the "About this prototype" group.
  'N-Docs-Sidebar',
] as const;

export type ReferenceBoard = (typeof REFERENCE_BOARDS)[number];

/**
 * The windows the boards are drawn and rendered at, as Storybook viewports (`.storybook/preview.tsx`
 * builds its options from these): most at the canvas's 1280×820, some at a 14-inch laptop's
 * 1512×982, the sidebar alone at its own 264 px, the laptop's height, and the phone boards at
 * 390×844. A board story runs at its board's window.
 */
export const BOARD_VIEWPORTS = {
  canvas: { name: 'Canvas', width: 1280, height: 820 },
  laptop: { name: '14-inch laptop', width: 1512, height: 982 },
  sidebar: { name: 'Sidebar alone', width: 264, height: 982 },
  phone: { name: 'Phone', width: 390, height: 844 },
} as const;

export type BoardViewport = keyof typeof BOARD_VIEWPORTS;

/**
 * The boards drawn at another window than the canvas's, and which. Every Connectors tab and Rules
 * board (`N-Conn-*`) is drawn at the laptop's, but for its phone board.
 */
const BOARD_WINDOWS: Readonly<Partial<Record<ReferenceBoard, Exclude<BoardViewport, 'canvas'>>>> = {
  'N-History-Conversations': 'laptop',
  'N-History-People': 'laptop',
  'N-History-Safety': 'laptop',
  'N-Docs-Sidebar': 'sidebar',
  'N-Conn-22-Phone-Presets': 'phone',
  'N-Conn-24-Phone-Connectors': 'phone',
};

/** The window `board` is drawn at, so its render's size and its story's viewport. */
export function boardViewport(board: ReferenceBoard): BoardViewport {
  return BOARD_WINDOWS[board] ?? (board.startsWith('N-Conn-') ? 'laptop' : 'canvas');
}

/**
 * Whether `board`'s render is captured at its full height: the Connectors tab and Rules boards are,
 * so a tall one is as wide as its window and at least as tall. Every other render is its window's size.
 */
export function capturedAtFullHeight(board: ReferenceBoard): boolean {
  return board.startsWith('N-Conn-');
}

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
