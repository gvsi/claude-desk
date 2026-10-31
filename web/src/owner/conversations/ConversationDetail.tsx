/**
 * One conversation as the owner watches it (N-Conv-Run1, N-Conv-Agent-Run1, N-Conv-TakeOver): who
 * it is with and what happened last, every message with the checks under it, the requests held
 * for the owner answered in place, the visitor's typing, and the owner's controls: take over, hand
 * back or resume, whisper to Claude, or write to the visitor in their own words. Polled while open.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FocusEvent, type ReactNode } from 'react';

import type { SessionState } from '../../api/contracts.ts';
import { ApiError, request } from '../../api/http.ts';
import type { ConversationSummary, OwnerTranscript as OwnerTranscriptRead } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import {
  Button,
  Composer,
  EmptyState,
  Notice,
  Pill,
  RecordedNote,
  StatusDot,
  TakeOverBar,
  Transcript,
  TranscriptHeader,
  TranscriptRow,
  WritingIndicator,
} from '../../ds/index.ts';
import { fillComposer } from '../../lib/composer.ts';
import { formatStarted } from '../../lib/format.ts';
import { AnsweredRequest, HeldRequest, useAnsweredFocus } from '../approvals/HeldRequest.tsx';
import { useAnswer, type HeldItem } from '../approvals/useAnswer.ts';
import { publicLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { heldOldestFirst, useNeedsYou } from '../useDesks.ts';
import { useReadFailure, type ReadFailure } from '../useReadFailure.ts';
import { OwnerTranscript } from './OwnerTranscript.tsx';
import { whoLabel } from './status.ts';
import { useEndInView } from './useEndInView.ts';
import { useOwnerTyping } from './useOwnerTyping.ts';
import { conversationKey, useTakeOver } from './useTakeOver.ts';

/** Plan 02's limit on the owner's words. */
const MESSAGE_MAX_LENGTH = 2000;

export interface ConversationDetailProps {
  sessionId: string;
  /** The chat as the list read it, which names who it is with; absent until the list has it. */
  summary: ConversationSummary | undefined;
  /** A line the page that opened it left, such as why joining the chat didn't go through. */
  notice: string | null;
}

/** Who the chat is with when the list hasn't named them yet: what the session says they are. */
function fallbackName(state: SessionState): string {
  if (state.kind === 'agent') return 'Agent';
  return state.verified ? 'Verified customer' : 'Visitor';
}

/** The chat's level, as the owner reads it: a stranger, a verified customer, or someone's agent. */
function levelOf(state: SessionState): string {
  if (state.kind === 'agent') return 'Agent';
  return state.verified ? 'Verified' : 'Public';
}

/**
 * The kernel's line for the last thing that happened in the chat: its newest receipt or message.
 * Where the owner joined or left carries no line of the kernel's, so it is passed over.
 */
function latestOf(read: OwnerTranscriptRead): string | null {
  const items = [...read.items].sort((a, b) => b.n - a.n);
  for (const { event } of items) if (event !== null && 'visitor_plain' in event) return event.visitor_plain;
  return null;
}

/** The newest of the visitor's own messages in the chat, by its place: 0 before the first. */
function newestWords(read: OwnerTranscriptRead | undefined): number {
  return (read?.items ?? []).reduce((max, item) => (item.kind === 'visitor_text' ? Math.max(max, item.n) : max), 0);
}

/**
 * Whether the visitor's typing bubble shows: while the latest read carries a typing signal, until
 * a message of theirs newer than the signal takes its place. The API nulls the signal once it has
 * passed and the chat is read every 2 s, so this browser's clock is never compared with it; and
 * the screen never guesses: no signal shows nothing.
 */
function useTypingBubble(read: OwnerTranscriptRead | undefined): boolean {
  const signal = read?.typing_until ?? null;
  const words = newestWords(read);
  // The visitor's newest message when each signal was first read.
  const [seen, setSeen] = useState<{ signal: string; words: number } | null>(null);
  const current = signal === null ? null : seen?.signal === signal ? seen : { signal, words };
  useEffect(() => {
    if (current !== seen) setSeen(current);
  }, [current, seen]);
  return current !== null && words <= current.words;
}

/**
 * A held request's answer menu opens under its button, inside the transcript's scroll region, which
 * clips whatever reaches past its foot, and focus lands on one of its answers. As it does, the
 * region shows the whole menu, so she reads every answer before choosing, not only the one focused.
 */
function showTheWholeMenu(event: FocusEvent<HTMLElement>): void {
  if (event.target instanceof Element) event.target.closest('[role="menu"]')?.scrollIntoView({ block: 'nearest' });
}

