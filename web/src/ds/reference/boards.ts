/**
 * The design canvas boards the design system is checked against: the N- boards on the "Claude
 * Desk ·" pages that the project owner signed off, and run 2's boards while they are in review,
 * each listed once. Each is rebuilt by one `Boards/*` story and compared by eye with its render at
 * the board's own size: 1280×820, a 14-inch laptop's 1512×982 or a phone's 390×844, a tall
 * connectors board or the city office's resident page at its full height (`reference/README.md`).
 * A story names its board in `parameters.canvas`, or says `'none'` and explains in
 * `parameters.canvasNote` (usually naming the nearest board).
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
  // Run 2's boards, drawn on 2026-10-29 and in review: the pieces each needs a component for.
  // Customers: the list loading, and the list on a phone.
  'N-Run2-People-Loading',
  'N-Run2-People-Phone',
  // Setup: an answer that couldn't be sent, kept with Try again; the tools step, a page longer
  // than the window; real situations and the safety check, each a page longer than the window.
  'N-R2-Setup-04-Answer-Failed',
  'N-R2-Setup-05-Tools',
  'N-R2-Setup-09-Situations',
  'N-R2-Setup-11-Safety',
  // The agents page: the page itself, longer than the window, and the demo key shown once.
  'N-R2-Agents-01-Page',
  'N-R2-Agents-02-Demo-Key',
  // Sending the built-in agent, signed on 2026-10-30: the panel with its signed spending limit.
  'N-R2-Agents-03-Send',
  // The agent's run inside the same card, its reply cards held there, and a charge over its limit.
  'N-R2-Agents-04-Run',
  'N-R2-Agents-05-Over-Limit',
  // The agents page on a phone; both page boards redrawn on 2026-11-02 (canvas v380).
  'N-R2-Agents-06-Phone',
  // The chat: a payment link a rule change cancelled.
  'N-R2-Chat-Link-Cancelled',
  // The public page while the owner is in the chat, take-over option A, signed on 2026-10-30: the
  // chat's head says she is in the chat and Claude, an AI, is paused, with no Ask for her.
  'N-R2-TakeOver-A-1512-EN',
  'N-R2-TakeOver-A-390-EN',
  // The Demo inbox as a sheet: a visitor's from the bottom of a phone, the owner's beside Today.
  'N-R2-Inbox-Sheet-Public',
  'N-R2-Inbox-Sheet-Owner',
  // Share: the link, the printable card and the ready-made words.
  'N-Run2-Share',
  // Settings, signed on 2026-10-30: General, deleting a Desk over it, Knowledge, Notifications,
  // Billing, and General on a phone, as a page taller than the phone's window.
  'N-Run2-Settings-General',
  'N-Run2-Settings-DeleteDesk',
  'N-Run2-Settings-Knowledge',
  'N-Run2-Settings-Notifications',
  'N-Live-REV-BIL-1512',
  'N-Live-REV-BIL-390',
  'N-Run2-Settings-Phone',
  // Settings › Channels, signed on 2026-10-30: the page the app builds, with no vision bar; and the
  // same page under the vision bar, a vision story only.
  'N-Run2-Settings-Channels',
  'N-R2-Vision-Channels',
  // The vision pages, signed on 2026-10-30, each under the vision bar: a team Desk's conversations;
  // a returning visitor signed in with a Claude account; Today and the public chat as phone apps;
  // and a resident on a city permits office's public page, longer than the window and captured at
  // its full height.
  'N-R2-Vision-TeamDesk',
  'N-R2-Vision-ClaudeAccount',
  'N-R2-Vision-Phone',
  'N-R2-Vision-CityOffice-Resident',
  // The demo visitor, in review (REV-DEMO): Today's "Watch a demo visitor" card (artboard
  // cdae4f209f2e) and its start error (d691001ca787); its conversation while it chats, at a laptop's
  // width (4ae3b66fd4f0) and a phone's (b6a3eaf4a777), after a whisper (b5079e9ac81c), after a
  // take-over (894cee1ec120), and once it has ended (2e93bf1904b9).
  'N-Live-REV-DEMO-today-1512',
  'N-Live-REV-DEMO-error-1512',
  'N-Live-REV-DEMO-chat-1512',
  'N-Live-REV-DEMO-chat-390',
  'N-Live-REV-DEMO-whisper-1512',
  'N-Live-REV-DEMO-takeover-1512',
  'N-Live-REV-DEMO-ended-1512',
] as const;

export type ReferenceBoard = (typeof REFERENCE_BOARDS)[number];

/**
 * The windows the boards are drawn and rendered at, as Storybook viewports (`.storybook/preview.tsx`
 * builds its options from these): most at the canvas's 1280×820, some at a 14-inch laptop's
 * 1512×982, the sidebar alone at its own 264 px, the laptop's height, and the phone boards at
 * 390×844. A run 2 board whose page runs longer than the window is drawn at the laptop's (or the
 * phone's) width and the page's own height. A board story runs at its board's window.
 */
