/**
 * The web's static connector table: the API groups no tools, so the app says which connector each
 * tool belongs to, and names each tool and connector in the boards' words (the signed presets and
 * Connectors boards). Rules, Connectors, Today and setup group tools only through it.
 */
import type { ToolName, ToolProfile } from '../../api/contracts.ts';
import type { ToolRow } from '../../api/views.ts';
import type { ConnectorIconName, ConnectorView } from '../../ds/index.ts';

/** A connector's key: the design system's connector id. */
export type ConnectorKey = ConnectorIconName;

/** One connector: its key, how it shows (`ConnectorName`), and the tools it groups, in order. */
export interface CatalogConnector {
  key: ConnectorKey;
  view: ConnectorView;
  tools: readonly ToolName[];
}

/** A tool in the owner's words: its name, and one line on what it does. */
export interface ToolWords {
  name: string;
  line: string;
}

/**
 * Every connector, in the order the boards list them: the six built in, then the apps, each a mock
 * in the demo. Google Calendar is catalog only: it has no tools, no route and no API.
 */
export const CONNECTORS: readonly CatalogConnector[] = [
  {
    key: 'quotes',
    view: { id: 'quotes', name: 'Quotes', icon: 'quotes', description: 'Prices jobs from your price list.', source: { kind: 'built_in' } },
    tools: ['native.quote'],
  },
  {
    key: 'bookings',
    view: { id: 'bookings', name: 'Bookings', icon: 'bookings', description: 'Finds open times and books visits.', source: { kind: 'built_in' } },
    tools: ['native.find_slots', 'native.book'],
  },
  {
    key: 'leads',
    view: {
      id: 'leads',
      name: 'Leads and callbacks',
      icon: 'leads',
      description: "Saves visitors' details and asks you to call back.",
      source: { kind: 'built_in' },
    },
    tools: ['native.capture_lead', 'native.request_callback'],
  },
  {
    key: 'verification',
    view: { id: 'verification', name: 'Verification', icon: 'verification', description: 'Confirms a customer is who they say.', source: { kind: 'built_in' } },
    tools: ['native.start_verification'],
  },
  {
    key: 'documents',
    view: {
      id: 'documents',
      name: 'Documents',
      icon: 'documents',
      description: "Sends customers their own documents after they confirm it's them.",
      source: { kind: 'built_in' },
    },
    tools: ['native.release_document'],
  },
  {
    key: 'payments',
    view: {
      id: 'payments',
      name: 'Payments',
      icon: 'payments',
      description: 'Payment links and charges within a signed limit. Test payments, no money moves.',
      source: { kind: 'built_in' },
    },
    tools: ['native.payment_link', 'native.charge_mandate'],
  },
  {
    // The mock payments server: always shown with its Mock badge.
    key: 'stripe',
    view: {
      id: 'stripe',
      name: 'Stripe',
      icon: 'stripe',
      description: "Your customers' charges and refunds. Test mode, no money moves.",
      source: { kind: 'external', mock: true },
    },
    tools: ['payments.list_charges', 'payments.create_refund'],
  },
  {
    key: 'google_calendar',
    view: {
      id: 'google_calendar',
      name: 'Google Calendar',
      icon: 'google_calendar',
      description: "When you're busy, so Claude only offers free times.",
      source: { kind: 'external', mock: true },
    },
    tools: [],
  },
];

/**
 * Each tool's name and line in the boards' words. The line says what the tool does; a connected
 * tool's description adds what it touches (`describeEffects`). Website and memory reading are the
 * setup interview's own, in no connector.
 */
export const TOOL_NAMES = {
  'native.quote': { name: 'Quote', line: 'Prices a job from your price list.' },
  'native.find_slots': { name: 'Find open times', line: "Reads the times you're free." },
  'native.book': { name: 'Book a visit', line: 'Puts a visit on your calendar.' },
  'native.capture_lead': { name: 'Save a lead', line: "Keeps a visitor's details for you." },
  'native.request_callback': { name: 'Request a callback', line: 'Asks you to call someone back.' },
  'native.start_verification': { name: "Confirm it's them", line: 'Sends a code to the contact on record.' },
  'native.release_document': { name: 'Share a document', line: 'Sends customers their own documents.' },
  'native.payment_link': { name: 'Payment link', line: 'Makes a one-time link for a quote.' },
  'native.charge_mandate': { name: 'Charge within a signed limit', line: "Lets a visiting agent pay from its owner's signed limit." },
  'payments.list_charges': { name: 'See charges', line: 'Shows customers their own charges.' },
  'payments.create_refund': { name: 'Refund', line: 'Refunds a payment to the card it came from.' },
  'native.fetch_website': { name: 'Website reading', line: 'Reads your website to learn about your business.' },
  'native.read_memory': { name: 'Memory reading', line: 'Reads the notes you brought in to learn about your business.' },
} as const satisfies Record<ToolName, ToolWords>;

