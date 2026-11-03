import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { ApiError, ownerErrorCopy, request } from '../../api/http.ts';
import type { PolicyVersionOut, RulesDraft, RulesPreset, Suggestion } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import {
  Button,
  Card,
  Composer,
  SectionHeader,
  SkeletonScreen,
  MoneyLimit,
  Notice,
  PRESET_WORDS,
  PageHeader,
  PresetMenu,
  SuggestionChips,
  useAskClaudeIsSheet,
  type NoticeTone,
  type SentencePart,
} from '../../ds/index.ts';
import { listWords } from '../../lib/format.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { deskPath, RIVERA_SAMPLE_BUSINESS_NAME, useNeedsYou } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { WORDS_MAX, useAskClaude } from './askClaude.tsx';
import { capOf, draftFromDiff, type RuleDraft } from './drafts.ts';
import { AcrossYourDeskRules, moneyTitles, NeverMovesMoney, NOTHING_LANDED, ToolConnectors, ToolRule, type LandedRules, type ToolGroup } from './HouseRules.tsx';
import { holdQuestion, parseLimit } from './hub.ts';
import { reducesMotion, takeLanding, useLanding, type Landing } from './landing.ts';
import { draftFailure } from './RuleChat.tsx';
import { peopleQuery, rulesQuery, type RuleDraftState } from './RuleDraftReview.tsx';
import { moneyCapBandSentence } from './ruleSentence.ts';
import { ABOVE_CEILING, moneyLimitHint, moneyLimitLine } from './ruleWords.ts';

import { RulesSkeleton } from './RulesSkeleton.tsx';
import { COMPOSER_HELPER, RULES_SECTIONS, RULES_SUBTITLE, rulesChipsToOffer, rulesVersionLine } from './copy.ts';

import './RulesPage.css';

/** The Rules page's title, which the pages under it (a change's review) name it by. */
export const RULES_TITLE = 'Rules';

// The optional reads share one deadline, starting when the rules read settles.
const NEEDS_YOU_FIRST_LOAD_WAIT_MS = 3_000;

// How long Rules, back from a confirmed change, waits for its rules to have that change's version
// before it draws the rules it has: a read can lag behind the confirm.
const LANDING_WAIT_MS = 4_000;

const COMPOSER_LABEL = 'Ask Claude to change a rule';

/** RulesPage.css hides the chips below 640 px, so their read cannot move a phone's sections. */
const CHIPS_HIDDEN = '(max-width: 639.98px)';

function subscribeChipsHidden(onChange: () => void): () => void {
  const query = window.matchMedia(CHIPS_HIDDEN);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function chipsHidden(): boolean {
  return window.matchMedia(CHIPS_HIDDEN).matches;
}

const draftPath = (deskId: string, version: number) => `${deskPath(deskId)}/rules/drafts/${version}`;

/** The Desk's suggested rules, read with the rules. */
function suggestionsQuery(deskId: string) {
  return { queryKey: ['suggestions', deskId], queryFn: () => request('suggestions', { params: { desk_id: deskId } }) } as const;
}

/** A line on what went wrong, with its tone. */
interface Said {
  tone: NoticeTone;
  line: string;
}

/**
 * `landed` with `landing`'s rows, each now from it: the cards it changed, by id; the tools it turned
 * on (every tool it changed, from a caller that names no cards); the tools its review listed; a
 * removed rule's default; and the payment limit.
 */
function withLanding(landed: LandedRules, landing: Landing): LandedRules {
  const { rows } = landing;
  const tools = new Map(landed.tools);
  for (const tool of rows.cards === undefined ? rows.tools : rows.turnedOn ?? []) tools.set(tool, landing.id);
  const reviewed = new Map(landed.reviewed);
  for (const tool of rows.tools) reviewed.set(tool, landing.id);
  const cards = new Map(landed.cards);
  for (const card of rows.cards ?? []) cards.set(card, landing.id);
  return {
    cards, tools, reviewed,
    fallback: rows.fallback === true ? landing.id : landed.fallback,
    limit: rows.moneyLimit ? landing.id : landed.limit,
  };
}

/**
 * The first row `landing` changed, in the page's order, within `page`: a rule's row, the payment
 * limit's, or "Anything not listed here" (each carries its landing as `data-landed`). Null when
 * none is drawn.
 */
function firstLandedRow(page: Element, landing: Landing): HTMLElement | null {
  return page.querySelector<HTMLElement>(`[data-landed="${landing.id}"]`);
}

/** The nearest ancestor of `el` that scrolls, or none when the window does. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

/** Scrolls `row` to the middle of what shows it, unless it is in view already: at once under reduced motion. */
function bringToMiddle(row: HTMLElement): void {
  const scroller = scrollerOf(row);
  const port = scroller === null ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.top >= port.top && box.bottom <= port.bottom) return;
  row.scrollIntoView({ block: 'center', behavior: reducesMotion() ? 'auto' : 'smooth' });
}

