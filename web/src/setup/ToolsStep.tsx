import { useQuery } from '@tanstack/react-query';
import { useLayoutEffect, useRef } from 'react';

import type { RuleCard } from '../api/contracts.ts';
import { ownerErrorCopy, request } from '../api/http.ts';
import type { BusinessToolDef, SetupMessage, SetupState, ToolRow } from '../api/views.ts';
import {
  Button,
  ConnectorReview,
  EmptyState,
  LoadingLine,
  Notice,
  PageHeader,
  SetupToolsList,
  SkeletonScreen,
  describeEffects,
  rulesForTool,
  type ReviewToolView,
  type RuleMode,
  type SetupToolsRow,
  type SetupJobRow,
} from '../ds/index.ts';
import { CONNECTORS, TOOL_NAMES, businessTools, connectorByKey, connectorOn, isBusinessToolName, isCatalogTool, toolDisplayName, toolState, type CatalogConnector, type ConnectorKey } from '../owner/connectors/catalog.ts';
import { businessGlyph, businessLine, businessOwnerLine, businessRows, isBusinessDef } from '../owner/connectors/businessWords.ts';
import { toolOutcome } from '../owner/rules/outcome.ts';
import { RuleDraftReview, rulesQuery } from '../owner/rules/RuleDraftReview.tsx';
import { MOCK_PAYMENTS, useConnectorFlow } from './connectorFlow.ts';
import { SETUP_COPY } from './copy.ts';
import { aroundBusiness, useOpensAtTop } from './shared.ts';
import { ToolsListSkeleton } from './StepSkeletons.tsx';

const copy = SETUP_COPY.tools;

export interface ToolsStepProps {
  state: SetupState;
  /** The business's name, once known. */
  business: string;
  /** "Continue": on to the rules. */
  onContinue: () => void;
}

/**
 * The connector's tools the owner can turn on here: those it lists that aren't on, at the hash each
 * was listed at. A tool whose definition changed waits for its own review on its page, so it is left out.
 */
function toolsToTurnOn(connector: CatalogConnector, rows: readonly ToolRow[]): ToolRow[] {
  return rows.filter((row) => {
    if (!isCatalogTool(row.tool) || !connector.tools.includes(row.tool) || row.definition_sha256 === null) return false;
    const state = toolState(row);
    return state === 'not_on' || state === 'off';
  });
}

/**
 * The outcome a tool starts at: the one Rules shows for the same rules once it is on, and the
 * change review's turned-on row reads (`toolOutcome`: the most that runs on its own for some
 * visitor), else Ask me first.
 */
function startingMode(row: ToolRow, cards: readonly RuleCard[]): RuleMode {
  return toolOutcome({ tool: row.tool, effects: row.effects }, cards).mode;
}

/** A tool as its review shows it: its name, what it does and touches, its outcome and the rules of yours that cover it. */
export function reviewTool(row: ToolRow, cards: readonly RuleCard[]): ReviewToolView {
  const business = businessTools([row]);
  const name = toolDisplayName(row.tool, business) ?? 'A connected tool';
  const line = row.source === 'business'
    ? businessOwnerLine(row.business?.config) : (isCatalogTool(row.tool) ? TOOL_NAMES[row.tool].line : name);
  const covering = rulesForTool({ tool: row.tool, effects: row.effects }, cards).filter((card) => card.is_default !== true);
  return {
    key: row.tool,
    name,
    description: [line, describeEffects(row.effects, row.reversible)].filter(Boolean).join(' '),
    mode: startingMode(row, cards),
    coveredBy: covering.map((card) => ({ text: card.reason, mode: card.mode })),
  };
}

/** Whether two values from the API hold the same data, whatever order an object's keys come in. */
function sameData(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameData(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const one = a as Record<string, unknown>;
    const other = b as Record<string, unknown>;
    const keys = Object.keys(one);
    return keys.length === Object.keys(other).length && keys.every((key) => Object.hasOwn(other, key) && sameData(one[key], other[key]));
  }
  return a === b;
}

