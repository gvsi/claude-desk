import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import type { RuleCard } from '../../api/contracts.ts';
import { ApiError, isUncertain, ownerErrorCopy, request } from '../../api/http.ts';
import type { RulesDraft } from '../../api/views.ts';
import {
  Breadcrumb,
  Button,
  ChangeReview,
  LimitChange,
  LoadingLine,
  Notice,
  PageHeader,
  RulesReceipt,
  TextLink,
  ruleDiff,
} from '../../ds/index.ts';
import { formatCents } from '../../lib/format.ts';
import { inApp, useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { connectorPageHref } from '../connectors/pages.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { RouterLink, useOwnerDesk } from '../OwnerLayout.tsx';
import { cancelsLinksFor, changeRows } from './changeRows.ts';
import { checkStatus } from './checkStatus.ts';
import { draftFromAnswer, draftFromDiff, type RuleDraft } from './drafts.ts';
import { rowsChangedBy, type ChangedRows } from './hub.ts';
import { land, reducesMotion } from './landing.ts';
import { RULES_TITLE } from './RulesPage.tsx';
import { moneyCapWords } from './ruleWords.ts';

import './RuleDraftReview.css';

/** The Desk's rules: the active version and every tool row. */
export function rulesQuery(deskId: string) {
  return queryOptions({ queryKey: ['rules', deskId], queryFn: () => request('rules', { params: { desk_id: deskId } }) });
}

/** The business's people and leads, which name a person's rule. */
export function peopleQuery(deskId: string) {
  return queryOptions({ queryKey: ['people', deskId], queryFn: ({ signal }) => request('people', { params: { desk_id: deskId }, signal }) });
}

/** A read the review makes once and keeps while it is open: a later read would change nothing it shows. */
const READ_ONCE = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

const REVIEW_TITLE = 'Review the change';
const SUBTITLE = "Here's exactly what changes on your Desk. Nothing changes until you confirm.";
const UPDATED = 'Your rules are updated.';
const CHANGED_SINCE = 'Your rules changed since this was drafted. Ask for the change again.';
const NOT_CONFIRMED = "We couldn't confirm whether your change went through. Open Rules to see where it stands.";
const NOT_OPEN = "This draft isn't open anymore. Ask for the change again from Rules.";

const rulesPath = (deskId: string) => `/app/${encodeURIComponent(deskId)}/rules`;

/** The draft changes the payment limit and no rule: nothing else to review. */
function onlyTheLimit(draft: RuleDraft): boolean {
  return draft.moneyCap !== null && draft.turnedOn.length === 0 && ruleDiff(draft.before, draft.after).length === 0;
}

/**
 * An uncertain failure (`isUncertain`) that says the rules can't be checked: the request layer
 * giving up a minute after the first send while the API was still checking, or a 5xx with that
 * code. Either way the change may still apply after the rules were read, so `ownerErrorCopy`'s line
 * that it can't be applied would be wrong. Only the API's own 409 is a clear answer that may say so.
 */
function mayStillApply(err: unknown): boolean {
  return isUncertain(err) && err instanceof ApiError && err.code === 'rules_cannot_be_checked';
}

/** A change that has applied: the rules are updated, and where to see them. */
function Updated({ deskId }: { deskId: string }) {
  return (
    <Notice tone="info" action={<TextLink href={rulesPath(deskId)}>See your rules</TextLink>}>
      {UPDATED}
    </Notice>
  );
}

/** What a confirmed change changed, for Rules to show where it landed. */
export interface ConfirmedChange {
  /** The version now in force, from the API's answer, never the draft's guess. */
  version: number;
  /** The rows on Rules it changed (`rowsChangedBy`), from the draft's own cards. */
  rows: ChangedRows;
}

/** "Was $500", or what a limit of 0 meant. */
function wasWords(cents: number): string {
  return cents <= 0 ? 'Was: every payment asked you first' : `Was ${formatCents(cents)}`;
}

export interface RuleDraftReviewProps {
  deskId: string;
  draft: RuleDraft;
  /** The page's title: a preset's name, "Change your payment limit", "Turn on {connector}". */
  title?: string;
  /** Shown inside another page (the Ask Claude panel, setup): no title or breadcrumb of its own. */
  inline?: boolean;
  /** Called once the owner confirmed the draft, or kept their rules; without it, keeping them goes back. */
  onDone?: (outcome: 'confirmed' | 'kept') => void;
  /**
   * Called once, before `onDone`, when a confirm the API answered applied the draft: the version
   * its answer names and the rows on Rules the draft changed. Never on a failed confirm, nor once
   * the review has gone. Returns true when it takes the owner away from the review, which then
   * draws nothing more and calls nothing else.
   */
  onConfirmed?: (change: ConfirmedChange) => boolean | void;
  /**
   * Applies the draft in the caller's way (setup's confirm); `confirmRules` by default. Either way
   * applying it makes `draft.version` the active rules, which is how a lost answer is settled.
   */
  confirm?: () => Promise<unknown>;
  /** The keep button's words where the review sits inside a flow ("Back" in setup's conflict review); the review's own by default. */
  cancelLabel?: string;
  /**
   * Settles a confirm that failed, in the caller's way (setup reads its interview): resolves to the
   * line to show, or null when the caller has taken it from here. Without it, the review's own.
   */
  onConfirmError?: (err: unknown) => Promise<string | null>;
  /**
   * The draft has applied already: its version is in force. The review then says so, as it does once
   * confirmed, with nothing to confirm or keep.
   */
  alreadyApplied?: boolean;
}

/**
 * A rules draft before it applies: the payment limit's change in words, then `ChangeReview` with
 * one Claude-led rule sentence per side of each change and the check in plain
 * words. Only a draft whose check passed can be confirmed, and nothing changes until it is.
 */
export function RuleDraftReview({
  deskId,
  draft,
  title,
  inline = false,
  onDone,
  onConfirmed,
  confirm,
  cancelLabel,
  onConfirmError,
  alreadyApplied = false,
}: RuleDraftReviewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const people = useQuery({ ...peopleQuery(deskId), ...READ_ONCE });
  const rules = useQuery({ ...rulesQuery(deskId), ...READ_ONCE });
  const [done, setDone] = useState(false);
  // The version a confirm's answer named, which the receipt in Ask Claude says; null until then.
  const [confirmed, setConfirmed] = useState<number | null>(null);
  // The review fading out once its confirm is answered, before the receipt takes its place.
  const [leaving, setLeaving] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // The tool rows give each tool's effects, which say which shared rules govern it.
  const tools = rules.data?.tools;
  const rows = useMemo(() => changeRows(draft, people.data ?? null, tools ?? []), [draft, people.data, tools]);
  const turningOn = draft.turnedOn.length > 0;
  const heading = title ?? (onlyTheLimit(draft) ? 'Change your payment limit' : REVIEW_TITLE);
  // On its own page the tab names the review as its title does; inside another page, that page's stays.
  useDocumentTitle(inline ? null : inApp(heading));
  // Where the trail starts, and where keeping the rules goes when there is nothing to go back to: a
  // turn-on's Connectors page once those pages are built (`connectorPageHref`), else Rules.
  const connectors = turningOn ? connectorPageHref(deskId, 'connectors') : undefined;
  const root = connectors === undefined ? { label: RULES_TITLE, href: rulesPath(deskId) } : { label: 'Connectors', href: connectors };

  const finish = (outcome: 'confirmed' | 'kept') => {
    if (onDone) onDone(outcome);
    else if (outcome === 'kept') void (location.key !== 'default' ? navigate(-1) : navigate(root.href));
  };

  // Whether the review is still on screen. An answer that comes after it has gone (the owner went
  // Back while it was on its way) still has the rules read again, but draws nothing and moves no one.
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);

  /** The review's end: its receipt or its done line in place, and the caller told. */
  const settle = () => {
    setLeaving(false);
    setDone(true);
    finish('confirmed');
  };

  // The fade's end settles it (`onAnimationEnd`), and so does its cancelling, when the review is
  // hidden as it runs; React 18 has no prop for that event.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!leaving || el === null) return undefined;
    const cancelled = (event: AnimationEvent) => {
      if (event.target === el) settle();
    };
    el.addEventListener('animationcancel', cancelled);
    return () => el.removeEventListener('animationcancel', cancelled);
    // Listened for while it fades, with the settle of that moment.
  }, [leaving]);

  /**
   * The draft applied. `version` is the one the API's answer names (the confirm's, or the rules read
   * after a lost answer), or null when a caller's own confirm answered with none. In Ask Claude the
   * review fades out on motion-fast and the receipt lands in its place; under reduced motion the end
   * state shows at once. A caller's own confirm (setup's) keeps the review's done line.
   */
  const applied = (version: number | null) => {
    void queryClient.invalidateQueries({ queryKey: ['rules', deskId] });
    if (!shown.current) return;
    if (version !== null && onConfirmed?.({ version, rows: rowsChangedBy(draft, tools ?? []) }) === true) return;
    const receiptVersion = confirm === undefined ? version : null;
    setConfirmed(receiptVersion);
    if (inline && receiptVersion !== null && !reducesMotion()) setLeaving(true);
    else settle();
  };

  /**
   * Settles a confirm whose answer can't say what applied, by the rules as they stand: applied with
   * the version they name when it is the draft's, else `otherwise` (given whether the read worked).
   */
  const settleByReading = async (otherwise: (read: boolean) => string) => {
    const now = await queryClient.fetchQuery({ ...rulesQuery(deskId), staleTime: 0 }).catch(() => null);
    if (now?.active.version === draft.version) applied(now.active.version);
    else setError(otherwise(now !== null));
  };

  const onConfirm = async () => {
    setError(undefined);
    setPending(true);
    try {
      if (confirm) {
        await confirm();
        applied(null);
      } else {
        const answer = await request('confirmRules', { params: { desk_id: deskId }, body: { version: draft.version } });
        // An answer that names no version of its own is settled by the rules read, as a lost one is,
        // so the receipt never says a version the API didn't give.
        if (Number.isSafeInteger(answer.version)) applied(answer.version);
        else await settleByReading(() => NOT_CONFIRMED);
      }
    } catch (err) {
      // The session ended: the app goes back to the start, and there is nothing to say here.
      if (err instanceof ApiError && err.kind === 'unauthorized') return;
      if (onConfirmError) {
        const line = await onConfirmError(err);
        if (line !== null) setError(line);
      } else if (err instanceof ApiError && err.code === 'rules_changed_since_draft') {
        setError(CHANGED_SINCE);
      } else if (isUncertain(err)) {
        // The answer was lost, so it may have applied: the rules as they stand say whether it did.
        // A caller's own confirm (setup's) applies the draft's version too, so they settle it as well.
        await settleByReading((read) => (!read || mayStillApply(err) ? NOT_CONFIRMED : ownerErrorCopy(err)));
      } else {
        setError(ownerErrorCopy(err));
      }
    } finally {
      setPending(false);
    }
  };

  const finished = done || alreadyApplied;
  // In Ask Claude, a confirm the API answered: its receipt, under Claude's message.
  const receipt = inline && done && confirmed !== null;

  let body;
  if (receipt) {
    body = <RulesReceipt version={confirmed} />;
  } else if (finished) {
    body = <Updated deskId={deskId} />;
  } else if (tools === undefined && rules.isError) {
    body = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={() => void rules.refetch()}>
            Try again
          </Button>
        }
      >
        {ownerErrorCopy(rules.error)}
      </Notice>
    );
  } else if (tools === undefined) {
    body = <LoadingLine>Reading your rules</LoadingLine>;
  } else {
    const { moneyCap } = draft;
    body = (
      <>
        {moneyCap ? <LimitChange now={`New limit: ${moneyCapWords(moneyCap.after)}.`} was={wasWords(moneyCap.before)} /> : null}
        <ChangeReview
          rows={rows}
          sentenceReview
          checks={checkStatus(draft.proof, draft.preset)}
          hasOtherChanges={moneyCap !== null}
          cancelsLinks={cancelsLinksFor(draft)}
          {...(turningOn ? { confirmLabel: 'Confirm and turn on', cancelLabel: 'Back' } : {})}
          {...(cancelLabel === undefined ? {} : { cancelLabel })}
          onConfirm={onConfirm}
          onCancel={() => finish('kept')}
          pending={pending}
          {...(error === undefined ? {} : { error })}
        />
      </>
    );
  }

  const className = `cd-rule-draft${leaving ? ' cd-rule-draft--leaving' : ''}${receipt ? ' cd-rule-draft--confirmed' : ''}`;
  return (
    <div
      className={className}
      onClick={followInAppLinks(navigate)}
      ref={box}
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) settle();
      }}
      // Nothing in the review can be pressed again while it fades out.
      {...(leaving ? { inert: '' } : {})}
    >
      {inline ? null : (
        <div className="cd-rule-draft__header">
          <Breadcrumb items={[root, { label: heading }]} linkComponent={RouterLink} />
          {/* Once the change applied, nothing still says it waits for the owner. */}
          <PageHeader title={heading} {...(finished ? {} : { subtitle: SUBTITLE })} />
        </div>
      )}
      {body}
    </div>
  );
}

