/**
 * Connecting your own agent: where agents send their requests and how they sign them, from the
 * API's code-built Agent Card, shown as written; then a demo key to try it with. The key comes from
 * the API once (`agentKey`), is shown once in mono with "Copy key" and the warning that it is a demo
 * key, not a business credential, and is kept nowhere: the button is gone once it shows.
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
import { useAgentSession } from './agentSession.ts';
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
  language: CopyLanguage;
}

export function ConnectYourOwn({ slug, card, language }: ConnectYourOwnProps) {
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
      <DemoKey slug={slug} language={language} />
    </>
  );
}

function DemoKey({ slug, language }: { slug: string; language: CopyLanguage }) {
  const copy = AGENTS_COPY[language];
  const session = useAgentSession(slug);
  const [issued, setIssued] = useState<DemoAgentIssued | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<KeyFailure | null>(null);
  // Set while a request is out, so a second press before the page re-renders sends nothing.
  const inFlight = useRef(false);
  // Whether the card is on the page, so an answer that comes after it leaves changes nothing. Set on
  // every mount: StrictMode mounts it, cleans it up and mounts it again.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const getKey = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    void (async () => {
      try {
        const answer = await session.call(() => request('agentKey', { params: { slug } }));
        if (!isIssued(answer)) throw new ApiError('unavailable', { route: 'agentKey', method: 'POST', status: 200 });
        if (live.current) setIssued(answer);
      } catch (err) {
        if (live.current) setFailure(keyFailure(err));
      } finally {
        inFlight.current = false;
        if (live.current) setBusy(false);
      }
    })();
  };

  const newChat = () => {
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

  return (
    <AgentsCard title={copy.demoKeyTitle} lead={copy.simulated}>
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
        <div>
          <Button variant="secondary" busy={busy} onClick={getKey}>
            {copy.getDemoKey}
          </Button>
        </div>
      )}
      {notice}
    </AgentsCard>
  );
}
