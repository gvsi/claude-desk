/**
 * The design canvas boards the design system is checked against: the N- boards on the "Claude
 * Desk ·" pages that the project owner signed off, and run 2's boards while they are in review,
 * each listed once. Each is rebuilt by one
 * `Boards/*` story and compared by eye with its render at the board's own size, 1280×820 or a
 * 14-inch laptop's 1512×982 (`reference/README.md`). A story names its board in
 * `parameters.canvas`, or says `'none'` and explains in `parameters.canvasNote` (usually naming the
 * nearest board).
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
  // Recorded history, replayed into each copy: the pages that list it, at a 14-inch laptop's window.
  'N-History-Conversations',
  'N-History-People',
  'N-History-Safety',
  // The sidebar on its own, with the "About this prototype" group.
  'N-Docs-Sidebar',
  // Run 2's boards, drawn on 2026-10-29 and in review: the pieces each needs a component for.
  // Customers: the list loading, and the list on a phone.
  'N-Run2-People-Loading',
  'N-Run2-People-Phone',
  // Setup: real situations and the safety check, each a page longer than the window.
  'N-R2-Setup-09-Situations',
  'N-R2-Setup-11-Safety',
  // The agents page: the page itself, longer than the window, and the demo key shown once.
  'N-R2-Agents-01-Page',
  'N-R2-Agents-02-Demo-Key',
  // The chat: a payment link a rule change cancelled.
  'N-R2-Chat-Link-Cancelled',
  // The Demo inbox as a sheet: a visitor's from the bottom of a phone, the owner's beside Today.
  'N-R2-Inbox-Sheet-Public',
  'N-R2-Inbox-Sheet-Owner',
  // Share: the link, the printable card and the ready-made words.
  'N-Run2-Share',
  // Settings: the danger dialog over General.
  'N-Run2-Settings-DeleteDesk',
] as const;

export type ReferenceBoard = (typeof REFERENCE_BOARDS)[number];

/**
 * The windows the boards are drawn and rendered at, as Storybook viewports (`.storybook/preview.tsx`
 * builds its options from these): most at the canvas's 1280×820, some at a 14-inch laptop's
 * 1512×982, the sidebar alone at its own 264 px, the laptop's height, and run 2's phone boards at
 * 390×844. A run 2 board whose page runs longer than the window is drawn at the laptop's width and
 * the page's own height. A board story runs at its board's window.
 */
export const BOARD_VIEWPORTS = {
  canvas: { name: 'Canvas', width: 1280, height: 820 },
  laptop: { name: '14-inch laptop', width: 1512, height: 982 },
  sidebar: { name: 'Sidebar alone', width: 264, height: 982 },
  phone: { name: 'Phone', width: 390, height: 844 },
  'laptop-1100': { name: '14-inch laptop, a 1100 px page', width: 1512, height: 1100 },
  'laptop-1150': { name: '14-inch laptop, a 1150 px page', width: 1512, height: 1150 },
  'laptop-1500': { name: '14-inch laptop, a 1500 px page', width: 1512, height: 1500 },
} as const;

export type BoardViewport = keyof typeof BOARD_VIEWPORTS;

/** The boards drawn at another window than the canvas's, and which. */
const BOARD_WINDOWS: Readonly<Partial<Record<ReferenceBoard, Exclude<BoardViewport, 'canvas'>>>> = {
  'N-History-Conversations': 'laptop',
  'N-History-People': 'laptop',
  'N-History-Safety': 'laptop',
  'N-Docs-Sidebar': 'sidebar',
  'N-Run2-People-Loading': 'laptop',
  'N-Run2-People-Phone': 'phone',
  'N-R2-Setup-09-Situations': 'laptop-1100',
  'N-R2-Setup-11-Safety': 'laptop-1150',
  'N-R2-Agents-01-Page': 'laptop-1500',
  'N-R2-Agents-02-Demo-Key': 'laptop',
  'N-R2-Chat-Link-Cancelled': 'laptop',
  'N-R2-Inbox-Sheet-Public': 'phone',
  'N-R2-Inbox-Sheet-Owner': 'laptop',
  'N-Run2-Share': 'laptop',
  'N-Run2-Settings-DeleteDesk': 'laptop',
};

/** The window `board` is drawn at, so its render's size and its story's viewport. */
export function boardViewport(board: ReferenceBoard): BoardViewport {
  return BOARD_WINDOWS[board] ?? 'canvas';
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
