/**
 * The note over a demo visitor's conversation: an AI the owner started plays the customer. While its
 * run is going, the note says so, with "Stop the demo visitor"; once it has ended, how it ended, with
 * no button.
 *
 * The note reads the conversation's own run by its ID, so an older conversation keeps its own ending
 * after a newer run starts on the Desk: the ID the conversation's own reads name (the run that opened
 * the chat), else the run the start that opened the page answered. Runs live in the API's memory for
 * an hour: a run it no longer keeps, or a demo chat whose reads name no run (marked before its run was
 * named), has ended, and is said to have finished.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError, ownerErrorCopy, request } from '../../api/http.ts';
import type { DemoVisitorRun } from '../../api/views.ts';
import { pollMs } from '../../app/poll.ts';
import { Button, Notice } from '../../ds/index.ts';
import { DEMO_VISITOR_NOTE } from './copy.ts';

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
 * visitor's), polled at the conversation's pace while it runs. `namedRun` is the run the
 * conversation's reads name, once they have; `startedRun` the run the page that opened the chat
 * started there, if it did.
 */
export function useDemoVisitorRun(deskId: string, demo: boolean, namedRun: string | null, startedRun: string | null): DemoVisitorPhase {
  const runId = namedRun ?? startedRun;
  const run = useQuery({
    queryKey: demoVisitorRunKey(deskId, runId ?? ''),
    queryFn: () => request('demoVisitorRun', { params: { desk_id: deskId, run_id: runId ?? '' } }),
    enabled: demo && runId !== null,
    // Read again while it runs; not once it has ended, or once the API no longer keeps it.
    refetchInterval: (query) =>
      !notFound(query.state.error) && (query.state.data === undefined || query.state.data.state === 'running') ? pollMs('conversation') : false,
  });

  if (!demo) return { phase: 'unknown' };
  // A demo chat whose reads name no run: its own run can't be read, so it has ended.
  if (runId === null) return { phase: 'ended', ended: null };
  // No longer kept (the API restarted, or its hour passed): it has ended, whatever an earlier read
  // said. It was stopped only when a read this tab made says the owner stopped it.
  if (notFound(run.error)) return { phase: 'ended', ended: run.data?.ended === 'stopped_by_owner' ? 'stopped_by_owner' : null };
  if (run.data !== undefined) return run.data.state === 'running' ? { phase: 'running', run: run.data } : { phase: 'ended', ended: run.data.ended };
  return { phase: 'unknown' };
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
