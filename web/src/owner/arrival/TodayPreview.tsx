import { useLayoutEffect, useRef } from 'react';

import { ApprovalCard, AppShell, Greeting, SectionHeader, Sidebar, type NavKey } from '../../ds/index.ts';
import { greetingFor } from '../../lib/format.ts';
import { TODAY_PREVIEW } from './preview.ts';

import '../today/Today.css';

/** Every nav row points nowhere: the preview can't be used. */
const NOWHERE: Record<NavKey, string> = {
  today: '/',
  conversations: '/',
  people: '/',
  rules: '/',
  safety: '/',
  share: '/',
  settings: '/',
};

const ignore = () => undefined;

/**
 * A still picture of Rivera Plumbing's Today behind the intro dialog: the sidebar, a greeting to
 * Maria and the seeded held request. It is inert and hidden from assistive tech, makes no request
 * and has no footer of its own: the dialog in front of it carries the page's one.
 */
export function TodayPreview() {
  const ref = useRef<HTMLDivElement>(null);
  const p = TODAY_PREVIEW;

  // `inert` keeps every control in the picture out of reach of pointer, keyboard and find-in-page.
  useLayoutEffect(() => {
    ref.current?.setAttribute('inert', '');
  }, []);

  return (
    <div ref={ref} className="cd-today-preview" aria-hidden="true">
      <AppShell
        business={p.business}
        sidebar={
          <Sidebar
            business={p.business}
            onSwitchBusiness={ignore}
            desks={[p.desk]}
            currentDeskId={p.desk.id}
            onSwitchDesk={ignore}
            current="today"
            hrefs={NOWHERE}
            peopleLabel="Customers"
            answering
            onAnsweringChange={ignore}
            owner={{ name: p.ownerName, status: 'Available for chats' }}
          />
        }
      >
        <div className="cd-today">
          <div className="cd-today__main">
            <Greeting text={`${greetingFor(new Date(), p.timezone)}, ${p.greetingName}`} />
            <section className="cd-today__section">
              <SectionHeader title="Needs you" count={{ n: 1, label: '1 needs you' }} />
              <ApprovalCard
                decision={p.held}
                heldBy={p.heldBy}
                context={
                  <>
                    From the visitor: “<span data-copy="user">{p.fromTheVisitor}</span>”
                  </>
                }
                waiting={p.waiting}
                onAnswer={ignore}
              />
            </section>
          </div>
        </div>
      </AppShell>
    </div>
  );
}
