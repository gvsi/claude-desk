/**
 * One conversation as the owner watches it (N-Conv-Run1, N-Conv-Agent-Run1, N-Conv-TakeOver): who
 * it is with and what happened last, every message with the checks under it, the requests held
 * for the owner answered in place, the visitor's typing, and the owner's controls: take over, hand
 * back or resume, whisper to Claude, or write to the visitor in their own words. Polled while open.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';

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
  SkeletonScreen,
  StatusDot,
  TakeOverBar,
  Transcript,
  TranscriptHeader,
  TranscriptRow,
  WritingIndicator,
} from '../../ds/index.ts';
import { fillComposer } from '../../lib/composer.ts';
import { formatStarted } from '../../lib/format.ts';
import { HeldRequest, useAnsweredFocus } from '../approvals/HeldRequest.tsx';
import { useAnswer, type HeldItem } from '../approvals/useAnswer.ts';
import { CallbackCard, type CallbackItem } from '../handoffs/CallbackCard.tsx';
import { publicLink } from '../customerLink.ts';
import { useOwnerDesk } from '../OwnerLayout.tsx';
import { heldOldestFirst, useNeedsYou } from '../useDesks.ts';
import { useReadFailure, type ReadFailure } from '../useReadFailure.ts';
import { TRANSCRIPT_NOTE } from './copy.ts';
import { ConversationSkeleton } from './ConversationsSkeleton.tsx';
import { latestOf } from './latest.ts';
import { CONVERSATIONS_SINGLE_COLUMN } from './layout.ts';
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
  /** The list's first read has settled, data or failure, so `summary` names who the chat is with if it can. */
  listRead: boolean;
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

