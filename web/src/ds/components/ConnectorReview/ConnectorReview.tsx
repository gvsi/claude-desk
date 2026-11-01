import { BUSINESS_WORDS, type BusinessSetupRow } from '../../../owner/connectors/businessWords.ts';
import type { IconName } from '../../icons/index.tsx';
import { Button } from '../Button/Button.tsx';
import { useSendOnce } from '../Button/useSendOnce.ts';
import { Card } from '../Card/Card.tsx';
import { ConnectorIcon } from '../ConnectorIcon/ConnectorIcon.tsx';
import { ConnectorName, type ConnectorView } from '../ConnectorName/ConnectorName.tsx';
import { Notice } from '../Notice/Notice.tsx';
import { OutcomeMenu } from '../OutcomeMenu/OutcomeMenu.tsx';
import { StatusLabel } from '../StatusDot/StatusDot.tsx';
import { OUTCOME_WORDS, outcomePhrase, type RuleMode } from '../OutcomeMenu/outcomeWords.ts';

import './ConnectorReview.css';

/** One rule that already covers a new tool: the owner's own (its reason, outcome and limit) or an always-on one. */
export interface ReviewCoverage {
  /** The rule's reason, or the always-on rule's line: "No money moves without your rule or a signed limit". */
  text: string;
  mode: RuleMode | 'always_on';
  /** An auto rule's formatted amount limit ("$300"). */
  limit?: string;
}

/** One tool the connector would add, in the screen's words. */
export interface ReviewToolView {
  /** The tool's key on the screen: its `ToolName`. */
  key: string;
  name: string;
  /** What it does and its effects. */
  description: string;
  /** The outcome it starts at: "Ask me first" for every new tool, until the owner changes it. */
  mode: RuleMode;
  /** The rules that already cover it, most specific first. */
  coveredBy: readonly ReviewCoverage[];
}

interface ReviewControls {
  tools: readonly ReviewToolView[];
  /** Makes each tool's outcome a menu; the pick goes to the screen with the tool's key. */
  onChangeOutcome?: (key: string, mode: RuleMode) => void;
  /** Called once per press; the review then waits until `pending` has come and gone or an error is delivered. */
  onTurnOn: () => void;
  onCancel: () => void;
  /** The screen is drafting the change. */
  pending?: boolean;
  /** The screen's message when turning it on, or connecting, failed; its button works again. */
  error?: string;
}

/**
 * An app the screen connects on this same screen (setup's Stripe): `not_connected` before it is,
 * when its tools can't be known yet, so one row says so and the main button is "Connect {name}";
 * `connected` once it is, with the review as ever. Omitted where the app was signed in to first.
 */
export type ReviewConnection = 'not_connected' | 'connected';

export interface ReviewJobView {
  title: string;
  glyph: IconName;
  rows: readonly BusinessSetupRow[];
}

export type ConnectorReviewProps = ReviewControls & (
  | { connector: ConnectorView; intro?: string; job?: never; connection?: ReviewConnection; onConnect?: () => void }
  | { job: ReviewJobView; connector?: never; intro?: never; connection?: never; onConnect?: never }
);

/** A line for each rule that covers a tool, or the line that none does. */
function coverageLines(tool: ReviewToolView): string[] {
  if (tool.coveredBy.length === 0) {
    return [tool.mode === 'ask' ? 'No rule of yours covers this yet, so it starts at Ask me first.' : 'No rule of yours covers this yet.'];
  }
  return tool.coveredBy.map((rule) => {
    if (rule.mode === 'always_on') return `Covered by your always-on rule: ${rule.text}`;
    // An outcome this build doesn't know is left out, never guessed.
    if (!Object.hasOwn(OUTCOME_WORDS, rule.mode)) return `Covered by your rule: ${rule.text}`;
    return `Covered by your rule: ${rule.text} · ${outcomePhrase(rule.mode, rule.limit)}`;
  });
}

/**
 * The review before a connector turns on: each tool it would add, what already covers it, and the
 * outcome it starts at. "Turn it on" asks the screen to draft the change, which shows in
 * `ChangeReview` before anything runs.
 */