/**
 * The control that opened a review from Rules. Once the review returns to the history entry Rules
 * showed (`key`), by Keep my rules, Confirm change or Back, `find` finds it again in Rules' page, or
 * says it has gone (null), as a suggestion has once its rule is confirmed and `landed`. One at a
 * time: each review Rules opens replaces it.
 */
interface Opener {
  deskId: string;
  key: string;
  find: (page: HTMLElement, landed: boolean) => HTMLElement | null;
}

let opener: Opener | null = null;

/** `el` when the owner can use it, not under a layer no one can (a skeleton's, as it fades); else null. */
const usable = (el: HTMLElement | null | undefined): HTMLElement | null => (el != null && el.closest('[inert]') === null ? el : null);

/** The first control in `row` that takes focus: a tool's link, or a button such as the payment limit's "Change". */
function firstControl(row: HTMLElement): HTMLElement | null {
  return usable(row.querySelector<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'));
}

/**
 * `row` itself, for a landed row with no control of its own (a tool's row while the Connectors pages
 * aren't built): it takes focus from a script only, never as a Tab stop, until focus leaves it.
 */
function focusableRow(row: HTMLElement): HTMLElement {
  if (!row.hasAttribute('tabindex')) {
    row.setAttribute('tabindex', '-1');
    row.addEventListener('blur', () => row.removeAttribute('tabindex'), { once: true });
  }
  return row;
}

/** "Start from a preset", in Rules' header. */
const presetButton = (page: HTMLElement) => usable(page.querySelector<HTMLElement>('.cd-preset-menu > button'));

/** The payment limit's "Change" in the money band atop the connector card `group` (its id). */
function limitChange(page: HTMLElement, group: string): HTMLElement | null {
  const band = [...page.querySelectorAll<HTMLElement>('[data-money-band]')].find((el) => el.dataset.moneyBand === group && usable(el) !== null);
  return usable(band?.querySelector<HTMLElement>('[data-money-limit] .cd-house-rules__rule-actions > .cd-button'));
}

/** The suggested rule for `tool`'s "Draft this rule", until its rule is confirmed. */
function suggestionButton(page: HTMLElement, tool: string, landed: boolean): HTMLElement | null {
  if (landed) return null;
  const card = [...page.querySelectorAll<HTMLElement>('[data-suggestion]')].find((el) => el.dataset.suggestion === tool);
  return usable(card?.querySelector<HTMLElement>('button'));
}

/** The payment limit's field while it is open, in one group at a time. */
interface LimitField {
  group: string;
  value: string;
  error?: string;
  pending: boolean;
}

/**
 * `rules` (REV-RULES-D, A): every rule the Desk has, on one page. Under the header and its "Start
 * from a preset", which drafts a preset as one change, Ask Claude; then "Across your Desk", the
 * always-on rules over every tool and what happens to anything else; then the Desk's tools, tool by
 * tool, each with the rules that cover it, the payment limit with "Change" atop Payments and
 * Stripe. Each tool links to its page under Connectors once those pages are built. Every
 * change opens its proved review first, and lands back here on the rules it changed.
 */
export function RulesPage() {
  const { desk, reachPlace } = useOwnerDesk();
  useDocumentTitle(inApp(RULES_TITLE));
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const location = useLocation();
  const { ask, open: asking, busy: answering } = useAskClaude();
  const acrossId = useId();
  const toolsId = useId();
  const rules = useQuery({ ...rulesQuery(deskId), refetchInterval: pollMs('rules') });
  // Turner's fixed examples, less any whose change is already in effect: all of them until the rules are read.
  const fixedChips = desk.business_name === RIVERA_SAMPLE_BUSINESS_NAME ? rulesChipsToOffer(rules.data?.active.cards) : [];
  const people = useQuery(peopleQuery(deskId));
  const suggestions = useQuery({ ...suggestionsQuery(deskId), refetchInterval: pollMs('rules') });
  // The Desk's held requests, as Needs you lists them: the latest is one more thing to ask about,
  // but only from a read made since the page opened, with no failed read since the last that
  // worked and none waiting for the network, so a hold answered or expired since never shows. The
  // page reads it as it opens, so the question doesn't wait for the first poll.
  const needsYou = useNeedsYou(deskId, { readOnOpen: true });
  const hidesChips = useSyncExternalStore(subscribeChipsHidden, chipsHidden, () => false);
  // Turner's fixed suggestions let the first draw skip waiting for Needs you only once the rules are
  // read: all of them show meanwhile, but the rules may leave none, like another business's page.
  const keepsFixedChips = fixedChips.length > 0 && (rules.data !== undefined || rules.isError);
  const waitingForNeedsYou = !hidesChips && !keepsFixedChips && !needsYou.isFetchedAfterMount && !needsYou.isPaused;
  // Suggested cards move the connectors at every width, so they join the same opening wait.
  const waitingForSuggestions = suggestions.data === undefined && !suggestions.isError && !suggestions.isPaused;
  const [openingWaitEnded, setOpeningWaitEnded] = useState(false);
  const [openingWaitExpired, setOpeningWaitExpired] = useState(false);
  const [skipHoldQuestion, setSkipHoldQuestion] = useState(false);
  const [skipSuggestions, setSkipSuggestions] = useState(false);
  const firstReadsReady = openingWaitEnded || openingWaitExpired || (!waitingForNeedsYou && !waitingForSuggestions);
  if (firstReadsReady && !openingWaitEnded) {
    setOpeningWaitEnded(true);
    // Optional content still unknown at the cap waits for the next visit, keeping sections still.
    if (waitingForNeedsYou) setSkipHoldQuestion(true);
    if (waitingForSuggestions) setSkipSuggestions(true);
  }
  const waitingForOpening = !firstReadsReady;
  useEffect(() => {
    if (!rules.isFetched || !waitingForOpening) return;
    const timer = window.setTimeout(() => setOpeningWaitExpired(true), NEEDS_YOU_FIRST_LOAD_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [rules.isFetched, waitingForOpening]);
  const current = needsYou.isFetchedAfterMount && needsYou.errorUpdatedAt <= needsYou.dataUpdatedAt && needsYou.fetchStatus !== 'paused';
  const question = current && !skipHoldQuestion ? holdQuestion(needsYou.data ?? []) : null;
  const failure = useReadFailure(rules, { pausedRoute: 'rules' });
  const peopleFailure = useReadFailure(people, { pausedRoute: 'people' });
  const [presetPending, setPresetPending] = useState(false);
  const [presetSaid, setPresetSaid] = useState<Said | null>(null);
  const [limit, setLimit] = useState<LimitField | null>(null);

  const active = rules.data?.active;
  // A change the owner confirmed (in Ask Claude, or on its own review page), waiting to land here.
  const landing = useLanding(deskId);
  // A review Rules opened comes back with its change confirmed, often before the rules read has the
  // version it made. Until it does, Rules shows its reading state, never the old rules, then draws
  // the new rows and lands the change on them. The wait ends early, for good, on a read that fails or
  // waits for the network, and after `LANDING_WAIT_MS`: Rules then draws the rules it has, with the
  // read's error if it has one, and the change still lands once a read has its version. A change
  // confirmed in Ask Claude lands on rows already drawn, as before.
  const [openedWithLanding] = useState(() => landing !== null);
  const [landingWaitEnded, setLandingWaitEnded] = useState(false);
  const behindLanding = openedWithLanding && landing !== null && active !== undefined && active.version < landing.version;
  const readStuck = rules.isError || rules.isPaused;
  if (behindLanding && readStuck && !landingWaitEnded) setLandingWaitEnded(true);
  const awaitingLanding = behindLanding && !readStuck && !landingWaitEnded;
  useEffect(() => {
    if (!openedWithLanding) return undefined;
    const timer = window.setTimeout(() => setLandingWaitEnded(true), LANDING_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [openedWithLanding]);
  // Suggestions use the capped optional wait above; they must not keep this region busy after it expires.
  const settled = [rules, people].every((read) => read.isFetched || read.isPaused);
  const [firstReadsEnded, setFirstReadsEnded] = useState(settled);
  if (settled && !firstReadsEnded) setFirstReadsEnded(true);
  const loading = (!settled && !firstReadsEnded) || waitingForOpening || awaitingLanding;
  const drawn = !loading && active !== undefined;
  // Back and "Keep my rules" return to the owner's place once drawn: while the gate holds the page,
  // it may be too short to reach the place, and the question about a hold comes in above it.
  useLayoutEffect(() => {
    if (drawn) reachPlace(location.key);
  }, [drawn, reachPlace, location.key]);
  const chips = question === null || (fixedChips.length === 0 && (!rules.isFetched || waitingForOpening)) ? fixedChips : [...fixedChips, question];

  // A change the owner confirmed (in Ask Claude, or on its own review page) lands on the rows it
  // changed once Rules is drawn with the version it made, so its words cross-fade as the row lights
  // up; while Ask Claude is a sheet over the page, once the sheet closes. Each row keeps "Updated"
  // until the owner leaves Rules.
  const [kept, setKept] = useState<LandedRules>(NOTHING_LANDED);
  const [toReveal, setToReveal] = useState<Landing | null>(null);
  // Where Ask Claude is a sheet over the page, a change lands once the sheet closes.
  const isSheet = useAskClaudeIsSheet();
  const sheetOver = asking && isSheet;
  const ready = landing !== null && drawn && active !== undefined && active.version >= landing.version && !sheetOver;
  const landed = ready ? withLanding(kept, landing) : kept;
  useEffect(() => {
    if (!ready || landing === null) return;
    setKept((now) => withLanding(now, landing));
    setToReveal(landing);
    takeLanding(landing);
  }, [ready, landing]);
  // The first row it changed, if it is out of view, scrolls to the middle: after the owner's place
  // is restored once Rules is drawn (`reachPlace`), so a landed row takes over from it, and after the
  // frame in which a closing sheet gives focus back to what opened it, so that doesn't scroll the
  // page back. With nothing landed, the place stays. Once per landing, at the rules it landed on.
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (toReveal === null) return undefined;
    const frame = requestAnimationFrame(() => {
      const row = page.current === null ? null : firstLandedRow(page.current, toReveal);
      if (row !== null) bringToMiddle(row);
    });
    return () => cancelAnimationFrame(frame);
  }, [toReveal]);

  // A review this entry of Rules opened, back by Keep my rules, Confirm change or Back: once Rules is
  // drawn, at the place it restored, focus goes back to the control that opened it, or, when that
  // has gone, to the first control of the first row the change landed on, or that row itself when it
  // has none, without moving the place.
  const [returning] = useState(() => (opener !== null && opener.deskId === deskId && opener.key === location.key ? opener : null));
  const refocused = useRef(false);
  useLayoutEffect(() => {
    if (returning === null || refocused.current || !drawn || page.current === null) return;
    refocused.current = true;
    if (opener === returning) opener = null;
    const row = ready && landing !== null ? firstLandedRow(page.current, landing) : null;
    const target = returning.find(page.current, row !== null) ?? (row === null ? null : (firstControl(row) ?? focusableRow(row)));
    target?.focus({ preventScroll: true });
  }, [returning, drawn, ready, landing]);

  // Closing Ask Claude gives focus back to what opened it. When that was a suggestion that has gone
  // since, its change now in effect, the composer above the suggestions takes focus instead of the
  // page's body or the panel sliding out, and the page doesn't scroll to it.
  const askRow = useRef<HTMLDivElement>(null);
  const openedBy = useRef<string | null>(null);
  // While an answer comes in, a suggestion waits in its place, as the composer's Send does.
  const pickChip = (words: string) => {
    if (answering) return;
    if (!asking) openedBy.current = words;
    ask(words, { fromSuggestion: true });
  };
  useEffect(() => {
    if (asking) return undefined;
    const chip = openedBy.current;
    openedBy.current = null;
    if (chip === null || chips.includes(chip)) return undefined;
    // What had focus as the panel closed: in the panel, which stays a moment, inert, as it slides out.
    const closing = document.activeElement;
    // After the panel's own return of focus, which finds the suggestion gone. Focus moves only from
    // nowhere or from the closing panel, never from what the owner has focused since; and not at
    // all once the panel opens again or Rules goes.
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      const fromClosingPanel = focused !== null && focused === closing && (!focused.isConnected || focused.closest('[inert]') !== null);
      if (focused !== null && focused !== document.body && !fromClosingPanel) return;
      askRow.current?.querySelector('textarea')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
    // Only as the panel opens or closes, so `chips` is the suggestions drawn as it closed.
  }, [asking]);

  /** Opens a card draft's review, with what it was drafted from and how to find the control that opened it. */
  const review = (draft: RulesDraft, from: PolicyVersionOut, find: Opener['find'], extra: { preset?: RulesPreset; title?: string } = {}) => {
    const built: RuleDraft = draftFromDiff(draft, from, extra.preset);
    // Once confirmed, the review comes back here, where the change lands.
    const state: RuleDraftState = { draft: built, ...(extra.title === undefined ? {} : { title: extra.title }), fromRules: true };
    opener = { deskId, key: location.key, find };
    void navigate(draftPath(deskId, draft.version), { state });
  };

  const pickPreset = async (preset: RulesPreset) => {
    if (active === undefined || presetPending) return;
    setPresetSaid(null);
    setPresetPending(true);
    try {
      const draft = await request('draftPreset', { params: { desk_id: deskId }, body: { preset } });
      const label = PRESET_WORDS.find((item) => item.value === preset)?.label;
      review(draft, active, presetButton, label === undefined ? { preset } : { preset, title: label });
    } catch (err) {
      setPresetSaid(draftFailure(err));
    } finally {
      setPresetPending(false);
    }
  };

  const reviewLimit = async () => {
    if (limit === null || limit.pending || active === undefined) return;
    const parsed = parseLimit(limit.value);
    if ('error' in parsed) {
      setLimit({ ...limit, error: parsed.error });
      return;
    }
    // The amount it is already: nothing to change.
    if (parsed.cents === capOf(active)) {
      setLimit(null);
      return;
    }
    setLimit({ ...limit, error: undefined, pending: true });
    try {
      const draft = await request('draftMoneyCap', { params: { desk_id: deskId }, body: { auto_money_cap_cents: parsed.cents } });
      const { group } = limit;
      review(draft, active, (page) => limitChange(page, group), { title: 'Change your payment limit' });
    } catch (err) {
      const said = err instanceof ApiError && err.code === 'above_platform_ceiling' ? { tone: 'error' as const, line: ABOVE_CEILING } : draftFailure(err);
      setLimit((now) => (now === null ? null : { ...now, pending: false, ...(said === null ? {} : { error: said.line }) }));
    }
  };

  // A Rules error belongs to its read, regardless of whether the rows above it are ready.
  let readError = null;
  if (rules.data === undefined && rules.isError) {
    readError = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" busy={failure?.retrying ?? false} onClick={() => void rules.refetch()}>
            Try again
          </Button>
        }
      >
        {ownerErrorCopy(rules.error)}
      </Notice>
    );
  } else if (failure !== null) {
    readError = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" busy={failure.retrying} onClick={failure.retry}>
            Try again
          </Button>
        }
      >
        {failure.line}
      </Notice>
    );
  }

  let body;
  if (rules.data === undefined && rules.isError) {
    body = null;
  } else if (waitingForOpening || rules.data === undefined || active === undefined) {
    body = null;
  } else {
    const cap = capOf(active);
    const view = rules.data;
    // The payment limit, then "never moves money", atop a card whose tools move money.
    const moneyBand = (group: ToolGroup) => {
      const titles = moneyTitles(group, view);
      const editing = limit !== null && limit.group === group.key ? limit : null;
      return (
        <>
          <CapRow
            parts={moneyCapBandSentence(cap)}
            line={listWords(titles)}
            version={active}
            landed={landed.limit ?? undefined}
            editing={editing}
            field={
              <MoneyLimit
                line={moneyLimitLine(cap)}
                editing
                value={editing?.value ?? ''}
                hint={moneyLimitHint(cap)}
                {...(editing?.error === undefined ? {} : { error: editing.error })}
                disabled={editing?.pending ?? false}
                onEdit={() => {}}
                onChange={(value) => setLimit((now) => (now === null ? null : { ...now, value, error: undefined }))}
                onReview={() => void reviewLimit()}
                onCancel={() => setLimit(null)}
              />
            }
            onEdit={() => setLimit({ group: group.key, value: '', pending: false })}
          />
          <NeverMovesMoney titles={titles} />
        </>
      );
    };
    body = (
      <>
        <section className="cd-rules__section" aria-labelledby={acrossId}>
          <SectionHeader id={acrossId} title={RULES_SECTIONS.across.title} caption={RULES_SECTIONS.across.caption} />
          <AcrossYourDeskRules landed={landed.fallback ?? undefined} />
        </section>
        <section className="cd-rules__section" aria-labelledby={toolsId}>
          <SectionHeader id={toolsId} title={RULES_SECTIONS.tools.title} caption={RULES_SECTIONS.tools.caption} />
          <div className="cd-rules__tool-cards">
            <ToolConnectors deskId={deskId} view={view} people={people.data ?? null} landed={landed} moneyBand={moneyBand} cap={cap} />
          </div>
          <p className="cd-rules__version cd-type-meta">{rulesVersionLine(active.version)}</p>
        </section>
      </>
    );
  }

  return (
    <div ref={page} className="cd-rules" onClick={followInAppLinks(navigate)}>
      <div className="cd-rules__header">
        <PageHeader
          title={RULES_TITLE}
          subtitle={RULES_SUBTITLE}
          actions={<PresetMenu onPick={(preset) => void pickPreset(preset)} pending={presetPending} />}
          actionsBelowOnPhone
          hideSubtitleOnPhone
        />
      </div>
      {presetSaid === null ? null : <Notice tone={presetSaid.tone}>{presetSaid.line}</Notice>}
      <div ref={askRow} className="cd-rules__ask">
        <Composer variant="owner" label={COMPOSER_LABEL} placeholder={COMPOSER_LABEL} helper={COMPOSER_HELPER} maxLength={WORDS_MAX} sendHeld={answering} onSend={ask} />
        {chips.length === 0 ? null : <SuggestionChips label="Suggestions" suggestions={chips} disabled={answering} onPick={pickChip} />}
      </div>
      {readError}
      <SkeletonScreen loading={loading} status="Reading your rules" skeleton={<RulesSkeleton withHeader={false} />} className="cd-rules__region">
        {active === undefined || waitingForOpening || skipSuggestions ? null : <SuggestedRules deskId={deskId} suggestions={suggestions.data ?? []} onDrafted={(draft, tool) => review(draft, active, (page, landed) => suggestionButton(page, tool, landed))} />}
        {peopleFailure === null ? null : (
          <Notice tone="error" action={<Button variant="secondary" busy={peopleFailure.retrying} onClick={peopleFailure.retry}>Try again</Button>}>{peopleFailure.line}</Notice>
        )}
        {body}
      </SkeletonScreen>
    </div>
  );
}

