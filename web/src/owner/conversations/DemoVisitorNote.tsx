/**
 * The note over a demo visitor's conversation: an AI the owner started plays the customer. While its
 * run is going, the note says so, with "Stop the demo visitor"; once it has ended, how it ended, with
 * no button.
 *
 * The note reads the conversation's own run by its ID, so an older conversation keeps its own ending
 * after a newer run starts on the Desk. The ID comes from the start that opened the page; else from
 * the Desk's newest run, when that run is this chat's (only one runs at a time in a copy, so a chat
 * whose run isn't the newest has ended); and once learned it is kept while the app runs. Runs live
 * in the API's memory for an hour: a run it no longer keeps, or a chat whose run can't be found,
 * has ended, and is said to have finished.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { ApiError, ownerErrorCopy, request } from '../../api/http.ts';
import type { DemoVisitorRun } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import { Button, Notice } from '../../ds/index.ts';
import { DEMO_VISITOR_NOTE } from './copy.ts';

/** The run ID the app has learned for a demo visitor's chat, kept in the query client while the app runs. */
const runIdKey = (sessionId: string) => ['demoVisitorRunOf', sessionId] as const;

/** The Desk's newest demo visitor run. */
export const newestDemoVisitorKey = (deskId: string) => ['demoVisitor', deskId] as const;

/** One demo visitor run, by its ID. */
export const demoVisitorRunKey = (deskId: string, runId: string) => ['demoVisitorRun', deskId, runId] as const;

const notFound = (error: unknown) => error instanceof ApiError && error.kind === 'not_found';

/** Where the chat's demo visitor stands: unknown until read, going, or ended (with how, when known). */
export type DemoVisitorPhase =
  | { phase: 'unknown' }
  | { phase: 'running'; run: DemoVisitorRun }
  | { phase: 'ended'; ended: DemoVisitorRun['ended'] };

/** The line once the demo visitor has ended: stopped by the owner, or finished however else it ended. */
export function endedLine(ended: DemoVisitorRun['ended']): string {
  return ended === 'stopped_by_owner' ? DEMO_VISITOR_NOTE.stopped : DEMO_VISITOR_NOTE.finished;
}

/**
 * The demo visitor run of chat `sessionId` on `deskId`, read while `demo` (the chat is a demo
 * visitor's), polled at the conversation's pace while it runs. `startedRun` is the run the page that
 * opened the chat started there, if it did.
 */
export function useDemoVisitorRun(deskId: string, sessionId: string, demo: boolean, startedRun: string | null) {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(() => startedRun ?? queryClient.getQueryData<string>(runIdKey(sessionId)) ?? null);

  const newest = useQuery({
    queryKey: newestDemoVisitorKey(deskId),
    queryFn: () => request('demoVisitor', { params: { desk_id: deskId } }),
    enabled: demo && runId === null,
  });
  // Only a read made since this chat opened says whose the newest run is: one kept from an earlier
  // visit may be an older run's.
  const newestRead = newest.isFetchedAfterMount ? newest : null;
  const newestIsThisChat = newestRead?.data !== undefined && newestRead.data.session_id === sessionId;
  const learned = runId ?? (newestIsThisChat ? newestRead!.data!.run_id : null);
  useEffect(() => {
    if (learned === null) return;
    if (runId === null) setRunId(learned);
    queryClient.setQueryData(runIdKey(sessionId), learned);
  }, [learned, runId, queryClient, sessionId]);

  const run = useQuery({
    queryKey: demoVisitorRunKey(deskId, learned ?? ''),
    queryFn: () => request('demoVisitorRun', { params: { desk_id: deskId, run_id: learned ?? '' } }),
    enabled: demo && learned !== null,
    refetchInterval: (query) => (query.state.data === undefined || query.state.data.state === 'running' ? pollMs('conversation') : false),
  });

  let phase: DemoVisitorPhase = { phase: 'unknown' };
  if (!demo) phase = { phase: 'unknown' };
  else if (learned === null) {
    // The Desk has no run kept, or its newest is another chat's: this chat's run has ended.
    if (newestRead !== null && (notFound(newestRead.error) || (newestRead.data !== undefined && !newestIsThisChat))) phase = { phase: 'ended', ended: null };
  } else if (run.data !== undefined) {
    phase = run.data.state === 'running' ? { phase: 'running', run: run.data } : { phase: 'ended', ended: run.data.ended };
  } else if (notFound(run.error)) {
    phase = { phase: 'ended', ended: null };
  }
  return phase;
}

export interface DemoVisitorNoteProps {
  deskId: string;
  phase: DemoVisitorPhase;
  /** Where focus goes once Stop has gone, so it never falls to the page: the conversation's name. */
  onStopped: () => void;
}

/**
 * The note itself, an info `Notice` placed like the recorded note, 8 px under the conversation's
 * head. Stop is a ghost inline button; it ends the run at once and the note says so. A Stop that
 * fails says why under the note, and the button stays.
 */
export function DemoVisitorNote({ deskId, phase, onStopped }: DemoVisitorNoteProps) {
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (phase.phase === 'unknown') return null;

  const stop = async (run: DemoVisitorRun) => {
    setStopping(true);
    setFailure(null);
    try {
      const stopped = await request('stopDemoVisitor', { params: { desk_id: deskId, run_id: run.run_id } });
      queryClient.setQueryData(demoVisitorRunKey(deskId, run.run_id), stopped);
      onStopped();
    } catch (err) {
      if (notFound(err)) {
        // No longer kept: it has ended. The next read says so.
        await queryClient.invalidateQueries({ queryKey: demoVisitorRunKey(deskId, run.run_id) });
        onStopped();
      } else if (!(err instanceof ApiError && err.kind === 'unauthorized')) {
        setFailure(ownerErrorCopy(err));
      }
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="cd-conversation__demo">
      {phase.phase === 'running' ? (
        <Notice
          tone="info"
          action={
            <Button variant="ghost" busy={stopping} onClick={() => void stop(phase.run)}>
              {DEMO_VISITOR_NOTE.stop}
            </Button>
          }
        >
          {DEMO_VISITOR_NOTE.running}
        </Notice>
      ) : (
        <Notice tone="info">{endedLine(phase.ended)}</Notice>
      )}
      {failure !== null ? <Notice tone="error">{failure}</Notice> : null}
    </div>
  );
}
