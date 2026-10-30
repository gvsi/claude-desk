import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Button } from '../components/Button/Button.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { Dialog } from '../components/Dialog/Dialog.tsx';
import { PageHeader } from '../components/PageHeader/PageHeader.tsx';
import { Switch } from '../components/Switch/Switch.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { RiveraFrame } from './parts.tsx';
import { expectOwnerFrame } from './spec.ts';

/** Settings › General's details, as the board writes them; the screen formats the hours. */
const DETAILS = [
  ['Business', rivera.business.name],
  ['This Desk', rivera.business.deskName],
  ['Customers see you as', rivera.business.ownerName],
  ['Time zone', 'Pacific Time (Los Angeles)'],
  ['Hours', 'Monday to Friday, 8:00 am to 6:00 pm. Saturday, 9:00 am to 1:00 pm'],
] as const;

const SECTIONS = ['General', 'Knowledge', 'Notifications', 'Channels', 'Billing'] as const;

/** Settings › General with "Delete this Desk" pressed: the Dialog over the page. */
function SettingsDeleteDesk() {
  return (
    <RiveraFrame current="settings" fill counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } }}>
      <div className="board-page">
        <div className="board-settings">
          <PageHeader title="Settings" />
          <div className="board-settings__columns">
            <nav className="board-settings__nav" aria-label="Settings">
              <ul role="list">
                {SECTIONS.map((section) => (
                  <li key={section}>
                    <a href={`#settings-${section.toLowerCase()}`} className="board-settings__nav-link cd-type-control" aria-current={section === 'General' ? 'page' : undefined}>
                      {section}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="board-settings__content">
              <section aria-labelledby="board-business">
                <h2 id="board-business" className="board-settings__heading cd-type-section">
                  Your business
                </h2>
                <ul role="list" className="board-settings__rows">
                  {DETAILS.map(([label, value]) => (
                    <li key={label} className="board-settings__row">
                      <span className="board-settings__detail">
                        <span className="board-quiet cd-type-caption">{label}</span>
                        <span className="cd-type-body" data-copy="user">
                          {value}
                        </span>
                      </span>
                      <Button variant="ghost" onClick={fn()}>
                        Change
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
              <div className="board-settings__answering">
                <Switch label="Answering" description="When it’s off, visitors are told you’ll reply yourself." checked onChange={fn()} />
              </div>
              <section aria-labelledby="board-delete" className="board-settings__delete">
                <div>
                  <h2 id="board-delete" className="board-settings__heading cd-type-section">
                    Delete this Desk
                  </h2>
                  <p className="board-quiet cd-type-meta">Its public link stops working and its chats close. Its safety record is kept.</p>
                </div>
                <Button variant="secondary" onClick={fn()}>
                  Delete this Desk
                </Button>
              </section>
            </div>
          </div>
          <ConceptFooter />
        </div>
      </div>
      <Dialog
        title={`Delete ${rivera.business.deskName}?`}
        body="Its public link stops working and its chats close. Its safety record is kept."
        confirmLabel="Delete Desk"
        cancelLabel="Keep it"
        tone="danger"
        onConfirm={fn()}
        onCancel={fn()}
      />
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Settings, delete this Desk',
  render: () => <SettingsDeleteDesk />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Run2-Settings-DeleteDesk',
    canvasNote: [
      'Built against the board in review; sign-off pending.',
      'The danger Dialog over Settings › General: the refused dot beside “Delete Main line?”, the body, and “Keep it” focused beside “Delete Desk”, fitted to this board (24 px padding, the body 12 px under the title, the answers at a screen’s main size).',
      '“Delete Desk” and the page’s “Delete this Desk” stay neutral where the board draws them red: the design system keeps the red look for answers that refuse, and the guard danger_only_for_refusing_answers holds it there; the refused dot carries the danger.',
      'The page behind is composed loosely: its section links stand in for SubNav, which comes with the Connectors and rules change, and its rows for the web app’s General page (plan 04).',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Settings', { fill: true });
    const dialog = canvas.getByRole('dialog', { name: 'Delete Main line?' });
    // Where the board draws it: 440 by 182 px, centered on the window.
    const box = dialog.getBoundingClientRect();
    await expect([Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)]).toEqual([536, 400, 440, 182]);
    expectComputed(dialog, { paddingTop: '24px', backgroundColor: 'rgb(42, 41, 39)' });
    await expect(dialog.querySelector('.cd-status-dot--refused')).not.toBeNull();
    const keep = within(dialog).getByRole('button', { name: 'Keep it' });
    await expect(keep).toHaveFocus();
    const remove = within(dialog).getByRole('button', { name: 'Delete Desk' });
    await expect([Math.round(remove.getBoundingClientRect().top), Math.round(box.right - remove.getBoundingClientRect().right)]).toEqual([517, 25]);
  },
};
