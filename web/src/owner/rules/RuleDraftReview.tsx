import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';

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
  OUTCOME_GROUP_WORDS,
  PageHeader,
  TextLink,
  ruleDiff,
  type RulesLinkProps,
} from '../../ds/index.ts';
import { formatCents } from '../../lib/format.ts';
import { connectorPageHref } from '../connectors/pages.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { cancelsLinksFor, changeRows } from './changeRows.ts';
import { checkStatus } from './checkStatus.ts';
import { draftFromAnswer, draftFromDiff, type RuleDraft } from './drafts.ts';
import { moneyCapWords } from './ruleWords.ts';

import './RuleDraftReview.css';

/** The Desk's rules: the active version and every tool row. */
export function rulesQuery(deskId: string) {
  return queryOptions({ queryKey: ['rules', deskId], queryFn: () => request('rules', { params: { desk_id: deskId } }) });
}

/** The business's people and leads, which name a person's rule. */
export function peopleQuery(deskId: string) {
  return queryOptions({ queryKey: ['people', deskId], queryFn: () => request('people', { params: { desk_id: deskId } }) });
}

/** A read the review makes once and keeps while it is open: a later read would change nothing it shows. */
const READ_ONCE = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

const SUBTITLE = "Here's exactly what changes on your Desk. Nothing changes until you confirm.";
const UPDATED = 'Your rules are updated.';
const CHANGED_SINCE = 'Your rules changed since this was drafted. Ask for the change again.';
const NOT_CONFIRMED = "We couldn't confirm whether your change went through. Open Rules to see where it stands.";
const NOT_OPEN = "This draft isn't open anymore. Ask for the change again from Rules.";

const rulesPath = (deskId: string) => `/app/${encodeURIComponent(deskId)}/rules`;

/** The breadcrumb's link through the router, so the app stays loaded. */
function RouterLink({ href, children, ...rest }: RulesLinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

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
}

/**
 * A rules draft before it applies: the payment limit's change in words, the draft's summary when it
 * has nothing to compare with, then `ChangeReview` with a row per change and the check in plain
 * words. Only a draft whose check passed can be confirmed, and nothing changes until it is.
 */
