// @vitest-environment node
/**
 * The mock API as `npm run dev:mock` serves it: one store in the dev server's process, reached
 * through real requests with real cookies. Each browser here is a small cookie jar that keeps the
 * `Set-Cookie` answers and sends back only the cookies whose path matches, as a browser does, and
 * each tab is a client sharing its browser's jar.
 */
import { fileURLToPath } from 'node:url';

import { resolveConfig, type Plugin } from 'vite';
import { describe, expect, it, vi } from 'vitest';

import type { SseEvent } from '../api/contracts.ts';
import { apiPath } from '../api/routes.ts';
import type { ApprovalAnswerOut, CopyOut, NeedsYouItem, SetupState, SetupTools, VisitorSession, VisitorTranscript } from '../api/views.ts';
import { openChat } from '../public/PublicChatProvider.tsx';
import { createMockApi, mockApiPlugin, type MockApi } from './devServer.ts';
import { DEMO_CODE } from './script.ts';

const ORIGIN = 'http://localhost:5373';
const DISCOUNT = 'Can I get 50% off if I pay cash?';

interface StoredCookie {
  name: string;
  value: string;
  path: string;
}

/** RFC 6265 path-match: the cookie's path is the request's, or a prefix of it ending at a `/`. */
function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/** One browser's cookies: what the answers set, sent back where their paths match. */
class CookieJar {
  private cookies: StoredCookie[] = [];

  header(path: string): string {
    return this.cookies
      .filter((c) => pathMatches(c.path, path))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  keep(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const pathAttr = attributes.find((a) => a.toLowerCase().startsWith('path='));
      const path = pathAttr ? pathAttr.slice('path='.length) : '/';
      const expired = attributes.some((a) => a.toLowerCase() === 'max-age=0');
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.path === path));
      if (!expired) this.cookies.push({ name, value, path });
    }
  }
}

/** A stream's events as they arrive, read until the one a test waits for. */
interface EventReader {
  /** Every event up to and including the next one of `type`. */
  until(type: SseEvent['type']): Promise<SseEvent[]>;
  close(): Promise<void>;
}

/** One tab: its requests carry its browser's cookies, and their answers' cookies land there. */
class Tab {
  constructor(
    private readonly api: MockApi,
    private readonly jar: CookieJar,
  ) {}

