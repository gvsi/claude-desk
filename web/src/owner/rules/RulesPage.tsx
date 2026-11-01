import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { ApiError, ownerErrorCopy, request } from '../../api/http.ts';
import type { PolicyVersionOut, RulesDraft, RulesPreset, Suggestion } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import {
  AlwaysOnList,
  Button,
  Card,
  Composer,
  ConnectorList,
  ConnectorSection,
  SkeletonScreen,
  MoneyLimit,
  Notice,
  PRESET_WORDS,
  PageHeader,
  PresetMenu,
  SuggestionChips,
  TextLink,
  useAskClaudeIsSheet,
  type NoticeTone,
} from '../../ds/index.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { connectorPageHref } from '../connectors/pages.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { RouterLink, useOwnerDesk } from '../OwnerLayout.tsx';
import { deskPath, RIVERA_SAMPLE_BUSINESS_NAME, useNeedsYou } from '../useDesks.ts';
import { useReadFailure } from '../useReadFailure.ts';
import { WORDS_MAX, useAskClaude } from './askClaude.tsx';
import { BusinessJobs } from './BusinessJobs.tsx';
import { capOf, draftFromDiff, type RuleDraft } from './drafts.ts';
import { holdQuestion, hubSections, parseLimit } from './hub.ts';
import { reducesMotion, takeLanding, useLanding, type Landing } from './landing.ts';
import { draftFailure } from './RuleChat.tsx';
import { peopleQuery, rulesQuery, type RuleDraftState } from './RuleDraftReview.tsx';
import { ABOVE_CEILING, moneyLimitHint, moneyLimitLine } from './ruleWords.ts';

import { RulesSkeleton } from './RulesSkeleton.tsx';
import { COMPOSER_HELPER, RULES_CHIPS, RULES_SUBTITLE, rulesVersionLine } from './copy.ts';

import './RulesPage.css';

/** The Rules page's title, which the pages under it (All rules, a change's review) name it by. */
export const RULES_TITLE = 'Rules';

// The optional reads share one deadline, starting when the rules read settles.
const NEEDS_YOU_FIRST_LOAD_WAIT_MS = 3_000;

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

/** What has landed on Rules since the owner opened it: each tool's latest landing, and the payment limit's. */
interface Landed {
  tools: ReadonlyMap<string, number>;
  limit: number | null;
}

const NOTHING_LANDED: Landed = { tools: new Map(), limit: null };

/** `landed` with `landing`'s rows, each now from it. */
function withLanding(landed: Landed, landing: Landing): Landed {
  const tools = new Map(landed.tools);
  for (const tool of landing.rows.tools) tools.set(tool, landing.id);
  return { tools, limit: landing.rows.moneyLimit ? landing.id : landed.limit };
}

/**
 * The first row `landing` changed, in the page's order, within `page`: a business job's card or a
 * tool's row (each carries its landing as `data-landed`), or the payment limit's line. Null when
 * none is drawn.
 */