export function ConversationDetail({ sessionId, summary, listRead, notice }: ConversationDetailProps) {
  const { business, desk } = useOwnerDesk();
  const deskId = desk.desk_id;
  const titleId = useId();
  const nameRef = useRef<HTMLHeadingElement>(null);
  const transcriptRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [unsent, setUnsent] = useState<{ kind: 'say' | 'whisper'; text: string } | null>(null);

  const chat = useQuery({
    queryKey: conversationKey(sessionId),
    queryFn: () => request('conversation', { params: { session_id: sessionId } }),
    refetchInterval: pollMs('conversation'),
  });
  // A read taken since the chat opened has come in, not only one kept from an earlier visit.
  const readSinceOpened = chat.isFetchedAfterMount && chat.isSuccess;
  const failure = useReadFailure(chat, { pausedRoute: 'conversation' });
  const needsYou = useNeedsYou(deskId);
  // The requests held here come from Needs you: a failed read says so, rather than a hold with nothing to answer.
  const heldFailure = useReadFailure(needsYou, { pausedRoute: 'needsYou' });
  const answers = useAnswer(deskId);
  // A request answered here keeps focus as the button pressed goes.
  const answeredFocus = useAnsweredFocus(answers.answered);
  const controls = useTakeOver(sessionId);
  const ownerTyping = useOwnerTyping(sessionId);
  const typing = useTypingBubble(chat.data);
  const endInView = useEndInView();
  const [handoffCards, setHandoffCards] = useState<HTMLDivElement | null>(null);
  const shownHandoff = useRef<string | null>(null);
  const { ready, reveal } = endInView;
  // The first handoff shown in this open chat leads, if she is still where the chat opened.
  // Later polls and cards never move her back, even after she marks the first one done.
  useEffect(() => {
    if (!ready || !handoffCards || shownHandoff.current === sessionId) return;
    shownHandoff.current = sessionId;
    reveal(handoffCards);
  }, [ready, handoffCards, sessionId, reveal]);
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

  // The pane's first view draws from the chat, from Needs you (the requests held in it) and from the
  // list (who it is with): until each has settled, data or failure, the pane draws its shapes. Every
  // way the pane ends up draws inside the one region, so it stays mounted as they change.
  const loading = (chat.data === undefined && failure === null) || (needsYou.data === undefined && heldFailure === null) || !listRead;
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (loading || chat.data === undefined || opened.current) return;
    // On a phone the focused list row steps aside. Announce the chat once it is read, unless
    // the owner has already moved on to another control while it was opening.
    if (!window.matchMedia(CONVERSATIONS_SINGLE_COLUMN).matches) return;
    const active = document.activeElement;
    if (active === null || active === document.body || active.closest('.cd-conversations__list')) {
      nameRef.current?.focus();
      opened.current = document.activeElement === nameRef.current;
    }
  }, [loading, chat.data]);
  const pane = (content: ReactNode) => (
    <SkeletonScreen loading={loading} status="Opening the conversation" skeleton={<ConversationSkeleton />} className="cd-conversation-pane">
      {content}
    </SkeletonScreen>
  );
  if (loading) return pane(null);
  if (chat.data === undefined) {
    if (chat.error instanceof ApiError && chat.error.kind === 'not_found') {
      return pane(
        <EmptyState
          title="This conversation isn't in your copy"
          body="It may belong to another demo copy, or the link is wrong. Pick a conversation from the list."
        />,
      );
    }
    return pane(failure === null ? null : <FailedRead failure={failure} />);
  }

  const read = chat.data;
  const { state } = read;
  const who = summary ? whoLabel(summary) : fallbackName(state);
  // With no name on record, the title already says what they are ("Agent"), so the level isn't said twice.
  const level = levelOf(state);
  const latest = latestOf(read.items);
  const started = startedLine(read, desk.slug, who, business.timezone);
  const now = new Date();

  // The requests held in this chat: as Needs you lists them, those answered or being answered here, oldest first.
  const held = heldOldestFirst(needsYou.data ?? []).filter((item) => item.decision.session_id === sessionId);
  const callbacks = read.replayed === true
    ? []
    : (needsYou.data ?? []).filter((item): item is CallbackItem => item.handoff !== null && item.handoff.session_id === sessionId);
  const mine = (item: HeldItem) => item.decision.session_id === sessionId;
  const kept = [...answers.kept.values()].filter(mine);
  const answered = [...answers.answered.values()].filter((entry) => mine(entry.item));
  const heldIds = [...new Set([...held, ...kept].map((item) => item.decision.decision_id).concat(answered.map((a) => a.decision.decision_id)))];
  // A request still held in this chat, not answered here: its handoff cards leave Claude's note out.
  const holdOpen = [...held, ...kept].some((item) => !answers.answered.has(item.decision.decision_id));
  const readAt = needsYou.dataUpdatedAt;

  // Each held request answered in place, as Today answers it: one card from held to answered, so the
  // answer lands in its slot, and once answered it stays with its final line.
  const renderHeld = (decisionId: string) => {
    const item =
      answers.answered.get(decisionId)?.item ?? held.find((h) => h.decision.decision_id === decisionId) ?? answers.kept.get(decisionId);
    if (item === undefined) return null;
    return (
      <div className="cd-conversation__held">
        <HeldRequest item={item} answers={answers} readAt={readAt} now={now} registerCard={answeredFocus.register} />
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

  return pane(
    <section className="cd-conversation" aria-labelledby={titleId}>
      <header className="cd-conversation__head">
        <h2 ref={nameRef} tabIndex={-1} id={titleId} className="cd-conversation__name cd-type-section" data-copy="user">
          {who}
        </h2>
        {level !== who ? <Pill>{level}</Pill> : null}
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
      {/* The transcript and its handoff cards scroll between the head and the owner's controls, or in a short window with them, as one. */}
      <div ref={endInView.ref} className="cd-conversation__scroll" onFocus={showTheWholeMenu}>
        {callbacks.length > 0 ? (
          <div ref={setHandoffCards} className="cd-conversation__handoffs">
            {callbacks.map((item) => (
              <CallbackCard key={item.handoff.handoff_id} item={item} showJoin={false} showSummary={!holdOpen} onDone={() => nameRef.current?.focus({ preventScroll: true })} />
            ))}
          </div>
        ) : null}
        <Transcript label={`Conversation with ${who}`} logRef={transcriptRef}>
          <TranscriptHeader left={started ?? 'No messages yet.'} right={TRANSCRIPT_NOTE} />
          <OwnerTranscript
            items={read.items}
            focusTarget={transcriptRef}
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
    </section>,
  );
}