/**
 * The owner's own accepted choice for one of the Desk's own jobs, read from setup's conversation:
 * the `autonomy` of the card the job was made from (setup publishes each accepted job's title and
 * setup as its definition, so it is the card with both), when the owner accepted it themselves
 * (`owner_decided`, as Rules drafting counts it). Null when no such card matches, or two that match
 * disagree: a card "Use your suggestions" accepted for them was never their choice. It changes only
 * words on the review: the job's own rule comes from the card the owner confirms at the Rules step.
 */
export function acceptedAutonomy(def: BusinessToolDef, messages: readonly SetupMessage[]): 'auto' | 'ask' | null {
  const choices = new Set(messages.flatMap(({ card, owner_decided: decided }) =>
    decided === true && card?.state === 'accepted' && card.job?.config && card.job.title === def.title && sameData(card.job.config, def.config)
      ? [card.job.autonomy] : []));
  return choices.size === 1 ? [...choices][0] ?? null : null;
}

/** Setup supports new jobs at their listed hash; changed, delisted and turned-off jobs stay out. */
function isSetupJob(row: ToolRow): row is ToolRow & { tool: `desk.${string}`; business: BusinessToolDef } {
  return row !== null && typeof row === 'object' && row.source === 'business' && typeof row.tool === 'string' && isBusinessToolName(row.tool)
    && isBusinessDef(row.business) && (toolState(row) === 'on' || toolState(row) === 'not_on')
    && typeof row.description_confirmed === 'string' && row.description_confirmed.trim() !== ''
    && typeof row.definition_sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.definition_sha256)
    && typeof row.reversible === 'boolean' && Array.isArray(row.effects)
    && row.effects.every((effect) => ['read', 'private_data', 'change', 'charge', 'pay_out', 'send_message'].includes(effect));
}

/**
 * The new Desk's connectors as the design system's setup tools list draws them (N-R2-Setup-05),
 * each row read through `toolState`: Verification "Always on"; a connector with a tool on, or
 * changed, "On"; one whose listed tools are none of them on, "Add" (built in) or, for an app
 * already connected (Stripe once the setup chat or this step has connected it, so it can't be
 * connected again), its tool count, "Needs review" and "Review" (N-Live-REV-560); Stripe while it
 * can still be connected, its tool count and "Connect". Both of Stripe's buttons open the same
 * review. A built-in connector with no tools listed, and Google Calendar, which has none, aren't shown.
 */
function setupRows(rows: readonly ToolRow[], connectable: boolean, onChoose: (key: ConnectorKey) => void) {
  const builtIn: SetupToolsRow[] = [];
  const external: SetupToolsRow[] = [];
  for (const connector of CONNECTORS) {
    const outside = connector.view.source.kind === 'external';
    const listed = rows.some((row) => isCatalogTool(row.tool) && connector.tools.includes(row.tool));
    const canConnect = connector.key === MOCK_PAYMENTS && connectable;
    let row: SetupToolsRow | null = null;
    if (connector.key === 'verification' && listed) row = { connector: connector.view, state: 'always_on' };
    else if (connectorOn(connector, rows)) row = { connector: connector.view, state: 'on' };
    else if (outside && listed && !canConnect) {
      row = { connector: connector.view, state: 'needs_review', tools: connector.tools.length, onReview: () => onChoose(connector.key) };
    } else if (listed || canConnect) {
      row = { connector: connector.view, state: 'off', onChoose: () => onChoose(connector.key), ...(outside ? { tools: connector.tools.length } : {}) };
    }
    if (row !== null) (outside ? external : builtIn).push(row);
  }
  return { builtIn, external };
}

/**
 * "What Claude can use": the new Desk's connectors from `setupTools`, grouped by the catalog. A
 * built-in connector that isn't on, or the mock payments server (not connected yet, and then
 * connected on the same screen, or already connected and waiting for review), opens its review
 * (`ConnectorReview`); "Turn it
 * on" sends one `confirmTool` for its tools, each at the hash it was listed at, and its draft shows
 * inline; "Confirm and turn on" confirms it, and only then, read again, do the tools read "On".
 * "Continue" goes on to the rules. The calls behind each press, in their order, are
 * `useConnectorFlow`'s (`connectorFlow.ts`).
 */