function firstLandedRow(page: Element, landing: Landing): HTMLElement | null {
  const rows = [...page.querySelectorAll<HTMLElement>(`[data-landed="${landing.id}"]`)];
  const limit = landing.rows.moneyLimit ? page.querySelector<HTMLElement>('.cd-money-limit--updated') : null;
  if (limit !== null) rows.push(limit);
  rows.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return rows[0] ?? null;
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

/** The payment limit's field while it is open, in one group at a time. */
interface LimitField {
  group: string;
  value: string;
  error?: string;
  pending: boolean;
}

/**
 * `rules` (N-Conn-17-Presets; N-Conn-22-Phone-Presets at 390 px): the Desk's outcomes grouped by
 * connector, each group and tool linking to its page under Connectors once those pages are built
 * (`connectorPageHref`), and drawn without a link until then; Ask Claude under the
 * header; the header's "See all rules" link before "Start from a preset", which drafts a preset
 * as one change; the payment limit atop
 * Payments and Stripe; the always-on rules. Every change opens its proved review first.
 */
export function RulesPage() {
  const { desk, reachPlace } = useOwnerDesk();
  useDocumentTitle(inApp(RULES_TITLE));
  const deskId = desk.desk_id;
  const fixedChips = desk.business_name === RIVERA_SAMPLE_BUSINESS_NAME ? RULES_CHIPS : [];
  const navigate = useNavigate();
  const location = useLocation();
  const { ask, open: asking } = useAskClaude();
  const rules = useQuery({ ...rulesQuery(deskId), refetchInterval: pollMs('rules') });
  const people = useQuery(peopleQuery(deskId));
  const suggestions = useQuery({ ...suggestionsQuery(deskId), refetchInterval: pollMs('rules') });
  // The Desk's held requests, as Needs you lists them: the latest is one more thing to ask about,
  // but only from a read made since the page opened, with no failed read since the last that
  // worked and none waiting for the network, so a hold answered or expired since never shows. The
  // page reads it as it opens, so the question doesn't wait for the first poll.
  const needsYou = useNeedsYou(deskId, { readOnOpen: true });
  const hidesChips = useSyncExternalStore(subscribeChipsHidden, chipsHidden, () => false);
  const waitingForNeedsYou = !hidesChips && fixedChips.length === 0 && !needsYou.isFetchedAfterMount && !needsYou.isPaused;
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
  // Suggestions use the capped optional wait above; they must not keep this region busy after it expires.
  const settled = [rules, people].every((read) => read.isFetched || read.isPaused);
  const [firstReadsEnded, setFirstReadsEnded] = useState(settled);
  if (settled && !firstReadsEnded) setFirstReadsEnded(true);
  const loading = (!settled && !firstReadsEnded) || waitingForOpening;
  const drawn = !loading && active !== undefined;
  // Back and "Keep my rules" may return while the gate leaves the page too short to restore.
  useLayoutEffect(() => {
    if (drawn) reachPlace(location.key);
  }, [drawn, reachPlace, location.key]);
  const chips = question === null || (fixedChips.length === 0 && (!rules.isFetched || waitingForOpening)) ? fixedChips : [...fixedChips, question];

  // A change the owner confirmed (in Ask Claude, or on its own review page) lands on the rows it
  // changed once Rules is drawn with the version it made, so its words cross-fade as the row lights
  // up; while Ask Claude is a sheet over the page, once the sheet closes. Each row keeps "Updated"
  // until the owner leaves Rules.
  const landing = useLanding(deskId);
  const [kept, setKept] = useState<Landed>(NOTHING_LANDED);
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

  /** Opens a card draft's review, with what it was drafted from. */
  const review = (draft: RulesDraft, from: PolicyVersionOut, extra: { preset?: RulesPreset; title?: string } = {}) => {
    const built: RuleDraft = draftFromDiff(draft, from, extra.preset);
    // Once confirmed, the review comes back here, where the change lands.
    const state: RuleDraftState = { draft: built, ...(extra.title === undefined ? {} : { title: extra.title }), fromRules: true };
    void navigate(draftPath(deskId, draft.version), { state });
  };

  const pickPreset = async (preset: RulesPreset) => {
    if (active === undefined || presetPending) return;
    setPresetSaid(null);
    setPresetPending(true);
    try {
      const draft = await request('draftPreset', { params: { desk_id: deskId }, body: { preset } });
      const label = PRESET_WORDS.find((item) => item.value === preset)?.label;
      review(draft, active, label === undefined ? { preset } : { preset, title: label });
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
      review(draft, active, { title: 'Change your payment limit' });
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
    const sections = hubSections(rules.data, people.data ?? null);
    body = (
      <>
        <BusinessJobs view={rules.data} people={people.data ?? null} landed={landed.tools} />
        <ConnectorList summary={rulesVersionLine(active.version)}>
          {sections.map((section) => {
            const editing = limit !== null && limit.group === section.connector.id ? limit : null;
            return (
              <ConnectorSection
                key={section.connector.id}
                connector={section.connector}
                href={connectorPageHref(deskId, section.href)}
                tools={section.tools.map((tool) => {
                  const at = landed.tools.get(tool.key);
                  return { ...tool, href: connectorPageHref(deskId, tool.href), ...(at === undefined ? {} : { landed: at }) };
                })}
                linkComponent={RouterLink}
                {...(section.moneyLimit
                  ? {
                      aboveTools: (
                        <MoneyLimit
                          line={moneyLimitLine(cap)}
                          editing={editing !== null}
                          value={editing?.value ?? ''}
                          hint={moneyLimitHint(cap)}
                          {...(editing?.error === undefined ? {} : { error: editing.error })}
                          disabled={editing?.pending ?? false}
                          updated={landed.limit !== null}
                          onEdit={() => setLimit({ group: section.connector.id, value: '', pending: false })}
                          onChange={(value) => setLimit((now) => (now === null ? null : { ...now, value, error: undefined }))}
                          onReview={() => void reviewLimit()}
                          onCancel={() => setLimit(null)}
                        />
                      ),
                    }
                  : {})}
              />
            );
          })}
        </ConnectorList>
        <p className="cd-rules__all cd-type-meta">
          <TextLink href={`${deskPath(deskId)}/rules/all`}>See all rules</TextLink>
        </p>
      </>
    );
  }

  return (
    <div ref={page} className="cd-rules" onClick={followInAppLinks(navigate)}>
      <div className="cd-rules__header">
        <PageHeader
          title={RULES_TITLE}
          subtitle={RULES_SUBTITLE}
          actions={
            <>
              <span className="cd-type-control">
                <TextLink href={`${deskPath(deskId)}/rules/all`}>See all rules</TextLink>
              </span>
              <PresetMenu onPick={(preset) => void pickPreset(preset)} pending={presetPending} />
            </>
          }
          actionsBelowOnPhone
          hideSubtitleOnPhone
        />
      </div>
      {presetSaid === null ? null : <Notice tone={presetSaid.tone}>{presetSaid.line}</Notice>}
      <div className="cd-rules__ask">
        <Composer variant="owner" label={COMPOSER_LABEL} placeholder={COMPOSER_LABEL} helper={COMPOSER_HELPER} maxLength={WORDS_MAX} onSend={ask} />
        {chips.length === 0 ? null : <SuggestionChips label="Suggestions" suggestions={chips} onPick={ask} />}
      </div>
      {readError}
      <SkeletonScreen loading={loading} status="Reading your rules" skeleton={<RulesSkeleton withHeader={false} />} className="cd-rules__region">
        {active === undefined || waitingForOpening || skipSuggestions ? null : <SuggestedRules deskId={deskId} suggestions={suggestions.data ?? []} onDrafted={(draft) => review(draft, active)} />}
        {peopleFailure === null ? null : (
          <Notice tone="error" action={<Button variant="secondary" busy={peopleFailure.retrying} onClick={peopleFailure.retry}>Try again</Button>}>{peopleFailure.line}</Notice>
        )}
        {body}
        {waitingForOpening ? null : <AlwaysOnList />}
      </SkeletonScreen>
    </div>
  );
}

/**
 * Rules the owner's answers suggest, each a card with its words and "Draft this rule", which
 * drafts it and opens its review; nothing applies before then.
 */
function SuggestedRules({ deskId, suggestions, onDrafted }: { deskId: string; suggestions: readonly Suggestion[]; onDrafted: (draft: RulesDraft) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [said, setSaid] = useState<{ tool: string; said: Said } | null>(null);
  if (suggestions.length === 0) return null;

  const draft = async (tool: Suggestion['tool']) => {
    if (pending !== null) return;
    setSaid(null);
    setPending(tool);
    try {
      onDrafted(await request('draftSuggestion', { params: { desk_id: deskId, tool } }));
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
          <div className="cd-rules__suggestion">
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
