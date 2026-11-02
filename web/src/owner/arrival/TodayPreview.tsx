import { QueryClientProvider } from '@tanstack/react-query';
import { Component, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { AppShell, ReviewerBar } from '../../ds/index.ts';
import { OwnerDeskProvider, OwnerSidebar, type OwnerDeskContext } from '../OwnerLayout.tsx';
import { TodayClockContext } from '../today/todayClock.ts';
import { TodayPage } from '../today/TodayPage.tsx';
import { previewClock, stillToday } from './preview.ts';
import { StillQueryClient } from './StillQueryClient.ts';

import '../OwnerLayout.css';
import '../today/Today.css';

const ignore = () => undefined;

export interface TodayPreviewProps {
  /** When the copy opened, as the page read it the moment the copy answered (a `Date.now()` time), or null until then. */
  openedAt: number | null;
}

/**
 * A still picture of Turner Plumbing's Today behind the intro dialog, drawn by Today itself in the
 * owner's frame (the reviewer bar, the sidebar), so the page the dialog leaves onto is the one it
 * showed: every part is where Today puts it. Today reads from a client of its own that holds a new
 * copy's reads and never asks the API (`StillQueryClient`): the picture is shown before any copy
 * exists. It is dated from when the page was drawn until the copy opens, then drawn again from
 * `openedAt`, so the Today the dialog leaves onto has the times and days it showed. It is inert and
 * hidden from assistive tech, and has no footer of its own: the dialog in front of it carries the
 * page's one. It is only a backdrop: if drawing it throws, the page behind the dialog is left empty,
 * and the dialog, the one way in, stays.
 */
export function TodayPreview({ openedAt }: TodayPreviewProps) {
  const [drawnAt] = useState(() => Date.now());
  const { opened, readAt } = previewClock(drawnAt, openedAt);
  return (
    <NothingIfItThrows>
      {/* Drawn afresh for each opening: its still client holds one copy's reads. */}
      <StillToday key={opened.getTime()} opened={opened.getTime()} readAt={readAt.getTime()} />
    </NothingIfItThrows>
  );
}

/** Draws its children, or nothing once drawing them has thrown. */
class NothingIfItThrows extends Component<{ children: ReactNode }, { threw: boolean }> {
  override state = { threw: false };

  static getDerivedStateFromError(): { threw: boolean } {
    return { threw: true };
  }

  override render() {
    return this.state.threw ? null : this.props.children;
  }
}

/** The picture itself, of a copy that opened at `opened`, read and labelled at `readAt` (both `Date.now()` times). */
function StillToday({ opened, readAt }: { opened: number; readAt: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [still] = useState(() => {
    const { business, desk, liveCount, unreadCount, reads } = stillToday(new Date(opened), new Date(readAt));
    // Answering, a Desk's hold and a place to scroll back to do nothing here: the picture is inert,
    // and no copy exists yet.
    const context = { business, desk, setAnswering: ignore, holdDesk: ignore, reachPlace: ignore } satisfies OwnerDeskContext;
    // Today's labels are drawn at the moment the picture reads its copy, as Today will draw them.
    const clock = () => new Date(readAt);
    return { client: new StillQueryClient(reads), desk: context, liveCount, unreadCount, clock };
  });
  const { business, desk } = still.desk;

  // `inert` keeps every control in the picture out of reach of pointer, keyboard and find-in-page.
  useLayoutEffect(() => {
    ref.current?.setAttribute('inert', '');
  }, []);

  return (
    <div ref={ref} className="cd-today-preview" aria-hidden="true">
      <QueryClientProvider client={still.client}>
        <TodayClockContext.Provider value={still.clock}>
          <OwnerDeskProvider value={still.desk}>
            <AppShell
              todayHref={`/app/${encodeURIComponent(desk.desk_id)}/today`}
              business={business.name}
              banner={<ReviewerBar ownerName={business.owner_display_name} onStartOver={ignore} />}
              sidebar={
                <OwnerSidebar
                  conceptFooter={false}
                  businesses={[business]}
                  business={business}
                  desk={desk}
                  current="today"
                  liveCount={still.liveCount}
                  unreadCount={still.unreadCount}
                  switching={false}
                  onToggleSwitcher={ignore}
                  onCloseSwitcher={ignore}
                  onPickBusiness={ignore}
                  onNewBusiness={ignore}
                  onSwitchDesk={ignore}
                  onAnsweringChange={ignore}
                />
              }
            >
              <div className="cd-owner-layout">
                <TodayPage namesTheTab={false} />
              </div>
            </AppShell>
          </OwnerDeskProvider>
        </TodayClockContext.Provider>
      </QueryClientProvider>
    </div>
  );
}
