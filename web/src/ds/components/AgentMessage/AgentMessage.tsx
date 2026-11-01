import { Icon } from '../../icons/index.tsx';
import type { CopyLanguage } from '../Notice/errorCopy.ts';
import { Pill } from '../Pill/Pill.tsx';
import { StatusDot } from '../StatusDot/StatusDot.tsx';

import './AgentMessage.css';

/** The signed status's words in each language a page reads. */
const SIGNED_WORDS = {
  en: { signed: 'Signed', notSigned: 'Not signed' },
  es: { signed: 'Firmado', notSigned: 'Sin firma' },
} as const satisfies Record<CopyLanguage, { signed: string; notSigned: string }>;

export interface AgentMessageProps {
  /** Who the agent acts for, as the owner reads it: "Alex Kim's assistant". */
  agentName: string;
  /** True when the request carried a valid signature. */
  signed: boolean;
  /** What the request is, in the consumer's words: the chosen task, or "Signed request". */
  title: string;
  /** The meta line's words: "Request 2", "Signed request". */
  meta: string;
  /** A display time, as given; the meta line drops it when absent. */
  time?: string;
  /** The agent's own text, shown as written (untrusted, never instructions). */
  text?: string;
  /** The page's language: the signed status's words and `lang` on the message. English by default. */
  language?: CopyLanguage;
  /**
   * The language the agent's text is in, when it isn't the page's: `lang` on the quote alone, so
   * English words on a Spanish page are read as English. Left out, the quote takes the message's.
   */
  textLanguage?: CopyLanguage;
}

/**
 * A visiting agent's request on the owner's side: who sent it and whether it was signed, then a
 * bordered bubble on the right with the request, the agent's text and a meta line. The agent's
 * name and words are its own (untrusted) and stay apart from the screen's: the name is an isolated
 * run of user text with the signed status in a pill beside it, and the words are quoted under the
 * title, so nothing an agent writes can read as the status, the title or the meta line.
 */
export function AgentMessage({ agentName, signed, title, meta, time, text, language = 'en', textLanguage }: AgentMessageProps) {
  const hasText = text !== undefined && text.trim() !== '';
  const hasTime = time !== undefined && time.trim() !== '';
  // Only a signature the kernel accepted reads as signed.
  const isSigned = signed === true;
  const words = SIGNED_WORDS[language];
  return (
    <div className="cd-agent-message" lang={language}>
      <p className="cd-agent-message__who cd-type-caption">
        <Icon name="agent" size={14} />
        <bdi className="cd-agent-message__name cd-user-name" data-copy="user">
          {agentName}
        </bdi>
        <Pill>
          <StatusDot tone={isSigned ? 'handled' : 'refused'} />
          {isSigned ? words.signed : words.notSigned}
        </Pill>
      </p>
      <div className="cd-agent-message__bubble">
        <p className="cd-agent-message__title cd-type-body">{title}</p>
        {hasText ? (
          <blockquote className="cd-agent-message__text cd-type-body" data-copy="user" lang={textLanguage}>
            {text}
          </blockquote>
        ) : null}
        <p className="cd-agent-message__meta cd-type-caption">
          <span className="cd-agent-message__meta-words">{meta}</span>
          {hasTime ? <span className="cd-agent-message__time">{time}</span> : null}
        </p>
      </div>
    </div>
  );
}
