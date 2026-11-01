import { QueryClientProvider } from '@tanstack/react-query';
import { Component, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { AppShell, ReviewerBar } from '../../ds/index.ts';
import { OwnerDeskProvider, OwnerSidebar, type OwnerDeskContext } from '../OwnerLayout.tsx';
import { TodayPage } from '../today/TodayPage.tsx';
import { stillToday } from './preview.ts';
import { StillQueryClient } from './StillQueryClient.ts';

import '../OwnerLayout.css';
import '../today/Today.css';

const ignore = () => undefined;

/**
 * A still picture of Turner Plumbing's Today behind the intro dialog, drawn by Today itself in the
 * owner's frame (the reviewer bar, the sidebar), so the page the dialog leaves onto is the one it
 * showed: every part is where Today puts it. Today reads from a client of its own that holds a new
 * copy's reads and never asks the API (`StillQueryClient`): the picture is shown before any copy
 * exists. It is inert and hidden from assistive tech, and has no footer of its own: the dialog in
 * front of it carries the page's one. It is only a backdrop: if drawing it throws, the page behind
 * the dialog is left empty, and the dialog, the one way in, stays.
 */
export function TodayPreview() {
  return (
    <NothingIfItThrows>
      <StillToday />
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

/** The picture itself. */
function StillToday() {
  const ref = useRef<HTMLDivElement>(null);
  const [still] = useState(() => {
    const { business, desk, liveCount, reads } = stillToday(new Date());
    // Answering, a Desk's hold and a place to scroll back to do nothing here: the picture is inert,
    // and no copy exists yet.
    const context = { business, desk, setAnswering: ignore, holdDesk: ignore, reachPlace: ignore } satisfies OwnerDeskContext;
    return { client: new StillQueryClient(reads), desk: context, liveCount };
  });
  const { business, desk } = still.desk;

  // `inert` keeps every control in the picture out of reach of pointer, keyboard and find-in-page.
  useLayoutEffect(() => {
    ref.current?.setAttribute('inert', '');
  }, []);

  return (
    <div ref={ref} className="cd-today-preview" aria-hidden="true">
      <QueryClientProvider client={still.client}>
        <OwnerDeskProvider value={still.desk}>
          <AppShell
            business={business.name}
            banner={<ReviewerBar ownerName={business.owner_display_name} onStartOver={ignore} />}
            sidebar={
              <OwnerSidebar
                businesses={[business]}
                business={business}
                desk={desk}
                current="today"
                liveCount={still.liveCount}
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
      </QueryClientProvider>
    </div>
  );
}
