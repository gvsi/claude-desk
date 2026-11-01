/**
 * `/d/:slug/agents`: the page for people's AI agents. It reads the public Desk (the kernel's names,
 * brand and Agent Card blocks) and the API's code-built Agent Card (the address agents send to, how
 * a request is signed, an example request), and shows them as written, in the browser's language,
 * under the business's brand header and the AI disclosure. The built-in agent sent on a task
 * (`SendAgentPanel`) leads; what agents can do, how they prove who they are, and connecting your
 * own agent with a demo key (`ConnectYourOwn`) follow. No model text is shown here but the Desk's
 * checked replies to the built-in agent and the agent's requests as it sent them, quoted as its own
 * words and cut to 280 characters.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLocation, useParams } from 'react-router';

import type { PublicDesk } from '../../api/contracts.ts';
import { ApiError, request } from '../../api/http.ts';
import type { AgentCardOut } from '../../api/views.ts';
import {
  Button,
  ConceptFooter,
  DisclosureLine,
  EmptyState,
  SkeletonScreen,
  Notice,
  PageHeader,
  PublicBrandHeader,
  TextLink,
  UNREACHABLE_COPY,
  type CopyLanguage,
} from '../../ds/index.ts';
import { browserLanguage } from '../../lib/language.ts';
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts';
import { brandFrom } from '../brand.ts';
import { PUBLIC_COPY } from '../copy.ts';
import { useDocumentLanguage } from '../useDocumentLanguage.ts';
import { useAgentSession } from './agentSession.ts';
import { AgentsCard } from './AgentsCard.tsx';
import { AgentsSkeleton } from './AgentsSkeleton.tsx';
import { ConnectYourOwn } from './ConnectYourOwn.tsx';
import { AGENTS_COPY } from './copy.ts';
import { SEND_ID, SendAgentPanel } from './SendAgentPanel.tsx';

import './AgentCardPage.css';

type Load = { kind: 'loading' } | { kind: 'not_found' } | { kind: 'unavailable' } | { kind: 'ready'; desk: PublicDesk; card: AgentCardOut };

export function AgentCardPage() {
  const { slug = '' } = useParams();
  const [language] = useState(browserLanguage);
  useDocumentLanguage(language);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const tryAgainRef = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);

  const read = useCallback(async (): Promise<Load> => {
    try {
      const [desk, card] = await Promise.allSettled([
        request('publicDesk', { params: { slug }, query: { lang: language } }),
        request('agentCard', { params: { slug } }),
      ]);
      if (desk.status === 'rejected') throw desk.reason;
      if (card.status === 'rejected') throw card.reason;
      return { kind: 'ready', desk: desk.value, card: card.value };
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
    hadFocus.current = tryAgainRef.current?.contains(document.activeElement) ?? false;
    setLoad({ kind: 'loading' });
    void read().then(setLoad);
  };

  // AgentsState unmounts while the shapes show. Keep the old button's focus here so a second
  // failure can restore it, provided the visitor hasn't moved focus elsewhere.
  useLayoutEffect(() => {
    if (load.kind === 'loading') return;
    const refocus = hadFocus.current;
    hadFocus.current = false;
    const fell = document.activeElement === null || document.activeElement === document.body;
    if (refocus && fell) tryAgainRef.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [load]);

  return (
    <>
      {load.kind === 'loading' ? <main className="cd-sr-only"><h1>Claude Desk</h1></main> : null}
      <SkeletonScreen loading={load.kind === 'loading'} status={AGENTS_COPY[language].opening} lang={language} skeleton={<AgentsSkeleton language={language} />}>
        {load.kind === 'ready' ? <AgentsPage slug={slug} desk={load.desk} card={load.card} language={language} /> :
          load.kind === 'loading' ? null : <AgentsState load={load} language={language} onRetry={retry} tryAgainRef={tryAgainRef} />}
      </SkeletonScreen>
    </>
  );
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
  // The tab carries the page's title, in its language. Before the Desk shows, the app's name stays.
  useDocumentTitle(`${business} ${copy.forAgents}`);
  const { hash } = useLocation();
  // One session for both actions, so a key and a run opened together belong to the same chat.
  const session = useAgentSession(slug);

  // The public page's "Send an agent" link lands on the panel once the page has drawn it. The panel
  // leads the page, so it is usually in view already: the page moves only when some of its card
  // isn't, and as little as brings the card in (its top first, for a card taller than the window),
  // so the title and the AI disclosure above it stay on screen when they can.
  useLayoutEffect(() => {
    if (hash === `#${SEND_ID}`) document.getElementById(SEND_ID)?.closest('section')?.scrollIntoView({ block: 'nearest' });
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
          {/* The page's one live moment leads, right under the disclosure; the reference follows it. */}
          <SendAgentPanel slug={slug} business={business} ownerName={desk.owner_display_name} session={session} language={language} />
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
        </div>
        <ConceptFooter />
      </main>
    </div>
  );
}

/**
 * The page before the Desk shows: opening, a Desk that isn't there, or one that couldn't be read.
 * "Try again" goes with its notice while the page is read again, so its focus falls to the page; if
 * that read fails too, the new "Try again" takes the focus back.
 */
function AgentsState({ load, language, onRetry, tryAgainRef }: {
  load: Exclude<Load, { kind: 'ready' } | { kind: 'loading' }>;
  language: CopyLanguage;
  onRetry: () => void;
  tryAgainRef: RefObject<HTMLDivElement>;
}) {
  const page = PUBLIC_COPY[language];

  let body: ReactNode;
  if (load.kind === 'not_found') body = <EmptyState title={page.deskUnavailableTitle} body={page.deskUnavailableBody} />;
  else if (load.kind === 'unavailable') {
    body = (
      <Notice
        tone="error"
        action={
          <div ref={tryAgainRef}>
            <Button variant="secondary" onClick={onRetry}>
              {page.tryAgain}
            </Button>
          </div>
        }
      >
        {UNREACHABLE_COPY[language]}
      </Notice>
    );
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