  async send(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = this.jar.header(new URL(path, ORIGIN).pathname);
    if (cookie !== '') headers.set('cookie', cookie);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const request = new Request(new URL(path, ORIGIN), {
      ...init,
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const response = await this.api.handle(request);
    this.jar.keep(response);
    return response;
  }

  /** A JSON answer, which must come with `status`. */
  async json<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
    const response = await this.send(method, path, body);
    const text = await response.text();
    expect(response.status, `${method} ${path}: ${text}`).toBe(status);
    return JSON.parse(text) as T;
  }

  /** Opens an event stream as `EventSource` does, and parses its frames as they come. */
  async stream(path: string): Promise<EventReader> {
    const aborter = new AbortController();
    const response = await this.send('GET', path, undefined, {
      headers: { accept: 'text/event-stream' },
      signal: aborter.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const body = response.body;
    if (!body) throw new Error('the stream has no body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const pending: SseEvent[] = [];
    let buffered = '';
    const readFrame = async (): Promise<void> => {
      for (;;) {
        const end = buffered.indexOf('\n\n');
        if (end !== -1) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length))
            .join('\n');
          if (data !== '') pending.push(JSON.parse(data) as SseEvent);
          return;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('the stream ended');
        buffered += decoder.decode(value, { stream: true });
      }
    };
    return {
      async until(type) {
        for (;;) {
          const index = pending.findIndex((ev) => ev.type === type);
          if (index !== -1) return pending.splice(0, index + 1);
          await readFrame();
        }
      },
      async close() {
        aborter.abort();
        await reader.cancel().catch(() => undefined);
      },
    };
  }
}

/** A browser with its own cookies, and a tab in it. */
function browserOf(api: MockApi): { jar: CookieJar; tab: () => Tab } {
  const jar = new CookieJar();
  return { jar, tab: () => new Tab(api, jar) };
}

/**
 * Runs the app's own code in `tab`: every request it makes (`request`, through `fetch`) goes out
 * from that tab, with its browser's cookies. Returns what `load` resolved to and the requests it
 * made, as "METHOD path", in order.
 */
async function inTab<T>(tab: Tab, load: () => Promise<T>): Promise<{ result: T; requests: string[] }> {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    requests.push(`${method} ${String(input)}`);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    return tab.send(method, String(input), body);
  });
  try {
    return { result: await load(), requests };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('the dev server mock', () => {
  it('two_tabs_share_one_mock_and_stream_approval_before_outcome', { timeout: 15_000 }, async () => {
    const api = createMockApi();
    const browser = browserOf(api);
    const tabA = browser.tab();
    const tabB = browser.tab();

    // Tab A opens the demo with the passcode, and the copy is its browser's.
    const copy = await tabA.json<CopyOut>('POST', apiPath('copies', {}), { passcode: 'demo' }, 201);
    expect((await tabA.json<CopyOut>('GET', apiPath('me', {}))).copy_id).toBe(copy.copy_id);
    const desk = copy.desks[0];
    if (!desk) throw new Error('the copy has a Desk');

    // Tab B has made no request yet: it opens the owner's preview chat on the browser's cookie,
    // which also gives it the visitor cookie for the Desk's public routes.
    const preview = await tabB.json<VisitorSession>('POST', apiPath('openPreview', { desk_id: desk.desk_id }));
    expect(preview.resumed).toBe(false);
    const slug = { slug: desk.slug };
    const before = await tabB.json<VisitorTranscript>('GET', apiPath('visitorSession', slug));
    expect(before.state.session_id).toBe(preview.state.session_id);
    const stream = await tabB.stream(apiPath('events', slug, { after: before.last_seq }));
    try {
      await tabB.json('POST', apiPath('sendMessage', slug), { text: DISCOUNT }, 202);
      expect((await stream.until('turn_end')).map((ev) => ev.type)).toEqual(['writing', 'held', 'message', 'turn_end']);

      // Tab A sees the hold on Needs you and allows it.
      const needsYou = await tabA.json<NeedsYouItem[]>('GET', apiPath('needsYou', { desk_id: desk.desk_id }));
      const held = needsYou.find((item) => item.decision?.session_id === preview.state.session_id);
      expect(held?.from_the_visitor).toBe(DISCOUNT);
      const decisionId = held?.decision?.decision_id;
      if (decisionId === undefined) throw new Error('the hold reached Needs you');
      const answered = await tabA.json<ApprovalAnswerOut>('POST', apiPath('answer', { decision_id: decisionId }), {
        answer: 'allow_once',
      });
      expect(answered.decision.state).toBe('executed');

      // Tab B's open stream carries approval first, then the outcome, back into the chat.
      const followUp = await stream.until('message');
      expect(followUp.map((ev) => ev.type)).toEqual(['receipt', 'resolved', 'writing', 'message']);
      expect(followUp[0]).toMatchObject({ type: 'receipt', decision_id: decisionId, state: 'approved', visitor_plain: 'Mike Turner approved this' });
      expect(followUp[1]).toMatchObject({ type: 'resolved', decision_id: decisionId, state: 'executed', visitor_plain: "Quoted from Mike Turner's price list" });
    } finally {
      await stream.close();
    }
  });

  it('two_tabs_open_one_preview_chat', { timeout: 15_000 }, async () => {
    const api = createMockApi();
    const browser = browserOf(api);
    const tabA = browser.tab();
    const tabB = browser.tab();
    const copy = await tabA.json<CopyOut>('POST', apiPath('copies', {}), { passcode: 'demo' }, 201);
    const desk = copy.desks[0];
    if (!desk) throw new Error('the copy has a Desk');
    const slug = { slug: desk.slug };

    // Today's "Chat as a customer" opens the public page in a tab, then in another tab of the same
    // browser. Each page loads its chat as the public page does: it reads the chat its visitor
    // cookie names, and asks for a preview only when there is none.
    const read = `GET ${apiPath('visitorSession', slug)}`;
    const a = await inTab(tabA, () => openChat(desk.slug, desk.desk_id));
    expect(a.requests).toEqual([read, `POST ${apiPath('openPreview', { desk_id: desk.desk_id })}`, read]);
    const b = await inTab(tabB, () => openChat(desk.slug, desk.desk_id));
    expect(b.requests).toEqual([read]);
    expect(b.result.session.session_id).toBe(a.result.session.session_id);

    // One chat, so a message from either tab is answered on both tabs' streams.
    const streamA = await tabA.stream(apiPath('events', slug, { after: a.result.transcript?.last_seq ?? 0 }));
    const streamB = await tabB.stream(apiPath('events', slug, { after: b.result.transcript?.last_seq ?? 0 }));
    try {
      await tabB.json('POST', apiPath('sendMessage', slug), { text: 'How much is drain clearing?' }, 202);
      const [toA, toB] = await Promise.all([streamA.until('message'), streamB.until('message')]);
      const reply = (events: SseEvent[]) => events.find((ev) => ev.type === 'message');
      expect(reply(toA)).toMatchObject({ type: 'message', author: 'claude' });
      expect(reply(toB)).toEqual(reply(toA));
    } finally {
      await streamA.close();
      await streamB.close();
    }
  });

  it('start_over_sets_a_fresh_owner_cookie', async () => {
    const api = createMockApi();
    const browser = browserOf(api);
    const tab = browser.tab();
    const ownerCookie = (response: Response) => response.headers.getSetCookie().filter((line) => line.startsWith('desk_owner='));
    const valueOf = (line: string | undefined) => /^desk_owner=([^;]*);/.exec(line ?? '')?.[1];

    const opened = await tab.send('POST', apiPath('copies', {}), { passcode: 'demo' });
    expect(opened.status).toBe(201);
    const first = (await opened.json()) as CopyOut;
    const [firstLine] = ownerCookie(opened);
    const firstValue = valueOf(firstLine);
    expect(firstValue).toMatch(/^[A-Za-z0-9]{32}$/);

    // Start over makes a new copy and sets a new owner cookie for it, with the same attributes.
    const restarted = await tab.send('POST', apiPath('startOver', {}));
    expect(restarted.status).toBe(200);
    const fresh = (await restarted.json()) as CopyOut;
    expect(fresh.copy_id).not.toBe(first.copy_id);
    const lines = ownerCookie(restarted);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    const value = valueOf(line);
    expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(value).not.toBe(firstValue);
    expect(line).toBe(`desk_owner=${value ?? ''}; Path=/api/owner; Max-Age=604800; HttpOnly; SameSite=Strict`);

    // The next `me` names the new copy, and the old cookie names nothing any more. That last part is
    // the mock's, not the API's: the mock replaces the copy in place, so it drops the old cookie, which
    // would otherwise name the new copy. The API's start over leaves the old copy as it is and only
    // moves the cookie on, so there the old cookie still names the old copy.
    expect((await tab.json<CopyOut>('GET', apiPath('me', {}))).copy_id).toBe(fresh.copy_id);
    const stale = await api.handle(new Request(new URL(apiPath('me', {}), ORIGIN), { headers: { cookie: `desk_owner=${firstValue ?? ''}` } }));
    expect([stale.status, await stale.json()]).toEqual([401, { error: 'no_owner_session' }]);
  });

  it('separate_browsers_get_separate_copies', { timeout: 15_000 }, async () => {
    const api = createMockApi();
    const first = browserOf(api);
    const tabA = first.tab();
    const tabB = first.tab();
    const copy = await tabA.json<CopyOut>('POST', apiPath('copies', {}), { passcode: 'demo' }, 201);
    const desk = copy.desks[0];
    if (!desk) throw new Error('the copy has a Desk');
    const slug = { slug: desk.slug };
    const deskPath = { desk_id: desk.desk_id };

    // Tab B chats on the copy's public page: it asks for a discount, then for the deposit link.
    const chat = await tabB.json<VisitorSession>('POST', apiPath('openSession', slug));
    const chatStream = await tabB.stream(apiPath('events', slug, { after: 0 }));
    let chatLink: string | undefined;
    try {
      await tabB.json('POST', apiPath('sendMessage', slug), { text: DISCOUNT }, 202);
      await chatStream.until('turn_end');
      await tabB.json('POST', apiPath('sendMessage', slug), { text: 'How do I pay the deposit?' }, 202);
      chatLink = (await chatStream.until('message')).flatMap((ev) => (ev.type === 'message' ? ev.blocks : [])).at(-1)?.href ?? undefined;
    } finally {
      await chatStream.close();
    }
    const needsYouA = await tabA.json<NeedsYouItem[]>('GET', apiPath('needsYou', deskPath));
    const seededA = needsYouA.filter((item) => item.decision?.session_id !== chat.state.session_id);
    expect(needsYouA).toHaveLength(2);
    expect(seededA).toHaveLength(1);

    // A second browser shares none of it: not the copy, not the owner's routes, not tab B's chat.
    const other = browserOf(api).tab();
    for (const path of [apiPath('me', {}), apiPath('needsYou', deskPath)]) {
      const refused = await other.send('GET', path);
      expect([path, refused.status, await refused.json()]).toEqual([path, 401, { error: 'no_owner_session' }]);
    }
    const noChat = await other.send('GET', apiPath('visitorSession', slug));
    expect([noChat.status, await noChat.json()]).toEqual([401, { error: 'no_session' }]);

    // It can still follow the copy's public link, as a stranger would, into a chat of its own.
    expect((await other.send('GET', apiPath('publicDesk', slug))).status).toBe(200);
    const stranger = await other.json<VisitorSession>('POST', apiPath('openSession', slug));
    expect(stranger.resumed).toBe(false);
    expect(stranger.state.session_id).not.toBe(chat.state.session_id);
    const strangerChat = await other.json<VisitorTranscript>('GET', apiPath('visitorSession', slug));
    expect(strangerChat.state.session_id).toBe(stranger.state.session_id);
    expect(strangerChat.items).toEqual([]);

    // Its own passcode makes it a copy of its own: other slugs, only its own seeded hold, and its
    // owner cookie reaches nothing of the first copy.
    const own = await other.json<CopyOut>('POST', apiPath('copies', {}), { passcode: 'demo' }, 201);
    const ownDesk = own.desks[0];
    if (!ownDesk) throw new Error('the copy has a Desk');
    expect(own.copy_id).not.toBe(copy.copy_id);
    expect(ownDesk.slug).not.toBe(desk.slug);
    const ownNeedsYou = await other.json<NeedsYouItem[]>('GET', apiPath('needsYou', { desk_id: ownDesk.desk_id }));
    expect(ownNeedsYou.map((item) => item.from_the_visitor)).toEqual(seededA.map((item) => item.from_the_visitor));
    expect(ownNeedsYou.map((item) => item.decision?.decision_id)).not.toEqual(seededA.map((item) => item.decision?.decision_id));
    expect((await other.send('GET', apiPath('needsYou', deskPath))).status).toBe(404);

    // Its deposit link has a token of its own, as tab B's has: random, never the fixtures' token.
    const ownSlug = { slug: ownDesk.slug };
    await other.json<VisitorSession>('POST', apiPath('openSession', ownSlug));
    const ownStream = await other.stream(apiPath('events', ownSlug, { after: 0 }));
    let ownLink: string | undefined;
    try {
      await other.json('POST', apiPath('sendMessage', ownSlug), { text: 'How do I pay the deposit?' }, 202);
      ownLink = (await ownStream.until('message')).flatMap((ev) => (ev.type === 'message' ? ev.blocks : [])).at(-1)?.href ?? undefined;
    } finally {
      await ownStream.close();
    }
    expect(chatLink).toMatch(/^\/pay\/[A-Za-z0-9]{8}$/);
    expect(ownLink).toMatch(/^\/pay\/[A-Za-z0-9]{8}$/);
    expect(ownLink).not.toBe(chatLink);
    expect([chatLink, ownLink]).not.toContain('/pay/k7Hq2vX9');

    // The first copy is as it was.
    expect(await tabA.json<NeedsYouItem[]>('GET', apiPath('needsYou', deskPath))).toEqual(needsYouA);
    expect((await tabA.json<CopyOut>('GET', apiPath('me', {}))).copy_id).toBe(copy.copy_id);
  });

  /**
   * In a copy of its own, opened with the passcode in `tab`, Dana asks for her last invoice,
   * confirms it's her with the Demo inbox's code, and gets its card: the card's link.
   */
  async function invoiceHref(tab: Tab): Promise<string> {
    const copy = await tab.json<CopyOut>('POST', apiPath('copies', {}), { passcode: 'demo' }, 201);
    const desk = copy.desks[0];
    if (!desk) throw new Error('the copy has a Desk');
    const slug = { slug: desk.slug };
    await tab.json<VisitorSession>('POST', apiPath('openSession', slug));
    const stream = await tab.stream(apiPath('events', slug, { after: 0 }));
    let href: string | null | undefined;
    try {
      await tab.json('POST', apiPath('sendMessage', slug), { text: "I'm Dana Whitfield. Please send my last invoice." }, 202);
      await stream.until('turn_end');
      await tab.json('POST', apiPath('verifyCheck', slug), { code: DEMO_CODE });
      const turn = await stream.until('turn_end');
      href = turn.flatMap((ev) => (ev.type === 'message' ? ev.blocks : [])).find((block) => block.template === 'document_link')?.href;
    } finally {
      await stream.close();
    }
    if (!href) throw new Error('the invoice card links to its document');
    return href;
  }

  it('a_document_cards_link_opens_once_in_a_tab', { timeout: 15_000 }, async () => {
    const api = createMockApi();
    const tab = browserOf(api).tab();
    const href = await invoiceHref(tab);

    // A look first leaves it unopened; the tab then shows the document once, and the API's refusal after.
    const look = await tab.send('HEAD', href);
    expect([look.status, look.headers.get('cache-control'), await look.text()]).toEqual([200, 'no-store', '']);
    const opened = await tab.send('GET', href);
    expect([opened.status, opened.headers.get('content-type'), opened.headers.get('content-disposition')]).toEqual([
      200,
      'text/plain; charset=utf-8',
      'inline; filename="Invoice-drain-clearing.txt"',
    ]);
    expect(await opened.text()).toMatch(/^Turner Plumbing\nInvoice for Dana Whitfield\n/);
    const again = await tab.send('GET', href);
    expect([again.status, await again.text()]).toEqual([404, 'This link was already opened or has expired. Ask in the chat for a new one.']);
    const unknown = await tab.send('GET', `${href}x`, undefined, { headers: { accept: 'application/json' } });
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: 'link_used_or_expired' }]);
  });