export function RuleDraftReview({ deskId, draft, title, inline = false, onDone, confirm, cancelLabel, onConfirmError }: RuleDraftReviewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const people = useQuery({ ...peopleQuery(deskId), ...READ_ONCE });
  const rules = useQuery({ ...rulesQuery(deskId), ...READ_ONCE });
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // The tool rows give each tool's effects, which say which shared rules govern it.
  const tools = rules.data?.tools;
  const rows = useMemo(() => changeRows(draft, people.data ?? null, tools ?? []), [draft, people.data, tools]);
  const turningOn = draft.turnedOn.length > 0;
  const heading = title ?? (onlyTheLimit(draft) ? 'Change your payment limit' : 'Review the change');
  // Where the trail starts, and where keeping the rules goes when there is nothing to go back to: a
  // turn-on's Connectors page once those pages are built (`connectorPageHref`), else Rules.
  const connectors = turningOn ? connectorPageHref(deskId, 'connectors') : undefined;
  const root = connectors === undefined ? { label: 'Rules', href: rulesPath(deskId) } : { label: 'Connectors', href: connectors };

  const finish = (outcome: 'confirmed' | 'kept') => {
    if (onDone) onDone(outcome);
    else if (outcome === 'kept') void (location.key !== 'default' ? navigate(-1) : navigate(root.href));
  };

  const applied = () => {
    void queryClient.invalidateQueries({ queryKey: ['rules', deskId] });
    setDone(true);
    finish('confirmed');
  };

  const onConfirm = async () => {
    setError(undefined);
    setPending(true);
    try {
      if (confirm) await confirm();
      else await request('confirmRules', { params: { desk_id: deskId }, body: { version: draft.version } });
      applied();
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
        const now = await queryClient.fetchQuery({ ...rulesQuery(deskId), staleTime: 0 }).catch(() => null);
        if (now?.active.version === draft.version) applied();
        else setError(now === null || mayStillApply(err) ? NOT_CONFIRMED : ownerErrorCopy(err));
      } else {
        setError(ownerErrorCopy(err));
      }
    } finally {
      setPending(false);
    }
  };

  let body;
  if (done) {
    body = (
      <Notice tone="info" action={<TextLink href={rulesPath(deskId)}>See your rules</TextLink>}>
        {UPDATED}
      </Notice>
    );
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
    const { moneyCap, summary } = draft;
    const summaryLines = summary
      ? (
          [
            [OUTCOME_GROUP_WORDS.auto, summary.on_its_own],
            [OUTCOME_GROUP_WORDS.ask, summary.asks_you],
            [OUTCOME_GROUP_WORDS.never, summary.never],
          ] as const
        ).filter(([, reasons]) => reasons.length > 0)
      : [];
    body = (
      <>
        {moneyCap ? <LimitChange now={`New limit: ${moneyCapWords(moneyCap.after)}.`} was={wasWords(moneyCap.before)} /> : null}
        {summaryLines.length > 0 ? (
          <div className="cd-rule-draft__summary">
            {summaryLines.map(([label, reasons]) => (
              <p key={label} className="cd-type-summary">
                {label}: {reasons.join(' ')}
              </p>
            ))}
          </div>
        ) : null}
        <ChangeReview
          rows={rows}
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

  return (
    <div className="cd-rule-draft" onClick={followInAppLinks(navigate)}>
      {inline ? null : (
        <div className="cd-rule-draft__header">
          <Breadcrumb items={[root, { label: heading }]} linkComponent={RouterLink} />
          {/* Once the change applied, nothing still says it waits for the owner. */}
          <PageHeader title={heading} {...(done ? {} : { subtitle: SUBTITLE })} />
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
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Router state for this version: a card draft a screen built, or Today's answer with its card diff; else none. */
function handedOver(state: unknown, version: number): { kind: 'built'; draft: RuleDraft; title?: string } | { kind: 'answer'; cardDiff: RuleCard[]; draft: RulesDraft } | null {
  if (!isRecord(state) || !isRecord(state.draft) || state.draft.version !== version) return null;
  const { draft } = state;
  if (Array.isArray(state.cardDiff) && Array.isArray(draft.cards)) {
    return { kind: 'answer', cardDiff: state.cardDiff as RuleCard[], draft: draft as unknown as RulesDraft };
  }
  // A tool's draft shows only where its tools were turned on: a read here couldn't say which.
  if (Array.isArray(draft.before) && Array.isArray(draft.after) && Array.isArray(draft.turnedOn) && draft.turnedOn.length === 0) {
    return { kind: 'built', draft: draft as unknown as RuleDraft, ...(typeof state.title === 'string' ? { title: state.title } : {}) };
  }
  return null;
}

/**
 * `rules/drafts/:version`, for card drafts: the review a screen handed over in router state, or,
 * after a reload, the draft read again by its version and its rows built the same way.
 */
export function RuleDraftPage() {
  const { desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const location = useLocation();
  const { version: param = '' } = useParams();
  const version = /^\d{1,9}$/.test(param) ? Number(param) : null;
  const handed = version === null ? null : handedOver(location.state, version);
  const rules = useQuery({ ...rulesQuery(deskId), ...READ_ONCE, enabled: handed?.kind !== 'built' });
  const read = useQuery({
    queryKey: ['ruleDraft', deskId, version],
    queryFn: () => request('ruleDraft', { params: { desk_id: deskId, version: String(version) } }),
    enabled: version !== null && handed === null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const active = rules.data?.active;
  const built = useMemo((): { draft: RuleDraft; title?: string } | null => {
    if (handed?.kind === 'built') return handed.title === undefined ? { draft: handed.draft } : { draft: handed.draft, title: handed.title };
    if (active === undefined) return null;
    if (handed?.kind === 'answer') return { draft: draftFromAnswer(active, handed.cardDiff, handed.draft) };
    return read.data === undefined ? null : { draft: draftFromDiff(read.data, active) };
  }, [handed, active, read.data]);

  if (built !== null) return <RuleDraftReview key={built.draft.version} deskId={deskId} draft={built.draft} {...(built.title === undefined ? {} : { title: built.title })} />;

  const notOpen = version === null || (read.error instanceof ApiError && read.error.kind === 'not_found');
  const failed = read.isError ? read.error : rules.isError ? rules.error : null;
  let body;
  if (notOpen) {
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
        <Breadcrumb items={[{ label: 'Rules', href: rulesPath(deskId) }, { label: 'Review the change' }]} linkComponent={RouterLink} />
        <PageHeader title="Review the change" subtitle={SUBTITLE} />
      </div>
      {body}
    </div>
  );
}