/** What a screen hands the review in router state: a draft built from what it has, and its title. */
export interface RuleDraftState {
  draft: RuleDraft;
  title?: string;
  /** Rules opened the review: once confirmed, it goes back to Rules, where the change lands. */
  fromRules?: true;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Router state for this version: a card draft a screen built, or Today's answer with its card diff; else none. */
function handedOver(
  state: unknown,
  version: number,
): { kind: 'built'; draft: RuleDraft; title?: string; fromRules: boolean } | { kind: 'answer'; cardDiff: RuleCard[]; draft: RulesDraft } | null {
  if (!isRecord(state) || !isRecord(state.draft) || state.draft.version !== version) return null;
  const { draft } = state;
  if (Array.isArray(state.cardDiff) && Array.isArray(draft.cards)) {
    return { kind: 'answer', cardDiff: state.cardDiff as RuleCard[], draft: draft as unknown as RulesDraft };
  }
  // A tool's draft shows only where its tools were turned on: a read here couldn't say which.
  if (Array.isArray(draft.before) && Array.isArray(draft.after) && Array.isArray(draft.turnedOn) && draft.turnedOn.length === 0) {
    return {
      kind: 'built',
      draft: draft as unknown as RuleDraft,
      ...(typeof state.title === 'string' ? { title: state.title } : {}),
      fromRules: state.fromRules === true,
    };
  }
  return null;
}

/**
 * `rules/drafts/:version`, for card drafts: the review a screen handed over in router state, or,
 * after a reload, the draft read again by its version and its rows built the same way. A draft whose
 * version is in force says it has applied however the page is opened again (Back and Forward after
 * confirming it, or a new tab), and one older than the rules in force is offered to confirm only once
 * a read finds it still open, so no change is offered to confirm twice. A review Rules opened goes
 * back to Rules once confirmed, and the change lands on the rows it changed there.
 */
export function RuleDraftPage() {
  const { desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const location = useLocation();
  const { version: param = '' } = useParams();
  const version = /^\d{1,9}$/.test(param) ? Number(param) : null;
  const handed = version === null ? null : handedOver(location.state, version);
  // The rules in force say whether the draft has applied; the review reads them as well.
  const rules = useQuery({ ...rulesQuery(deskId), ...READ_ONCE });
  const active = rules.data?.active;
  // A draft stays open until it is confirmed, so only the one whose version is in force is known to
  // have applied. The API reads only open drafts and answers 404 for any other version (in force,
  // replaced since, never checked or never made), so a 404 never says a change applied. A draft
  // older than the rules in force was drafted from rules that changed since, and stays open, or isn't
  // a draft any more. Neither changes again (a draft confirms only from the rules in force), so a
  // read then is final, and kept apart from one made before.
  const inForce = version !== null && active?.version === version;
  const older = version !== null && active !== undefined && active.version > version;
  const read = useQuery({
    queryKey: ['ruleDraft', deskId, version, older],
    queryFn: () => request('ruleDraft', { params: { desk_id: deskId, version: String(version) } }),
    // A handed-over draft is read only to learn whether one older than the rules in force is open.
    enabled: version !== null && (handed === null || older),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const gone = read.error instanceof ApiError && read.error.kind === 'not_found';
  // One older than the rules in force is offered to confirm only once that read finds it still open.
  const confirmable = !older || read.isSuccess;

  const built = useMemo((): { draft: RuleDraft; title?: string } | null => {
    if (handed?.kind === 'built') return handed.title === undefined ? { draft: handed.draft } : { draft: handed.draft, title: handed.title };
    if (active === undefined) return null;
    if (handed?.kind === 'answer') return { draft: draftFromAnswer(active, handed.cardDiff, handed.draft) };
    return read.data === undefined ? null : { draft: draftFromDiff(read.data, active) };
  }, [handed, active, read.data]);

  // Whether a draft that isn't open is in force, only the rules in force can say.
  const notOpen = version === null || (gone && !inForce && (rules.data !== undefined || rules.isError));
  const failed = read.isError && !gone ? read.error : rules.isError ? rules.error : null;
  // A built review names the tab itself. Without one, the tab follows the title this page shows; while
  // the draft is read, the page shows none (a change to the payment limit alone has its own), so the
  // tab names Rules, the page the review is under.
  const shownTitle = inForce || notOpen || failed !== null ? REVIEW_TITLE : RULES_TITLE;
  const showsReview = built !== null && confirmable;
  useDocumentTitle(showsReview ? null : inApp(shownTitle));

  if (showsReview) {
    // Back to Rules as "Keep my rules" goes back: to the entry it came from, else in this one's place.
    const backToRules = (change: ConfirmedChange) => {
      land(deskId, change);
      void (location.key !== 'default' ? navigate(-1) : navigate(rulesPath(deskId), { replace: true }));
      return true;
    };
    return (
      <RuleDraftReview
        key={built.draft.version}
        deskId={deskId}
        draft={built.draft}
        {...(built.title === undefined ? {} : { title: built.title })}
        {...(handed?.kind === 'built' && handed.fromRules ? { onConfirmed: backToRules } : {})}
        alreadyApplied={inForce}
      />
    );
  }

  let body;
  if (inForce) {
    body = <Updated deskId={deskId} />;
  } else if (notOpen) {
    body = (
      <Notice tone="info" action={<TextLink href={rulesPath(deskId)}>Go to Rules</TextLink>}>
        {NOT_OPEN}
      </Notice>
    );
  } else if (failed !== null) {
    body = (
      <Notice
        tone="error"
        action={
          <Button
            variant="secondary"
            onClick={() => {
              if (read.isError) void read.refetch();
              if (rules.isError) void rules.refetch();
            }}
          >
            Try again
          </Button>
        }
      >
        {ownerErrorCopy(failed)}
      </Notice>
    );
  } else {
    // Its title waits for the draft: a change to the payment limit alone has its own.
    return (
      <div className="cd-rule-draft">
        <LoadingLine>Reading the change</LoadingLine>
      </div>
    );
  }
  return (
    <div className="cd-rule-draft" onClick={followInAppLinks(navigate)}>
      <div className="cd-rule-draft__header">
        <Breadcrumb items={[{ label: RULES_TITLE, href: rulesPath(deskId) }, { label: REVIEW_TITLE }]} linkComponent={RouterLink} />
        {/* Once the change applied, nothing still says it waits for the owner. */}
        <PageHeader title={REVIEW_TITLE} {...(inForce ? {} : { subtitle: SUBTITLE })} />
      </div>
      {body}
    </div>
  );
}