export const BOARD_VIEWPORTS = {
  canvas: { name: 'Canvas', width: 1280, height: 820 },
  laptop: { name: '14-inch laptop', width: 1512, height: 982 },
  sidebar: { name: 'Sidebar alone', width: 264, height: 982 },
  phone: { name: 'Phone', width: 390, height: 844 },
  'phone-900': { name: 'Phone, a 900 px page', width: 390, height: 900 },
  'phone-2740': { name: 'Phone, a 2740 px page', width: 390, height: 2740 },
  'laptop-994': { name: '14-inch laptop, a 994 px page', width: 1512, height: 994 },
  'laptop-1100': { name: '14-inch laptop, a 1100 px page', width: 1512, height: 1100 },
  'laptop-1142': { name: '14-inch laptop, a 1142 px page', width: 1512, height: 1142 },
  'laptop-1150': { name: '14-inch laptop, a 1150 px page', width: 1512, height: 1150 },
  'laptop-2200': { name: '14-inch laptop, a 2200 px page', width: 1512, height: 2200 },
} as const;

export type BoardViewport = keyof typeof BOARD_VIEWPORTS;

/**
 * The boards drawn at another window than the canvas's, and which: the window each board's story
 * runs at, which is also its render's size unless `RENDER_SIZES` gives its own. Every Connectors tab
 * and Rules board (`N-Conn-*`) is drawn at the laptop's, but for its phone board.
 */
const BOARD_WINDOWS: Readonly<Partial<Record<ReferenceBoard, Exclude<BoardViewport, 'canvas'>>>> = {
  'N-History-Conversations': 'laptop',
  'N-History-People': 'laptop',
  'N-History-Safety': 'laptop',
  'N-Docs-Sidebar': 'sidebar',
  'N-Conn-22-Phone-Presets': 'phone',
  'N-Conn-24-Phone-Connectors': 'phone',
  'N-Run2-People-Loading': 'laptop',
  'N-Run2-People-Phone': 'phone',
  'N-R2-Setup-04-Answer-Failed': 'laptop',
  'N-R2-Setup-05-Tools': 'laptop-1100',
  'N-R2-Setup-09-Situations': 'laptop-1100',
  'N-R2-Setup-11-Safety': 'laptop-1150',
  'N-R2-Agents-01-Page': 'laptop-2200',
  'N-R2-Agents-02-Demo-Key': 'laptop',
  'N-R2-Agents-03-Send': 'laptop',
  'N-R2-Agents-04-Run': 'laptop-1150',
  'N-R2-Agents-05-Over-Limit': 'laptop',
  'N-R2-Agents-06-Phone': 'phone-2740',
  'N-R2-Chat-Link-Cancelled': 'laptop',
  'N-R2-TakeOver-A-1512-EN': 'laptop',
  'N-R2-TakeOver-A-390-EN': 'phone',
  'N-R2-Inbox-Sheet-Public': 'phone',
  'N-R2-Inbox-Sheet-Owner': 'laptop',
  'N-Run2-Share': 'laptop',
  'N-Run2-Settings-General': 'laptop',
  'N-Run2-Settings-DeleteDesk': 'laptop',
  'N-Run2-Settings-Knowledge': 'laptop',
  'N-Run2-Settings-Notifications': 'laptop',
  'N-Live-REV-BIL-1512': 'laptop',
  'N-Live-REV-BIL-390': 'phone',
  'N-Run2-Settings-Phone': 'phone-900',
  'N-Run2-Settings-Channels': 'laptop',
  'N-R2-Vision-Channels': 'laptop',
  'N-R2-Vision-TeamDesk': 'laptop-1142',
  'N-R2-Vision-ClaudeAccount': 'laptop-994',
  'N-R2-Vision-Phone': 'laptop',
  'N-R2-Vision-CityOffice-Resident': 'laptop',
  'N-Live-REV-DEMO-today-1512': 'laptop',
  'N-Live-REV-DEMO-error-1512': 'laptop',
  'N-Live-REV-DEMO-chat-1512': 'laptop',
  'N-Live-REV-DEMO-chat-390': 'phone',
  'N-Live-REV-DEMO-whisper-1512': 'laptop',
  'N-Live-REV-DEMO-takeover-1512': 'laptop',
  'N-Live-REV-DEMO-ended-1512': 'laptop',
};

