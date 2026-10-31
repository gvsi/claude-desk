import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Link, Outlet, useLocation, useMatches, useNavigate, useNavigationType, useOutletContext, useParams } from 'react-router';

import { ABOUT_LINKS } from '../about/links.ts';
import { ApiError, isUncertain, ownerErrorCopy, request } from '../api/http.ts';
import type { BusinessOut, CopyOut, DeskSummary } from '../api/views.ts';
import { NotFound } from '../app/NotFound.tsx';
import {
  AppShell,
  Button,
  ConceptFooter,
  Dialog,
  Mark,
  Notice,
  ReviewerBar,
  Sidebar,
  SwitcherMenu,
  Wordmark,
  type NavKey,
  type RulesLinkProps,
  type SidebarHrefs,
  type SidebarLinkProps,
  type SwitcherPick,
} from '../ds/index.ts';
import { writeLocal } from '../lib/storage.ts';
import { connectorPageHref } from './connectors/pages.ts';
import { AskClaudeProvider, useAskClaudeHost } from './rules/askClaude.tsx';
import { DESKS_KEY, desksQuery, findDesk, invalidateCopy, lastOrFirst, todayPath, useDesks, useToday, useTodayReadAhead } from './useDesks.ts';

import './OwnerLayout.css';

/** What every owner page under a Desk gets from the layout. */
export interface OwnerDeskContext {
  business: BusinessOut;
  desk: DeskSummary;
  /**
   * Turns Answering on or off for this Desk: the sidebar's switch, which any other Answering switch
   * calls too, so they always agree, with its quick change and its lines when a change didn't save.
   */
  setAnswering: (on: boolean) => void;
  /**
   * Keeps this Desk's pages up while `on`, even once a read of the copy no longer lists the Desk,
   * so a page settling a delete of it says how the delete went instead of "not found". Off, a read
   * without the Desk is "not found" again.
   */
  holdDesk: (on: boolean) => void;
  /**
   * Goes to the owner's place on the page that history entry `key` shows, when Back or Forward
   * returned to it while the page was still loading and too short to hold it: a page that draws
   * after a loading line (Today) calls it once drawn. Otherwise it does nothing.
   */
  reachPlace: (key: string) => void;
}

/** The business and Desk a frame shows. */
interface ShownDesk {
  business: BusinessOut;
  desk: DeskSummary;
}

/** The business and Desk the owner is on, for a page under `/app/:deskId`. */
export function useOwnerDesk(): OwnerDeskContext {
  return useOutletContext<OwnerDeskContext>();
}

const NAV_KEYS: readonly NavKey[] = ['today', 'conversations', 'people', 'rules', 'safety', 'share', 'settings'];

/**
 * The pages that lay out their own columns across the main area (`AppShell` `fill`), each with the
 * concept footer in the column its boards put it in. Settings centers the content column itself,
 * with the footer at the window's foot.
 */
const FILL_PAGES: ReadonlySet<NavKey> = new Set<NavKey>(['conversations', 'settings']);

/** Of those, the pages that center the content column: a notice above one keeps to that column. */
const CENTERED_PAGES: ReadonlySet<NavKey> = new Set<NavKey>(['settings']);

/**
 * Every row a page can be: the rows above and Connectors, which the sidebar draws only once its
 * pages are built (`connectorPageHref`); until then, as Connectors it marks no row.
 */
const CURRENT_KEYS: readonly NavKey[] = [...NAV_KEYS, 'connectors'];

/** The sidebar row for the page at `pathname`: the segment after the Desk, Today when it names no row. */
function currentNav(pathname: string): NavKey {
  const segment = pathname.split('/')[3] ?? '';
  return CURRENT_KEYS.find((key) => key === segment) ?? 'today';
}

/** Whether the page at `pathname` is the Desk's Today, which the Desk's own address opens too. */
function opensToday(pathname: string): boolean {
  const [page = '', ...rest] = pathname.split('/').slice(3);
  return (page === '' || page === 'today') && rest.every((segment) => segment === '');
}