export function ToolsStep({ state, business, onContinue }: ToolsStepProps) {
  const id = state.interview_id;
  const deskId = state.desk_id;
  const tools = useQuery({ queryKey: ['setupTools', id] as const, queryFn: () => request('setupTools', { params: { id } }), refetchOnWindowFocus: false });
  const rules = useQuery({ ...rulesQuery(deskId), refetchOnWindowFocus: false });
  const flow = useConnectorFlow({ interviewId: id, deskId, tools: tools.data });
  const { view, connecting, listError, turningOn, reviewError } = flow;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const returnTo = useRef<string | null>(null);
  const focusRow = useRef(false);
  const reviewReady = rules.data !== undefined && tools.data !== undefined;
  const viewKey = view.kind === 'confirm' ? `confirm:${view.draft.version}` : view.kind;
  useOpensAtTop(viewKey);
  // View swaps announce their heading. Back and Cancel return to the opener; a confirm returns
  // to its row immediately, so focus survives the refresh replacing its button with "On".
  useLayoutEffect(() => {
    if (viewKey !== 'list') {
      titleRef.current?.focus({ preventScroll: true });
      return;
    }
    if (returnTo.current === null) return;
    const row = rowRefs.current.get(returnTo.current);
    if (row === undefined) return;
    returnTo.current = null;
    const button = focusRow.current ? null : row.querySelector<HTMLButtonElement>('button:not(:disabled)');
    focusRow.current = false;
    if (button) button.focus({ preventScroll: true });
    else {
      row.setAttribute('tabindex', '-1');
      row.addEventListener('blur', () => row.removeAttribute('tabindex'), { once: true });
      row.focus({ preventScroll: true });
    }
    row.scrollIntoView({ block: 'nearest' });
  }, [viewKey, reviewReady]);
  const open = (key: Parameters<typeof flow.open>[0]) => {
    returnTo.current = key;
    flow.open(key);
  };

  const rows = (tools.data?.tools ?? []).filter((row) =>
    row !== null && typeof row === 'object' && typeof row.tool === 'string' && (row.source !== 'business' || isSetupJob(row)),
  );
  const jobs = rows.filter(isSetupJob);

  if (view.kind === 'confirm') {
    const connector = connectorByKey(view.key);
    const name = toolDisplayName(view.key, businessTools(view.rows)) ?? connector?.view.name ?? 'A connected tool';
    // The change applies with `confirmRules`; when the rules changed since it was drafted, the
    // tools are asked for once more, and the new draft is shown to confirm (`confirmChange`).
    return (
      <div className="cd-setup-step">
        <PageHeader titleRef={titleRef} title={copy.turnOnTitle(name)} subtitle={copy.turnOnSubtitle} />
        {view.changed ? <Notice tone="info">{copy.changedSince}</Notice> : null}
        <RuleDraftReview
          key={view.draft.version}
          deskId={deskId}
          draft={view.draft}
          inline
          confirm={flow.confirm}
          onDone={(outcome) => {
            focusRow.current = outcome === 'confirmed';
            void flow.backToList();
          }}
        />
      </div>
    );
  }

  if (view.kind === 'review') {
    const connector = connectorByKey(view.key);
    const cards = rules.data?.active.cards;
    if (cards === undefined || tools.data === undefined) {
      const failed = rules.isError ? rules.error : tools.isError ? tools.error : null;
      return failed === null ? (
        <LoadingLine>{copy.loading}</LoadingLine>
      ) : (
        <Notice
          tone="error"
          action={
            <Button variant="secondary" onClick={() => void (rules.isError ? rules.refetch() : tools.refetch())}>
              {SETUP_COPY.questions.tryAgain}
            </Button>
          }
        >
          {ownerErrorCopy(failed)}
        </Notice>
      );
    }
    const job = jobs.find((row) => row.tool === view.key);
    if (job) {
      const tool = reviewTool(job, cards);
      const glyph = businessGlyph(job.business.config);
      if (glyph === null) return null;
      // The owner chose to let the job run on its own, but its own rule comes from the card they
      // confirm at the Rules step: until then it asks first, and the review says so. Words only.
      // Only a booking card shows the owner that choice, so only a booking job (the typed_booking
      // block, made only from schedule cards) says they made it.
      const booking = job.business.config.block === 'typed_booking';
      const chosenOnItsOwn = booking && tool.mode === 'ask' && acceptedAutonomy(job.business, state.messages) === 'auto';
      const shown = chosenOnItsOwn ? { ...tool, uncoveredLine: copy.chosenOnItsOwn } : tool;
      return (
        <ConnectorReview
          titleRef={titleRef}
          job={{ title: tool.name, glyph, rows: businessRows(job.business, tool.mode) }}
          tools={[shown]}
          onTurnOn={() => void flow.turnOn(view.key, [job])}
          onCancel={flow.cancel}
          pending={turningOn}
          {...(reviewError === undefined ? {} : { error: reviewError })}
        />
      );
    }
    if (connector === null) return null;
    const turnedOn = toolsToTurnOn(connector, rows);
    // An app is connected on this same screen: until it is, its tools can't be known, and "Connect
    // Stripe" connects it here; then its tools show for review, with "Turn it on".
    const app = connector.view.source.kind === 'external';
    return (
      <ConnectorReview
        titleRef={titleRef}
        connector={connector.view}
        {...(app ? { connection: flow.mustConnect ? 'not_connected' : 'connected', onConnect: () => void flow.connect() } as const : {})}
        tools={turnedOn.map((row) => reviewTool(row, cards))}
        onTurnOn={() => void flow.turnOn(view.key, turnedOn)}
        onCancel={flow.cancel}
        pending={turningOn || connecting}
        {...(reviewError === undefined ? {} : { error: reviewError })}
      />
    );
  }

  let list;
  if (tools.data === undefined) {
    list = tools.isError ? (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={() => void tools.refetch()}>
            {SETUP_COPY.questions.tryAgain}
          </Button>
        }
      >
        {ownerErrorCopy(tools.error)}
      </Notice>
    ) : null;
  } else if (rows.length === 0 && tools.data.connectable.length === 0) {
    list = <EmptyState title={copy.empty} body={copy.emptyBody} />;
  } else {
    const jobRows: SetupJobRow[] = jobs.flatMap((row) => {
      const line = businessLine(row.business);
      const glyph = businessGlyph(row.business.config);
      if (line === null || glyph === null) return [];
      const title = toolDisplayName(row.tool, businessTools([row])) ?? 'A connected tool';
      const job = { key: row.tool, title, line, glyph };
      return [toolState(row) === 'on' ? { ...job, state: 'on' } : {
        ...job, state: 'needs_review', onReview: () => open(row.tool),
      }];
    });
    list = (
      <SetupToolsList
        rowRef={(key, row) => {
          if (row) rowRefs.current.set(key, row);
          else rowRefs.current.delete(key);
        }}
        jobs={jobRows}
        {...setupRows(rows, tools.data.connectable.includes('mock_payments'), (key) => {
          returnTo.current = key;
          flow.choose(key);
        })}
      />
    );
  }

  return (
    <div className="cd-setup-step">
      <PageHeader title={copy.title} subtitle={aroundBusiness(copy.subtitle, business)} />
      {/* While the tools are read, the list draws as its shapes; "Continue" stays real under it. */}
      <SkeletonScreen loading={tools.data === undefined && !tools.isError} status={copy.loading} skeleton={<ToolsListSkeleton />} className="cd-setup-step__region">
        {list}
      </SkeletonScreen>
      {listError === null ? null : <Notice tone="error">{listError}</Notice>}
      <div className="cd-setup-step__actions">
        <Button variant="primary" size="main" onClick={onContinue}>
          {copy.continue}
        </Button>
      </div>
    </div>
  );
}