/** The window `board`'s story runs at, and its render's size unless `RENDER_SIZES` gives its own. */
export function boardViewport(board: ReferenceBoard): BoardViewport {
  return BOARD_WINDOWS[board] ?? (board.startsWith('N-Conn-') ? 'laptop' : 'canvas');
}

/** The boards besides the `N-Conn-*` ones whose render is captured at its full height. */
const FULL_HEIGHT: ReadonlySet<ReferenceBoard> = new Set<ReferenceBoard>(['N-R2-Vision-CityOffice-Resident']);

/**
 * The boards whose render is drawn at another height than the page their story measures: the canvas
 * board's own size. Their stories run at the page's height (`BOARD_WINDOWS`), so a play measures
 * the page as the components draw it, and the render is checked at the size the canvas drew it.
 */
const RENDER_SIZES: Readonly<Partial<Record<ReferenceBoard, { width: number; height: number }>>> = {
  'N-R2-Vision-TeamDesk': { width: 1512, height: 1022 },
  'N-R2-Vision-ClaudeAccount': { width: 1512, height: 1013 },
};

/** The size `board`'s render is drawn at: its own (`RENDER_SIZES`), or its story's window. */
export function renderSize(board: ReferenceBoard): { width: number; height: number } {
  const own = RENDER_SIZES[board];
  if (own !== undefined) return own;
  const { width, height } = BOARD_VIEWPORTS[boardViewport(board)];
  return { width, height };
}

/**
 * The problem with a render's size, or null when it is the size its board is drawn at
 * (`renderSize`), or for a board captured at its full height, that width and at least that height.
 */
export function renderSizeProblem(board: ReferenceBoard, size: { width: number; height: number }): string | null {
  const want = renderSize(board);
  if (capturedAtFullHeight(board)) {
    return size.width === want.width && size.height >= want.height
      ? null
      : `${board}: ${size.width}×${size.height}, not ${want.width} wide and at least ${want.height} tall`;
  }
  return size.width === want.width && size.height === want.height ? null : `${board}: ${size.width}×${size.height}, not ${want.width}×${want.height}`;
}

/**
 * Whether `board`'s render is captured at its full height: the Connectors tab and Rules boards are,
 * and so is the city office's resident page (`FULL_HEIGHT`), so a tall one is as wide as its window
 * and at least as tall. Every other render is its window's size.
 */
export function capturedAtFullHeight(board: ReferenceBoard): boolean {
  return board.startsWith('N-Conn-') || FULL_HEIGHT.has(board);
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