/** A read that failed, in the owner's words, with a way to read it again. */
function FailedRead({ failure }: { failure: ReadFailure }) {
  return (
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
  );
}

/**
 * What the page says about where the chat came from: "Today at 12:04 pm, web chat from …". An
 * agent's name is the name it gave, so it reads as its own words.
 */
function startedLine(read: OwnerTranscriptRead, slug: string, who: string, timezone: string): ReactNode {
  const first = [...read.items].sort((a, b) => a.n - b.n)[0];
  if (first === undefined) return null;
  const when = formatStarted(first.created_at, timezone, new Date());
  if (read.state.kind === 'agent') {
    return (
      <>
        {when}, signed requests from <span data-copy="user">{who}</span>
      </>
    );
  }
  return `${when}, web chat from ${publicLink(slug).replace(/^https?:\/\//, '')}`;
}

export function ConversationDetail({ sessionId, summary, notice }: ConversationDetailProps) {
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const titleId = useId();
  const composerRef = useRef<HTMLDivElement>(null);
  const [unsent, setUnsent] = useState<{ kind: 'say' | 'whisper'; text: string } | null>(null);

  const chat = useQuery({
    queryKey: conversationKey(sessionId),
    queryFn: () => request('conversation', { params: { session_id: sessionId } }),
    refetchInterval: pollMs('conversation'),
  });
  // A read taken since the chat opened has come in, not only one kept from an earlier visit.
  const readSinceOpened = chat.isFetchedAfterMount && chat.isSuccess;
  const failure = useReadFailure(chat);
  const needsYou = useNeedsYou(deskId);
  // The requests held here come from Needs you: a failed read says so, rather than a hold with nothing to answer.
  const heldFailure = useReadFailure(needsYou);
  const answers = useAnswer(deskId);
  // A request answered here keeps focus as the button pressed goes.
  const answeredFocus = useAnsweredFocus(answers.answered);
  const controls = useTakeOver(sessionId);
  const ownerTyping = useOwnerTyping(sessionId);
  const typing = useTypingBubble(chat.data);
  const endInView = useEndInView();
  const mode = chat.data?.state.mode;

  // Unsent words go back into their own box once it is shown, and only there. The box takes
  // nothing new while a message is on its way, so they never replace words typed after them.
  useEffect(() => {
    if (unsent === null) return;
    const wrapper = composerRef.current;
    const box = wrapper?.getAttribute('data-composer') === unsent.kind ? wrapper.querySelector('textarea') : null;
    if (!box) return;
    setUnsent(null);
    fillComposer(box, unsent.text);
  }, [unsent, mode]);

  // Focus left the box as it closed for the send: once the send is over, it goes back.
  const wasSending = useRef(false);
  useEffect(() => {
    const ended = wasSending.current && !controls.sending;
    wasSending.current = controls.sending;
    const active = document.activeElement;
    if (ended && (active === null || active === document.body)) composerRef.current?.querySelector('textarea')?.focus();
  }, [controls.sending]);

  if (chat.data === undefined) {
    if (chat.error instanceof ApiError && chat.error.kind === 'not_found') {
      return (
        <EmptyState
          title="This conversation isn't in your copy"
          body="It may belong to another demo copy, or the link is wrong. Pick a conversation from the list."
        />
      );
    }
    if (failure !== null) return <FailedRead failure={failure} />;
    return (
      <p className="cd-conversation__loading cd-type-meta" role="status">
        Opening the conversation
      </p>
    );
  }

  const read = chat.data;
  const { state } = read;
  const who = summary ? whoLabel(summary) : fallbackName(state);
  const latest = latestOf(read);
  const started = startedLine(read, desk.slug, who, business.timezone);
  const now = new Date();

  // The requests held in this chat: as Needs you lists them, those answered or being answered here, oldest first.
  const held = heldOldestFirst(needsYou.data ?? []).filter((item) => item.decision.session_id === sessionId);
  const mine = (item: HeldItem) => item.decision.session_id === sessionId;
  const kept = [...answers.kept.values()].filter(mine);
  const answered = [...answers.answered.values()].filter((entry) => mine(entry.item));
  const heldIds = [...new Set([...held, ...kept].map((item) => item.decision.decision_id).concat(answered.map((a) => a.decision.decision_id)))];
  const readAt = needsYou.dataUpdatedAt;

  // Each held request answered in place, as Today answers it; once answered, it stays with its final line.
  const renderHeld = (decisionId: string) => {
    const done = answers.answered.get(decisionId);
    if (done !== undefined) {
      return (
        <div className="cd-conversation__held">
          <AnsweredRequest entry={done} now={now} registerCard={answeredFocus.register} />
        </div>
      );
    }
    const item = held.find((h) => h.decision.decision_id === decisionId) ?? answers.kept.get(decisionId);
    if (item === undefined) return null;
    return (
      <div className="cd-conversation__held">
        <HeldRequest item={item} answers={answers} readAt={readAt} now={now} />
      </div>
    );
  };

  // Words that didn't go come back into the box they were written in, as soon as it is there: the
  // owner's words for the visitor wait for her to take the chat over again if it was handed back.
  // Sending brings the end of the chat back into view, where her words will show.
  const say = (text: string) => {
    ownerTyping.sent();
    endInView.follow();
    void controls.say(text).then((sent) => {
      if (!sent) setUnsent({ kind: 'say', text });
    });
  };
  const whisper = (text: string) => {
    endInView.follow();
    void controls.whisper(text).then((sent) => {
      if (!sent) setUnsent({ kind: 'whisper', text });
    });
  };
  let composer = null;
  if (state.mode === 'owner') {
    composer = (
      // While the owner types in a chat she took over, the visitor sees her initials and three dots.
      <div ref={composerRef} data-composer="say" onInput={ownerTyping.onInput}>
        <Composer
          key="say"
          variant="owner"
          label="Write to them"
          placeholder="They see your words exactly as you write them."
          maxLength={MESSAGE_MAX_LENGTH}
          disabled={controls.sending}
          onSend={say}
        />
      </div>
    );
  } else if (state.mode === 'ai') {
    composer = (
      <div ref={composerRef} data-composer="whisper">
        <Composer
          key="whisper"
          variant="whisper"
          label="Whisper to Claude"
          placeholder="Whisper to Claude. They won't see it."
          maxLength={MESSAGE_MAX_LENGTH}
          disabled={controls.sending}
          onSend={whisper}
        />
      </div>
    );
  }

  return (
    <section className="cd-conversation" aria-labelledby={titleId}>
      <header className="cd-conversation__head">
        <h2 id={titleId} className="cd-conversation__name cd-type-section" data-copy="user">
          {who}
        </h2>
        <Pill>{levelOf(state)}</Pill>
        {state.kind === 'agent' ? (
          <Pill>
            <StatusDot tone="handled" />
            Signed
          </Pill>
        ) : null}
        {state.assurance === 'demo_code' ? <span className="cd-conversation__quiet cd-type-caption">Simulated verification</span> : null}
        {latest !== null ? <p className="cd-conversation__latest cd-type-meta">Latest: {latest}</p> : null}
      </header>
      {read.replayed === true ? (
        <div className="cd-conversation__recorded">
          <RecordedNote />
        </div>
      ) : null}
      {notice !== null ? <Notice tone="error">{notice}</Notice> : null}
      {failure !== null ? <FailedRead failure={failure} /> : null}
      {heldFailure !== null ? <FailedRead failure={heldFailure} /> : null}
      {/* The transcript, its end in view as a chat's: it scrolls on its own between the head and the owner's controls, or in a short window with them, as one. */}
      <div ref={endInView.ref} className="cd-conversation__scroll" onFocus={showTheWholeMenu}>
        <Transcript label={`Conversation with ${who}`}>
          <TranscriptHeader left={started ?? 'No messages yet.'} right="Notes from the checks sit under each message. Select one for the full trace." />
          <OwnerTranscript
            items={read.items}
            agentName={who}
            ownerName={business.owner_display_name}
            timezone={business.timezone}
            deskId={deskId}
            heldIds={heldIds}
            renderHeld={renderHeld}
            recorded={read.replayed === true}
            readSinceOpened={readSinceOpened}
          />
          {typing && state.kind !== 'agent' ? (
            <TranscriptRow>
              <WritingIndicator language="en" variant="bubble" who={who} />
            </TranscriptRow>
          ) : null}
        </Transcript>
      </div>
      {/* No one is on the other side of a recorded chat: nothing to take over, whisper or write. */}
      {read.replayed === true ? null : (
        <div className="cd-conversation__controls">
          <TakeOverBar
            mode={state.mode}
            visitorName={who}
            ownerName={business.owner_display_name}
            agent={state.kind === 'agent'}
            onTakeOver={controls.takeOver}
            onHandBack={controls.handBack}
            onResume={controls.resume}
            pending={controls.changing}
            error={controls.modeError ?? undefined}
          />
          {composer}
          {controls.messageError !== null ? <Notice tone="error">{controls.messageError}</Notice> : null}
        </div>
      )}
    </section>
  );
}
