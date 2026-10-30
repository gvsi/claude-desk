/**
 * `/d/:slug/agents`: the page for people's AI agents. It reads the public Desk (the kernel's names,
 * brand and Agent Card blocks) and the API's code-built Agent Card (the address agents send to, how
 * a request is signed, an example request), and shows them as written, in the browser's language,
 * under the business's brand header and the AI disclosure, with a demo key for connecting your own
 * agent (`ConnectYourOwn`) and the built-in agent sent on a task (`SendAgentPanel`). No model text is shown here but the Desk's checked
 * replies to the built-in agent; the agent's own words never are.
 */
import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router';

import type { PublicDesk } from '../../api/contracts.ts';
import { ApiError, request } from '../../api/http.ts';
import type { AgentCardOut } from '../../api/views.ts';
import {
  Button,
  ConceptFooter,
  DisclosureLine,
  EmptyState,
  LoadingLine,
  Notice,
  PageHeader,
  PublicBrandHeader,
  TextLink,
  UNREACHABLE_COPY,
  type CopyLanguage,
} from '../../ds/index.ts';
import { browserLanguage } from '../../lib/language.ts';
import { brandFrom } from '../brand.ts';
import { PUBLIC_COPY } from '../copy.ts';
import { useAgentSession } from './agentSession.ts';
import { AgentsCard } from './AgentsCard.tsx';
import { ConnectYourOwn } from './ConnectYourOwn.tsx';
import { AGENTS_COPY } from './copy.ts';
import { SEND_ID, SendAgentPanel } from './SendAgentPanel.tsx';

import './AgentCardPage.css';

type Load = { kind: 'loading' } | { kind: 'not_found' } | { kind: 'unavailable' } | { kind: 'ready'; desk: PublicDesk; card: AgentCardOut };

export function AgentCardPage() {
  const { slug = '' } = useParams();
  const [language] = useState(browserLanguage);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const read = useCallback(async (): Promise<Load> => {
    try {
      const [desk, card] = await Promise.all([
        request('publicDesk', { params: { slug }, query: { lang: language } }),
        request('agentCard', { params: { slug } }),
      ]);
      return { kind: 'ready', desk, card };
    } catch (err) {
      return { kind: err instanceof ApiError && err.kind === 'not_found' ? 'not_found' : 'unavailable' };
    }
  }, [slug, language]);

  useEffect(() => {
    let live = true;
    setLoad({ kind: 'loading' });
    void read().then((next) => {
      if (live) setLoad(next);
    });
    return () => {
      live = false;
    };
  }, [read]);

  const retry = () => {
    setLoad({ kind: 'loading' });
    void read().then(setLoad);
  };

  if (load.kind !== 'ready') return <AgentsState load={load} language={language} onRetry={retry} />;
  return <AgentsPage slug={slug} desk={load.desk} card={load.card} language={language} />;
}

interface AgentsPageProps {
  slug: string;
  desk: PublicDesk;
  card: AgentCardOut;
  language: CopyLanguage;
}

function AgentsPage({ slug, desk, card, language }: AgentsPageProps) {
  const copy = AGENTS_COPY[language];
  const { brand } = brandFrom(desk);
  const business = desk.business_name;
  const skills = desk.agent_card.filter((block) => block.text.trim() !== '');
  const { hash } = useLocation();
  // One session for both actions, so a key and a run opened together belong to the same chat.
  const session = useAgentSession(slug);

  // The public page's "Send an agent" link lands on the panel once the page has drawn it.
  useLayoutEffect(() => {
    if (hash === `#${SEND_ID}`) document.getElementById(SEND_ID)?.scrollIntoView();
  }, [hash]);

  return (
    <div className="cd-agents-page" lang={language}>
      <PublicBrandHeader brand={brand} language={language} nameAsHeading={false} />
      <main className="cd-agents-page__main">
        <p className="cd-agents-page__back cd-type-body">
          <TextLink href={`/d/${encodeURIComponent(slug)}`}>{copy.backToChat}</TextLink>
        </p>
        <div className="cd-agents-page__head">
          <PageHeader
            title={
              <>
                <span data-copy="user">{business}</span> {copy.forAgents}
              </>
            }
          />
          <DisclosureLine language={language} businessName={business} />
        </div>
        <div className="cd-agents-page__cards">
          <AgentsCard title={copy.canDoTitle}>
            {skills.length > 0 ? (
              <ul className="cd-agents-page__list cd-type-body">
                {/* The kernel's Agent Card, each block's words as written. */}
                {skills.map((block, index) => (
                  <li key={index}>{block.text}</li>
                ))}
              </ul>
            ) : (
              <p className="cd-agents-page__quiet cd-type-meta">{copy.canDoEmpty}</p>
            )}
          </AgentsCard>
          <AgentsCard title={copy.proveTitle}>
            <ul className="cd-agents-page__list cd-type-meta">
              {copy.proveLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </AgentsCard>
          <ConnectYourOwn slug={slug} card={card} session={session} language={language} />
          <SendAgentPanel slug={slug} business={business} ownerName={desk.owner_display_name} session={session} language={language} />
        </div>
        <ConceptFooter />
      </main>
    </div>
  );
}

/** The page before the Desk shows: opening, a Desk that isn't there, or one that couldn't be read. */
function AgentsState({ load, language, onRetry }: { load: Exclude<Load, { kind: 'ready' }>; language: CopyLanguage; onRetry: () => void }) {
  const copy = AGENTS_COPY[language];
  const page = PUBLIC_COPY[language];
  let body: ReactNode;
  if (load.kind === 'not_found') body = <EmptyState title={page.deskUnavailableTitle} body={page.deskUnavailableBody} />;
  else if (load.kind === 'unavailable') {
    body = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={onRetry}>
            {page.tryAgain}
          </Button>
        }
      >
        {UNREACHABLE_COPY[language]}
      </Notice>
    );
  } else {
    body = <LoadingLine>{copy.opening}</LoadingLine>;
  }
  return (
    <div className="cd-agents-page" lang={language}>
      <main className="cd-agents-page__main cd-agents-page__main--state">
        <DisclosureLine language={language} />
        {body}
        <ConceptFooter />
      </main>
    </div>
  );
}
