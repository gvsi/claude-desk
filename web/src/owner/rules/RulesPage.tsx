import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

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
  LoadingLine,
  MoneyLimit,
  Notice,
  PRESET_WORDS,
  PageHeader,
  PresetMenu,
  SuggestionChips,
  TextLink,
  type NoticeTone,
  type RulesLinkProps,
} from '../../ds/index.ts';
import { followInAppLinks } from '../inAppLinks.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { useReadFailure } from '../useReadFailure.ts';
import { useAskClaude } from './askClaude.tsx';
import { capOf, draftFromDiff, type RuleDraft } from './drafts.ts';
import { hubSections, parseLimit } from './hub.ts';
import { draftFailure } from './RuleChat.tsx';
import { peopleQuery, rulesQuery, type RuleDraftState } from './RuleDraftReview.tsx';
import { moneyLimitHint, moneyLimitLine } from './ruleWords.ts';

import './RulesPage.css';

/** What the owner can ask Claude for on Rules, in her words (the presets board's, with the owner's later words). */
const RULES_CHIPS = ['Stop quoting on weekends', 'Quote water heater installs up to $600', "Why was Dana's refund held?"] as const;

const COMPOSER_LABEL = 'Ask Claude to change a rule';
const COMPOSER_HELPER = 'Claude shows you the change and example situations before anything applies.';

/** Plan 02's limit on the owner's words. */
const WORDS_MAX = 2000;

/** The payment limit's field, when the API says the amount is above the platform's ceiling. */
const ABOVE_CEILING = 'No single payment can be above $10,000.';

const deskPath = (deskId: string) => `/app/${encodeURIComponent(deskId)}`;
const draftPath = (deskId: string, version: number) => `${deskPath(deskId)}/rules/drafts/${version}`;

/** A section's or tool's link through the router, so the app stays loaded. */
function RouterLink({ href, children, ...rest }: RulesLinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

/** The Desk's suggested rules, read with the rules. */
function suggestionsQuery(deskId: string) {
  return { queryKey: ['suggestions', deskId], queryFn: () => request('suggestions', { params: { desk_id: deskId } }) } as const;
}

/** A line on what went wrong, with its tone. */
interface Said {
  tone: NoticeTone;
  line: string;
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
 * connector, each group and tool linking to its page under Connectors; Ask Claude under the
 * header; "Start from a preset", which drafts a preset as one change; the payment limit atop
 * Payments and Stripe; the always-on rules. Every change opens its proved review first.
 */
export function RulesPage() {
  const { desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const navigate = useNavigate();
  const { ask } = useAskClaude();
  const rules = useQuery({ ...rulesQuery(deskId), refetchInterval: pollMs('rules') });
  const people = useQuery(peopleQuery(deskId));
  const suggestions = useQuery({ ...suggestionsQuery(deskId), refetchInterval: pollMs('rules') });
  const failure = useReadFailure(rules);
  const [presetPending, setPresetPending] = useState(false);
  const [presetSaid, setPresetSaid] = useState<Said | null>(null);
  const [limit, setLimit] = useState<LimitField | null>(null);

  const active = rules.data?.active;

  /** Opens a card draft's review, with what it was drafted from. */
  const review = (draft: RulesDraft, from: PolicyVersionOut, extra: { preset?: RulesPreset; title?: string } = {}) => {
    const built: RuleDraft = draftFromDiff(draft, from, extra.preset);
    const state: RuleDraftState = extra.title === undefined ? { draft: built } : { draft: built, title: extra.title };
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

  let body;
  if (rules.data === undefined && rules.isError) {
    body = (
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
  } else if (rules.data === undefined || active === undefined) {
    body = <LoadingLine>Reading your rules</LoadingLine>;
  } else {
    const cap = capOf(active);
    const sections = hubSections(rules.data, people.data ?? null);
    body = (
      <>
        {failure === null ? null : (
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
        )}
        <ConnectorList summary={`Version ${active.version} of your rules, checked against the always-on rules`}>
          {sections.map((section) => {
            const editing = limit !== null && limit.group === section.connector.id ? limit : null;
            return (
              <ConnectorSection
                key={section.connector.id}
                connector={section.connector}
                href={`${deskPath(deskId)}/${section.href}`}
                tools={section.tools.map((tool) => ({ ...tool, href: `${deskPath(deskId)}/${tool.href}` }))}
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
    <div className="cd-rules" onClick={followInAppLinks(navigate)}>
      <div className="cd-rules__header">
        <PageHeader
          title="Rules"
          subtitle="What Claude can do on this Desk, where each tool comes from, and your rules for it."
          actions={<PresetMenu onPick={(preset) => void pickPreset(preset)} pending={presetPending} />}
          actionsBelowOnPhone
          hideSubtitleOnPhone
        />
      </div>
      {presetSaid === null ? null : <Notice tone={presetSaid.tone}>{presetSaid.line}</Notice>}
      <div className="cd-rules__ask">
        <Composer variant="owner" label={COMPOSER_LABEL} placeholder={COMPOSER_LABEL} helper={COMPOSER_HELPER} maxLength={WORDS_MAX} onSend={ask} />
        <SuggestionChips label="Suggestions" suggestions={RULES_CHIPS} onPick={ask} />
      </div>
      {active === undefined ? null : <SuggestedRules deskId={deskId} suggestions={suggestions.data ?? []} onDrafted={(draft) => review(draft, active)} />}
      {body}
      <AlwaysOnList />
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