  it('each_copys_document_link_opens_once_on_its_own', { timeout: 15_000 }, async () => {
    // Two browsers, each with its own copy, each get Dana's invoice card: two links, neither the
    // fixtures' token, each opening once whatever the other did, then refused.
    const api = createMockApi();
    const first = browserOf(api).tab();
    const second = browserOf(api).tab();
    const hrefs = [await invoiceHref(first), await invoiceHref(second)];
    expect(hrefs[0]).not.toBe(hrefs[1]);
    for (const href of hrefs) expect(href).toMatch(/^\/api\/d\/[A-Za-z0-9]{6}$/);
    expect(hrefs).not.toContain('/api/d/9fK2mQ');
    const status = async (tab: Tab, href: string) => (await tab.send('GET', href)).status;
    expect(await status(first, hrefs[0] ?? '')).toBe(200);
    expect(await status(second, hrefs[1] ?? '')).toBe(200);
    expect([await status(first, hrefs[0] ?? ''), await status(second, hrefs[1] ?? '')]).toEqual([404, 404]);
  });

  it('a_setup_card_the_owner_pressed_reads_as_their_choice_at_the_tools_step', { timeout: 15_000 }, async () => {
    // Chen's setup as the mock app runs it, every turn streamed (faster than a model writes): each
    // card's own button pressed as the page sends it, "Not now" on Stripe and the retainer, then the
    // Tools step's reads, as after a reload. The booking job's card is the owner's own "on its own".
    const api = createMockApi({ streams: { wordMs: 1, setupTurns: true, demoVisitorMs: 60 } });
    const tab = browserOf(api).tab();
    await tab.json<CopyOut>('POST', apiPath('copies', {}), { passcode: 'demo' }, 201);
    const description = "I'm Linda Chen. Chen & Co. is a two-person CPA firm in San Jose doing tax returns and bookkeeping for individuals and small businesses.";
    const { interview_id: id } = await tab.json<SetupState>('POST', apiPath('startSetup', {}), { description, timezone: 'America/Los_Angeles', idempotency_key: crypto.randomUUID() }, 201);
    const cards = { cards: 1 };
    await tab.json<SetupState>('POST', apiPath('setupConsent', { id }, cards), { allow: true }, 202);
    let state = await tab.json<SetupState>('GET', apiPath('setup', { id }, cards));
    for (let reads = 0; state.busy === true && reads < 400; reads += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await tab.json<SetupState>('GET', apiPath('setup', { id }, cards));
    }
    state = await tab.json<SetupState>('POST', apiPath('setupAnswer', { id }, cards), { question: state.question, text: 'Both, about evenly' });
    const pressed: string[] = [];
    while (state.pending_card) {
      const card = state.messages.find((message) => message.card?.proposal_id === state.pending_card)?.card;
      const accept = card?.connector?.app !== 'stripe' && card?.job?.job !== 'payment';
      pressed.push(`${card?.job?.title ?? card?.connector?.label ?? ''}: ${accept ? 'yes' : 'not now'}`);
      state = await tab.json<SetupState>('POST', apiPath('setupProposal', { id, proposal_id: state.pending_card }, cards), { accept });
    }
    expect(pressed).toEqual([
      'Google Calendar: yes', 'Book a free intro call: yes', 'Ask new clients three questions: yes',
      'Stripe: not now', 'Send a retainer link: not now', 'Answer “Where’s my return?”: yes',
    ]);
    state = await tab.json<SetupState>('POST', apiPath('setupAnswer', { id }, cards), { question: state.question, text: 'Ask me before every payment' });
    expect(state.step).toBe('tools');
    const read = await tab.json<SetupState>('GET', apiPath('setup', { id }, cards));
    const { tools } = await tab.json<SetupTools>('GET', apiPath('setupTools', { id }));
    const booking = tools.find((row) => row.source === 'business' && row.business?.config.block === 'typed_booking')?.business;
    if (!booking) throw new Error('setup made the booking job a business tool');
    expect(booking.title).toBe('Book a free intro call');
    // The message the Tools step reads (`acceptedAutonomy`): the accepted card with the job's title and
    // setup, marked as the owner's own decision.
    const madeFrom = read.messages.filter(({ card }) => card?.state === 'accepted' && card.job?.title === booking.title);
    expect(madeFrom.map(({ card, owner_decided: decided }) => [card?.job?.config, decided, card?.job?.autonomy])).toEqual([[booking.config, true, 'auto']]);
  });