export function ConnectorReview({ connector, job, intro, connection, onConnect, tools, onChangeOutcome, onTurnOn, onCancel, pending = false, error }: ConnectorReviewProps) {
  const { waiting, send } = useSendOnce<'turn_on' | 'connect'>(pending, error);
  const failed = error !== undefined && error.trim() !== '';
  const builtIn = connector?.source.kind === 'built_in';
  const app = !job && !builtIn ? connection : undefined;
  const name = connector?.name ?? '';
  let lead: string;
  if (job) lead = BUSINESS_WORDS.lead;
  else if (builtIn) lead = "A built-in connector, so there's nothing to sign in to. Nothing runs until you turn it on.";
  else if (app === 'not_connected') lead = `Connect it first, so Claude Desk can read what ${name} lets Claude do. Nothing runs until you turn it on.`;
  else if (app === 'connected') lead = `Connected to ${name}'s test account. Nothing runs until you turn it on.`;
  else lead = `Nothing runs until you turn it on.${intro?.trim() ? ` ${intro.trim()}` : ''}`;

  return (
    <div className="cd-connector-review" aria-busy={waiting || undefined}>
      <header className="cd-connector-review__header">
        {job ? <ConnectorIcon icon="quotes" glyph={job.glyph} size="page" /> : <ConnectorIcon icon={connector.icon} size="page" />}
        <div className="cd-connector-review__heading">
          <h1 className="cd-connector-review__title cd-type-page-title">
            {job ? job.title : <>Review what Claude could do with <ConnectorName connector={connector} size="inline" /></>}
          </h1>
          <p className="cd-connector-review__lead cd-type-body">{lead}</p>
        </div>
      </header>
      {job ? (
        <Card as="section" label={BUSINESS_WORDS.setup} padding={16}>
          <h2 className="cd-connector-review__setup-title cd-type-control">{BUSINESS_WORDS.setup}</h2>
          <dl className="cd-connector-review__setup">
            {job.rows.filter((row) => row.value.trim() !== '').map((row) => (
              <div key={row.label} className="cd-connector-review__setup-row cd-type-meta">
                <dt>{row.label}</dt>
                <dd>
                  {/* A list value (an intake's questions) takes one numbered line per entry, in its order. */}
                  {row.items && row.items.length > 0 ? (
                    <ol className="cd-connector-review__setup-list">
                      {row.items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
                    </ol>
                  ) : row.value}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}
      <Card as="section" label="Tools" padding={16}>
        <ul role="list" className="cd-connector-review__tools">
          {/* Before the app is connected its tools can't be known: one row says so, and when they'll show. */}
          {app === 'not_connected' ? (
            <li className="cd-connector-review__tool cd-connector-review__tool--placeholder">
              <div className="cd-connector-review__layout">
                <div className="cd-connector-review__text">
                  <p className="cd-connector-review__name cd-type-body">{`${name}’s tools`}</p>
                  <p className="cd-connector-review__description cd-type-meta">
                    {`They show here once ${name} is connected, each with the rule it starts at.`}
                  </p>
                </div>
                <span className="cd-connector-review__status cd-type-meta">
                  <StatusLabel tone="held">Not connected</StatusLabel>
                </span>
              </div>
            </li>
          ) : tools.map((tool) => (
            <li key={tool.key} className="cd-connector-review__tool">
              <div className="cd-connector-review__layout">
                <div className="cd-connector-review__text">
                  <p className="cd-connector-review__name cd-type-body">{tool.name}</p>
                  <p className="cd-connector-review__description cd-type-meta">{tool.description}</p>
                  {coverageLines(tool).map((line, index) => (
                    <p key={`${index}-${line}`} className="cd-connector-review__covered cd-type-meta">
                      {line}
                    </p>
                  ))}
                </div>
                <OutcomeMenu
                  label={tool.name}
                  value={tool.mode}
                  onChange={onChangeOutcome ? (mode) => onChangeOutcome(tool.key, mode) : undefined}
                  disabled={waiting}
                />
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <div className="cd-connector-review__controls">
        <div className="cd-connector-review__buttons">
          {app === 'not_connected' ? (
            <Button variant="primary" size="main" busy={waiting} onClick={() => send('connect', () => onConnect?.())}>
              {`Connect ${name}`}
            </Button>
          ) : (
            <Button variant="primary" size="main" busy={waiting} onClick={() => send('turn_on', () => onTurnOn())}>
              Turn it on
            </Button>
          )}
          <Button variant="secondary" size="main" waiting={waiting} onClick={() => onCancel()}>
            Cancel
          </Button>
        </div>
        <p className="cd-connector-review__hint cd-type-meta">
          {app === 'not_connected'
            ? `${name} asks you to sign in. Then you review its tools here.`
            : "You'll see the change to your rules before anything runs."}
        </p>
      </div>
      {failed && !waiting ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