/**
 * What each tool acts on, as the kernel's tool profiles have it (`ToolProfile.resource_kind`: each
 * adapter's profile under `backend/desk/kernel_service/adapters/`, and the master plan's tool table
 * for the payment tools). The tool rows the API sends don't carry it.
 */
export const TOOL_RESOURCES = {
  'native.quote': 'desk',
  'native.find_slots': 'desk',
  'native.book': 'slot',
  'native.capture_lead': 'desk',
  'native.request_callback': 'desk',
  'native.start_verification': 'desk',
  'native.release_document': 'document',
  'native.payment_link': 'quote',
  'native.charge_mandate': 'quote',
  'payments.list_charges': 'charge',
  'payments.create_refund': 'charge',
  'native.fetch_website': 'desk',
  'native.read_memory': 'desk',
} as const satisfies Record<ToolName, ToolProfile['resource_kind']>;

/**
 * The resources a person can own, so a rule for record owners can match: a document, its
 * `record_owner_person_id` (the Share a document adapter), and a charge, the person it was charged
 * to (master plan, "Listing charges"; plan 01c's refund adapter). The Desk itself, a calendar slot
 * and a quote have no owner: those adapters resolve them with `owner_person_id=None`, and the
 * quotes table has no owner to read.
 */
const OWNED_RESOURCES: ReadonlySet<ToolProfile['resource_kind']> = new Set(['document', 'charge']);

/** Whether the tool's records can have an owner, so a rule for record owners can apply to it. */
export function hasRecordOwner(tool: string): boolean {
  return Object.hasOwn(TOOL_RESOURCES, tool) && OWNED_RESOURCES.has(TOOL_RESOURCES[tool as ToolName]);
}

const BY_KEY: ReadonlyMap<string, CatalogConnector> = new Map(CONNECTORS.map((connector) => [connector.key, connector]));
const BY_TOOL: ReadonlyMap<string, CatalogConnector> = new Map(CONNECTORS.flatMap((connector) => connector.tools.map((tool) => [tool, connector])));

/** The connector a tool belongs to; null for the setup interview's own tools and any tool the catalog doesn't know. */
export function connectorOf(tool: ToolName): CatalogConnector | null {
  return BY_TOOL.get(tool) ?? null;
}

/** The connector with this key, or null for a key the catalog doesn't know. */
export function connectorByKey(key: string): CatalogConnector | null {
  return BY_KEY.get(key) ?? null;
}

/** The tool's words, or null for a tool the catalog doesn't know (a name the contracts don't have). */
export function toolWords(tool: string): ToolWords | null {
  return Object.hasOwn(TOOL_NAMES, tool) ? TOOL_NAMES[tool as ToolName] : null;
}

/**
 * What a tool row's status means on every screen, so no screen reads `status` alone. Why a tool
 * waits for review is the kernel's `review_reason`, never read off its other columns:
 * - `on`: enabled ("On", and its outcome on Rules);
 * - `changed`: its definition changed and waits for the owner's review ("Needs your review");
 * - `not_on`: connected and never turned on ("Off", no Today item);
 * - `delisted`: no longer listed by its connector ("Off", no Today item, and never offered to add again);
 * - `off`: turned off ("Off").
 */
export type ToolState = 'on' | 'changed' | 'not_on' | 'delisted' | 'off';

/**
 * The row's state, from its status and, while it waits for review, its reason. A row waiting with
 * no reason (an API without the field, which sends `needs_review` only for a connect) or a reason
 * this build doesn't know is `not_on`, never changed or on; an unknown status is off.
 */
export function toolState(row: Pick<ToolRow, 'status' | 'review_reason'>): ToolState {
  if (row.status === 'enabled') return 'on';
  if (row.status !== 'needs_review') return 'off';
  if (row.review_reason === 'changed') return 'changed';
  if (row.review_reason === 'delisted') return 'delisted';
  return 'not_on';
}

/** A connector is on while any of its tools is on or changed (listed in `rows`), else off. */
export function connectorOn(connector: CatalogConnector, rows: readonly Pick<ToolRow, 'tool' | 'status' | 'review_reason'>[]): boolean {
  return rows.some((row) => connector.tools.includes(row.tool) && (toolState(row) === 'on' || toolState(row) === 'changed'));
}
