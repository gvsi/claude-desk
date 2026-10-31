/**
 * Connecting your own agent: where agents send their requests and how they sign them, from the
 * API's code-built Agent Card, shown as written; then a demo key to try it with. The key comes from
 * the API once (`agentKey`, within the page's one visitor session), is shown once in mono with "Copy
 * key" and the warning that it is a demo key, not a business credential, and is kept nowhere: the
 * button is gone once it shows. A button that goes while it has focus ("Get a demo key" when the key
 * shows or the chat has ended, "New chat" when pressed) hands its focus to the card's title, so the
 * next Tab goes on from the card rather than from the top of the page.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { DemoAgentIssued } from '../../api/contracts.ts';
import { ApiError, request } from '../../api/http.ts';
import type { AgentCardOut } from '../../api/views.ts';
import {
  Button,
  CHAT_ENDED_COPY,
  CodeBlock,
  CopyField,
  NEW_CHAT_LABEL,
  Notice,
  UNREACHABLE_COPY,
  errorCopy,
  type CopyLanguage,
} from '../../ds/index.ts';
import type { AgentSession } from './agentSession.ts';
import { AgentsCard } from './AgentsCard.tsx';
import { AGENTS_COPY, type AgentsCopy } from './copy.ts';

/** Copies through the browser's clipboard; a refusal (or no clipboard) lets `CopyField` select the text instead. */
async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

/** How a request is signed, one plain line each, with the API's values as it wrote them. */
function signingLines({ signing }: AgentCardOut, copy: AgentsCopy): string[] {
  const label = copy.signing;
  return [
    `${label.headers}: ${signing.headers.join(', ')}`,
    `${label.payloadFields}: ${signing.payload_fields.join(', ')}`,
    `${label.canonical}: ${signing.canonical} JSON`,
    `${label.algorithm}: ${signing.algorithm}`,
    `${label.encoding}: ${signing.encoding}`,
    `${label.timeWindow}: ${copy.window(signing.ts_window_s)}`,
  ];
}

/** A demo key as the page shows it: both values there, as text. Anything else isn't one. */
function isIssued(value: unknown): value is DemoAgentIssued {
  const issued = value as Partial<DemoAgentIssued> | null;
  return typeof issued?.agent_key_id === 'string' && typeof issued.agent_private_key_hex === 'string';
}

/** Why a key didn't come: the chat ended, the demo is busy, or the API couldn't be reached. */
type KeyFailure = 'ended' | 'busy' | 'unreachable';

function keyFailure(err: unknown): KeyFailure {
  if (err instanceof ApiError && err.kind === 'unauthorized') return 'ended';
  if (err instanceof ApiError && err.kind === 'rate_limited') return 'busy';
  return 'unreachable';
}

export interface ConnectYourOwnProps {
  slug: string;
  card: AgentCardOut;
  /** The page's one visitor session, shared with sending the agent. */
  session: AgentSession;
  language: CopyLanguage;
}

export function ConnectYourOwn({ slug, card, session, language }: ConnectYourOwnProps) {
  const copy = AGENTS_COPY[language];
  return (
    <>
      <AgentsCard title={copy.connectTitle} lead={copy.connectLead}>
        <CopyField value={card.endpoint} copyLabel={copy.copyAddress} onCopy={copyText} layout="inline" language={language} />
        <ul className="cd-agents-page__list cd-agents-page__list--quiet cd-type-meta">
          {signingLines(card, copy).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <h3 className="cd-agents-page__label cd-type-control">{copy.exampleRequest}</h3>
        <CodeBlock code={card.example_request} />
      </AgentsCard>
      <DemoKey slug={slug} session={session} language={language} />
    </>
  );
}

function DemoKey({ slug, session, language }: { slug: string; session: AgentSession; language: CopyLanguage }) {
  const copy = AGENTS_COPY[language];
  const [issued, setIssued] = useState<DemoAgentIssued | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<KeyFailure | null>(null);
  // Set while a request is out, so a second press before the page re-renders sends nothing.
  const inFlight = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Around "Get a demo key", which goes when the key comes or the chat has ended.
  const getKeyRef = useRef<HTMLDivElement>(null);
  // Whether the card is on the page, so an answer that comes after it leaves changes nothing. Set on
  // every mount: StrictMode mounts it, cleans it up and mounts it again.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // "Get a demo key" is about to go: if it still has focus, the focus moves to the card's title
  // rather than falling to the page. A visitor who moved on while the answer was on its way keeps
  // their place. The focus doesn't scroll the page.
  const keepFocus = () => {
    if (getKeyRef.current?.contains(document.activeElement)) titleRef.current?.focus({ preventScroll: true });
  };

  const getKey = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    void (async () => {
      try {
        const answer = await session.call(() => request('agentKey', { params: { slug } }));
        if (!isIssued(answer)) throw new ApiError('unavailable', { route: 'agentKey', method: 'POST', status: 200 });
        if (!live.current) return;
        keepFocus();
        setIssued(answer);
      } catch (err) {
        if (!live.current) return;
        const failed = keyFailure(err);
        // A busy or unreachable demo keeps the button, to try again; an ended chat doesn't.
        if (failed === 'ended') keepFocus();
        setFailure(failed);
      } finally {
        inFlight.current = false;
        if (live.current) setBusy(false);
      }
    })();
  };

  const newChat = () => {
    // "New chat" goes with its notice, and "Get a demo key" comes back: its focus moves to the
    // card's title before it goes, so the next Tab goes on to "Get a demo key".
    titleRef.current?.focus({ preventScroll: true });
    setFailure(null);
    void session.reopen().catch(() => {
      if (live.current) setFailure('unreachable');
    });
  };

  let notice: ReactNode = null;
  if (failure === 'busy') notice = <Notice tone="error">{errorCopy('rate_limited', language)}</Notice>;
  else if (failure === 'unreachable') notice = <Notice tone="error">{UNREACHABLE_COPY[language]}</Notice>;
  else if (failure === 'ended') {
    notice = (
      <Notice
        tone="error"
        action={
          <Button variant="secondary" onClick={newChat}>
            {NEW_CHAT_LABEL[language]}
          </Button>
        }
      >
        {CHAT_ENDED_COPY[language]}
      </Notice>
    );
  }

  // The simulated line goes once the key shows: the card then holds the key alone (board 02).
  return (
    <AgentsCard title={copy.demoKeyTitle} lead={issued === null ? copy.simulated : undefined} titleRef={titleRef}>
      {issued !== null ? (
        <>
          <CopyField label={copy.keyId} value={issued.agent_key_id} layout="block" language={language} />
          <CopyField
            label={copy.privateKey}
            value={issued.agent_private_key_hex}
            copyLabel={copy.copyKey}
            onCopy={copyText}
            note={copy.shownOnce}
            layout="block"
            language={language}
          />
        </>
      ) : failure === 'ended' ? null : (
        <div ref={getKeyRef}>
          <Button variant="secondary" busy={busy} onClick={getKey}>
            {copy.getDemoKey}
          </Button>
        </div>
      )}
      {notice}
    </AgentsCard>
  );
}