  it('plugin_is_mock_mode_only', { timeout: 30_000 }, async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const configFile = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));
    const mockName = mockApiPlugin().name;
    /** The mock API plugins in `web/vite.config.ts` as Vite resolves it for `command` in `mode`. */
    const mockPlugins = async (mode: string, command: 'serve' | 'build'): Promise<readonly Plugin[]> => {
      const config = await resolveConfig({ root, configFile, mode, logLevel: 'silent' }, command);
      return config.plugins.filter((plugin) => plugin.name === mockName);
    };

    for (const mode of ['development', 'test', 'production']) {
      expect(await mockPlugins(mode, 'serve'), mode).toEqual([]);
      expect(await mockPlugins(mode, 'build'), mode).toEqual([]);
    }
    // `vite dev` in mode `mock` has exactly one, which only adds middleware to the dev server;
    // `vite build` in mode `mock` has none.
    const served = await mockPlugins('mock', 'serve');
    expect(served).toHaveLength(1);
    const hooks = Object.keys(served[0] ?? {}).filter((key) => !['name', 'apply', 'enforce'].includes(key));
    expect(hooks).toEqual(['configureServer']);
    expect(served[0]?.apply).toBe('serve');
    expect(await mockPlugins('mock', 'build')).toEqual([]);
  });
});