/**
 * The payment limit's row in a money band: its sentence, the tools it holds over, then "Change", its
 * held dot and its Details. "Change" opens `field` under its words, focus in it; closing it puts focus
 * back on "Change". Only when the owner switches it, never on first render, so a page that opens with
 * the field steals no focus.
 */
function CapRow({ parts, line, version, landed, editing, field, onEdit }: {
  parts: readonly SentencePart[]; line: string; version: PolicyVersionOut; landed: number | undefined;
  editing: LimitField | null; field: ReactNode; onEdit: () => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const open = editing !== null;
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    const row = anchor.current?.closest('li');
    const target = open ? row?.querySelector<HTMLElement>('input') : row?.querySelector<HTMLElement>('.cd-house-rules__rule-actions > .cd-button');
    target?.focus();
  }, [open]);
  return (
    <ToolRule
      parts={parts}
      line={line}
      status="held"
      {...(landed === undefined ? {} : { landed })}
      details={{ version, cards: [], moneyCap: true }}
      data={{ 'data-money-limit': true }}
      actions={open ? null : <Button variant="secondary" waiting={false} onClick={onEdit}>Change</Button>}
      below={<div ref={anchor} className="cd-rules__cap-field">{open ? field : null}</div>}
    />
  );
}

/**
 * Rules the owner's answers suggest, each a card with its words and "Draft this rule", which
 * drafts it and opens its review; nothing applies before then.
 */
function SuggestedRules({ deskId, suggestions, onDrafted }: { deskId: string; suggestions: readonly Suggestion[]; onDrafted: (draft: RulesDraft, tool: Suggestion['tool']) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tool: string; said: Said } | null>(null);
  if (suggestions.length === 0) return null;

  const draft = async (tool: Suggestion['tool']) => {
    if (pending !== null) return;
    setSaid(null);
    setPending(tool);
    try {
      onDrafted(await request('draftSuggestion', { params: { desk_id: deskId, tool } }), tool);
    } catch (err) {
      const failure = draftFailure(err);
      if (failure !== null) setSaid({ tool, said: failure });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="cd-rules__suggestions">
      {suggestions.map((suggestion) => (
        <Card key={suggestion.tool} as="section" label="Suggested rule">
          <div className="cd-rules__suggestion" data-suggestion={suggestion.tool}>
            <p className="cd-rules__suggestion-text cd-type-body">{suggestion.text}</p>
            {said?.tool === suggestion.tool ? <Notice tone={said.said.tone}>{said.said.line}</Notice> : null}
            <div>
              <Button variant="secondary" busy={pending === suggestion.tool} onClick={() => void draft(suggestion.tool)}>
                Draft this rule
              </Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