/**
 * The sidebar's rows under the Desk. Connectors only once its pages are built (`connectorPageHref`):
 * until then it has no href, so its row stays hidden.
 */
function hrefsFor(deskId: string): SidebarHrefs {
  const base = `/app/${encodeURIComponent(deskId)}`;
  const hrefs = Object.fromEntries(NAV_KEYS.map((key) => [key, `${base}/${key}`])) as SidebarHrefs;
  const connectors = connectorPageHref(deskId, 'connectors');
  return connectors === undefined ? hrefs : { ...hrefs, connectors };
}

/**
 * A link the design system's pieces draw (the sidebar's rows, a page's SubNav, a breadcrumb, a
 * rules or connector row) through the router, so moving between pages keeps the app loaded.
 */
export function RouterLink({ href, children, ...rest }: SidebarLinkProps | RulesLinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

/** The same Desks with this Desk's Answering set to `on`; the same list when it doesn't hold the Desk. */
function withAnswering(businesses: BusinessOut[] | undefined, deskId: string, on: boolean): BusinessOut[] | undefined {
  if (businesses === undefined || findDesk(businesses, deskId) === null) return businesses;
  return businesses.map((b) => ({ ...b, desks: b.desks.map((d) => (d.desk_id === deskId ? { ...d, answering: on } : d)) }));
}

const onOff = (on: boolean) => (on ? 'on' : 'off');

/**
 * `/app/:deskId`: the owner's frame around every page of a Desk. The reviewer bar with Start over,
 * the sidebar (the business, which opens the business switcher; the Desk picker; the pages; the
 * About this prototype links; the Answering switch; the owner), the page, and one concept footer
 * under it. A Desk outside the copy is not found.
 */
export function OwnerLayout() {
  const { deskId = '' } = useParams();
  return <DeskGate key={deskId} deskId={deskId} />;
}

/**
 * One Desk's frame, mounted afresh for each Desk, so the copy's Desks are read again whenever the
 * owner lands on a Desk they don't list (a new copy's, a Desk just made). Only that fresh read can
 * say the Desk isn't the owner's, unless a page holds the Desk (`holdDesk`) while it settles a
 * delete: then the frame stays up as it last was, and the page moves on once it knows. Opened at
 * Today's address with the loading page up (a reload, a Desk not listed yet), the loading page stays
 * while what Today first shows is read too, so Today opens drawn after one loading step; a Desk
 * already listed (a switch between Desks) opens at once, onto Today, which holds itself.
 */
function DeskGate({ deskId }: { deskId: string }) {
  const desks = useDesks(deskId);
  const location = useLocation();
  const found = desks.data ? findDesk(desks.data, deskId) : null;
  const [held, setHeld] = useState<ShownDesk | null>(null);
  const shown = found ?? held;
  const readingAhead = useTodayReadAhead(deskId, found === null && opensToday(location.pathname));

  if (shown) {
    if (readingAhead) return <OwnerState />;
    return <DeskFrame businesses={desks.data ?? []} business={shown.business} desk={shown.desk} onHold={setHeld} />;
  }
  if (desks.isError) return <OwnerState error={desks.error} onRetry={() => void desks.refetch()} />;
  if (desks.data && !desks.isFetching) return <NotFound />;
  return <OwnerState />;
}

/**
 * Opens each new page at its top, and Back and Forward at the owner's place on the page they
 * return to. The shell's main area scrolls on its own and would keep the last page's place, so
 * "See all rules" at the end of Rules would open All rules near its end; and neither the browser
 * nor the router restores an area's place, so "Keep my rules" on a review, which goes back, would
 * land on Rules' top. Each place is remembered by its history entry as the owner scrolls, since by
 * the time a page has gone its area already holds the next one. A page is its route on this Desk;
 * moving within one page (an attempt or a conversation beside its list) keeps the page's place, as
 * those routes are made to. A place the page can't reach yet, because it is still loading, waits for
 * the page to ask for it once drawn (the `reachPlace` this returns).
 */
function useOpenPagesAtTop(inside: RefObject<HTMLElement | null>, deskId: string): (key: string) => void {
  const matches = useMatches();
  const page = matches[matches.length - 1]?.id;
  const { key } = useLocation();
  const navigationType = useNavigationType();
  // The main area's place in each history entry, and the entry it is showing.
  const places = useRef(new Map<string, number>());
  const entry = useRef(key);
  // The place Back or Forward returned to that the page was too short to hold, and its entry.
  const unreached = useRef<{ key: string; top: number } | null>(null);

  // Set before the page's place below, so the scroll that place makes is heard as this entry's.
  useLayoutEffect(() => {
    entry.current = key;
  }, [key]);

  useLayoutEffect(() => {
    const main = inside.current?.closest('main');
    if (!main) return undefined;
    const remember = () => places.current.set(entry.current, main.scrollTop);
    main.addEventListener('scroll', remember, { passive: true });
    return () => main.removeEventListener('scroll', remember);
  }, [inside]);

  useLayoutEffect(() => {
    const main = inside.current?.closest('main');
    if (!main) return;
    // `key` and `navigationType` are read only when the page changes: within a page, its place stays.
    const top = navigationType === 'POP' ? (places.current.get(key) ?? 0) : 0;
    main.scrollTop = top;
    unreached.current = main.scrollTop < top - 1 ? { key, top } : null;
  }, [inside, deskId, page]);

  return useCallback(
    (at: string) => {
      const main = inside.current?.closest('main');
      const place = unreached.current;
      if (!main || place?.key !== at) return;
      unreached.current = null;
      main.scrollTop = place.top;
    },
    [inside],
  );
}

interface DeskFrameProps extends ShownDesk {
  businesses: BusinessOut[];
  /** Holds this business and Desk on screen, or lets them go (null). */
  onHold: (shown: ShownDesk | null) => void;
}

function DeskFrame({ businesses, business, desk, onHold }: DeskFrameProps) {
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const today = useToday(deskId);
  // Ask Claude, beside the page that opened it (the Rules page, a tool's page).
  const askClaude = useAskClaudeHost(deskId, business.owner_display_name);
  const layout = useRef<HTMLDivElement>(null);
  const reachPlace = useOpenPagesAtTop(layout, deskId);
  const [switching, setSwitching] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The Desk the owner is on is the one to come back to.
  useEffect(() => {
    writeLocal('lastDesk', deskId);
  }, [deskId]);

  const answering = useMutation({
    mutationFn: (on: boolean) => request('setAnswering', { params: { desk_id: deskId }, body: { on } }),
    onMutate: async (on) => {
      setNotice(null);
      await queryClient.cancelQueries({ queryKey: DESKS_KEY });
      queryClient.setQueryData<BusinessOut[]>(DESKS_KEY, (current) => withAnswering(current, deskId, on));
    },
    // This can run after the frame has gone (Start over opened a new copy while the change was out),
    // so it only ever puts back this Desk's switch, in the Desks as they are now, and leaves a list
    // without this Desk alone.
    onError: async (err, on) => {
      const was = !on;
      const putBack = () => queryClient.setQueryData<BusinessOut[]>(DESKS_KEY, (current) => withAnswering(current, deskId, was));
      if (err instanceof ApiError && err.kind === 'unauthorized') {
        putBack();
        return;
      }
      if (!isUncertain(err)) {
        putBack();
        setNotice(`That didn't save, so Answering is still ${onOff(was)}.`);
        return;
      }
      // The change may have been applied with its answer lost: the switch shows what the Desk reads now.
      const read = await queryClient.fetchQuery(desksQuery()).catch(() => null);
      if (read === null) {
        // Nor could the Desk be read: the switch stays where it was put, and the next read settles it.
        setNotice(`We couldn't confirm that Answering is now ${onOff(on)}. Reload to see where it stands.`);
        void queryClient.invalidateQueries({ queryKey: DESKS_KEY });
        return;
      }
      // A copy without this Desk (a new one, from Start over) has nothing of this change to show.
      const now = findDesk(read, deskId)?.desk.answering;
      if (now !== undefined && now !== on) setNotice(`That didn't save, so Answering is still ${onOff(now)}.`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DESKS_KEY }),
  });

  /** The new copy's first Today; the old copy's pages are left behind. */
  const openCopy = useCallback(
    async (copy: CopyOut) => {
      setConfirming(false);
      const first = copy.desks[0];
      // Leave this Desk first: read again while it is still shown, the copy without it would say it's gone.
      await navigate(first ? todayPath(first.desk_id) : '/', { replace: true });
      await invalidateCopy(queryClient);
    },
    [navigate, queryClient],
  );

  const startOver = useMutation({
    mutationFn: () => request('startOver'),
    onMutate: () => setNotice(null),
    onSuccess: openCopy,
    onError: async (err) => {
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      // A lost answer may still have made the new copy: if this Desk is gone from it, it did.
      if (isUncertain(err)) {
        const copy = await request('me').catch(() => null);
        if (copy && !copy.desks.some((d) => d.desk_id === deskId)) {
          await openCopy(copy);
          return;
        }
      }
      setConfirming(false);
      setNotice(ownerErrorCopy(err));
    },
  });

  const pickBusiness = ({ businessId, deskId: first }: SwitcherPick) => {
    const picked = businesses.find((b) => b.business_id === businessId);
    void navigate(todayPath((picked && lastOrFirst(picked.desks)) ?? first));
  };

  const live = today.data?.live.length ?? 0;
  const current = currentNav(location.pathname);
  // Conversations lays out its own columns from the sidebar's edge, as its boards draw it; Settings
  // centers its own, with the footer at the window's foot.
  const fill = FILL_PAGES.has(current);
  const layoutClass = ['cd-owner-layout', fill ? 'cd-owner-layout--fill' : '', CENTERED_PAGES.has(current) ? 'cd-owner-layout--centered' : '']
    .filter(Boolean)
    .join(' ');
  const setAnswering = (on: boolean) => answering.mutate(on);
  const holdDesk = (on: boolean) => onHold(on ? { business, desk } : null);
  const sidebar = (
    <OwnerSidebar
      businesses={businesses}
      business={business}
      desk={desk}
      current={current}
      liveCount={live}
      switching={switching}
      onToggleSwitcher={() => setSwitching((open) => !open)}
      onCloseSwitcher={() => setSwitching(false)}
      onPickBusiness={pickBusiness}
      onNewBusiness={() => void navigate('/app/setup')}
      onSwitchDesk={(id) => void navigate(todayPath(id))}
      onAnsweringChange={setAnswering}
    />
  );

  return (
    <AppShell
      business={business.name}
      banner={<ReviewerBar ownerName={business.owner_display_name} onStartOver={() => setConfirming(true)} />}
      sidebar={sidebar}
      fill={fill}
      panel={askClaude.panel}
    >
      <div ref={layout} className={layoutClass}>
        {notice !== null ? (
          <div className="cd-owner-layout__notice">
            <Notice tone="error">{notice}</Notice>
          </div>
        ) : null}
        <AskClaudeProvider value={askClaude.value}>
          <Outlet context={{ business, desk, setAnswering, holdDesk, reachPlace } satisfies OwnerDeskContext} />
        </AskClaudeProvider>
        {fill ? null : (
          <footer className="cd-owner-layout__footer">
            <ConceptFooter />
          </footer>
        )}
      </div>
      {confirming ? (
        <Dialog
          title="Start over with a fresh copy?"
          body="You'll get a new copy of Rivera Plumbing. This copy, its chats and its rules are left behind."
          confirmLabel="Start over"
          cancelLabel="Keep this copy"
          pending={startOver.isPending}
          onConfirm={() => startOver.mutate()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </AppShell>
  );
}

interface OwnerSidebarProps {
  businesses: BusinessOut[];
  business: BusinessOut;
  desk: DeskSummary;
  current: NavKey;
  liveCount: number;
  switching: boolean;
  onToggleSwitcher: () => void;
  onCloseSwitcher: () => void;
  onPickBusiness: (pick: SwitcherPick) => void;
  onNewBusiness: () => void;
  onSwitchDesk: (deskId: string) => void;
  onAnsweringChange: (on: boolean) => void;
}

/** The sidebar, and the business switcher beside its business row while it is open. */
function OwnerSidebar(props: OwnerSidebarProps) {
  const { businesses, business, desk, liveCount } = props;
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className="cd-owner-layout__sidebar">
      <Sidebar
        business={business.name}
        onSwitchBusiness={props.onToggleSwitcher}
        desks={business.desks.map((d) => ({ id: d.desk_id, name: d.name }))}
        currentDeskId={desk.desk_id}
        onSwitchDesk={props.onSwitchDesk}
        current={props.current}
        hrefs={hrefsFor(desk.desk_id)}
        peopleLabel="Customers"
        counts={
          liveCount > 0
            ? { conversations: { n: liveCount, label: `${liveCount} live ${liveCount === 1 ? 'conversation' : 'conversations'}` } }
            : undefined
        }
        answering={desk.answering}
        onAnsweringChange={props.onAnsweringChange}
        owner={{ name: business.owner_display_name, status: 'Available for chats' }}
        linkComponent={RouterLink}
        about={ABOUT_LINKS}
      />
      {props.switching ? (
        <BesideTheBusinessRow container={ref}>
          <SwitcherMenu
            businesses={businesses.map((b) => ({ id: b.business_id, name: b.name, desks: b.desks.map((d) => ({ id: d.desk_id, name: d.name })) }))}
            currentBusinessId={business.business_id}
            onPick={props.onPickBusiness}
            onNewBusiness={props.onNewBusiness}
            onClose={props.onCloseSwitcher}
          />
        </BesideTheBusinessRow>
      ) : null}
    </div>
  );
}

/** Room the menu needs to sit beside the row: its width and a gutter. */
const MENU_ROOM = 320;
const GAP = 8;

/**
 * Places the switcher beside the sidebar's business row (the control that opens a menu), level
 * with it, or under it where the window has no room at the side, as in the phone's menu sheet.
 */
function BesideTheBusinessRow({ container, children }: { container: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  // Measured as the menu first renders, so it is in place (and can take focus) from the start.
  const [style] = useState<CSSProperties>(() => {
    const row = container.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    if (!row) return {};
    const rect = row.getBoundingClientRect();
    const beside = window.innerWidth - rect.right >= MENU_ROOM;
    return beside ? { top: rect.top, left: rect.right + GAP } : { top: rect.bottom + GAP / 2, left: rect.left };
  });
  return (
    <div className="cd-owner-layout__switcher" style={style}>
      {children}
    </div>
  );
}

/** While the copy's Desks load, or when they can't be read: the product's name, a line and a next step. */
function OwnerState({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  const titleId = useId();
  return (
    <div className="cd-owner-state">
      <header className="cd-owner-state__brand">
        <Mark />
        <Wordmark />
      </header>
      <main className="cd-owner-state__main" aria-labelledby={titleId}>
        <h1 id={titleId} className="cd-sr-only">
          Claude Desk
        </h1>
        {error === undefined ? (
          <p className="cd-owner-state__line cd-type-meta" role="status">
            Opening your Desk
          </p>
        ) : (
          <Notice
            tone="error"
            action={
              <Button variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            }
          >
            {ownerErrorCopy(error)}
          </Notice>
        )}
      </main>
      <footer>
        <ConceptFooter />
      </footer>
    </div>
  );
}
