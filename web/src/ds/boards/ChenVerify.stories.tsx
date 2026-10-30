import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Composer } from '../components/Composer/Composer.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { DemoInboxPanel, type DemoInboxItem } from '../components/DemoInboxPanel/DemoInboxPanel.tsx';
import { PublicShell } from '../components/PublicShell/PublicShell.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { VerifiedLine } from '../components/VerifyCodeForm/VerifiedLine.tsx';
import { VerifyCodeForm } from '../components/VerifyCodeForm/VerifyCodeForm.tsx';
import { chen } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { TurnRows, brandOf } from './parts.tsx';
import { SPEC, expectConversationType, expectReceiptsUnderMessages, expectTabOrder, one, some } from './spec.ts';

const raj = chen.conversations.raj;
const OWNER = chen.business.ownerName;
/** Raj's ask and the verify card, before the code; then the release and his return, after it. */
const beforeTheCode = raj.turns.slice(0, 2);
const afterTheCode = raj.turns.slice(2);
const VERIFIED = `Verified with a code sent to ${chen.people.raj.maskedContact}`;
const STATES = { waiting: 'While the code is on its way', verified: 'After the code' } as const;

/** Raj's code, opened in his Demo inbox from the entry the screen fetched. */
const codeItem: DemoInboxItem = (() => {
  const [notice] = chen.demoInbox.notices;
  const entry = chen.demoInbox.entries.find((candidate) => candidate.entry_id === notice?.entry_id);
  if (!notice || !entry) throw new Error('the Chen fixture has no code in its Demo inbox');
  return { notice, entry };
})();

/** One state of Raj's chat on Chen & Co.'s public page, embedded so both share one document. */
function ChenPage({ label, children, after }: { label: string; children: React.ReactNode; after?: React.ReactNode }) {
  return (
    <section className="board-verify__page" aria-label={label}>
      <PublicShell
        brand={brandOf(chen.publicDesk.en)}
        ownerName={OWNER}
        language="en"
        onAskForOwner={fn()}
        footer={false}
        composer={<Composer variant="visitor" label="Message Chen & Co. CPA" placeholder="Message Chen & Co. CPA" maxLength={2000} onSend={fn()} />}
      >
        <Transcript label="Conversation with Chen & Co. CPA">{children}</Transcript>
        {after}
      </PublicShell>
    </section>
  );
}

function ChenVerify() {
  return (
    <main className="board-verify">
      <h1 className="cd-sr-only">Confirm it’s you</h1>
      <ChenPage
        label={STATES.waiting}
        after={
          <div className="board-verify__form">
            <VerifyCodeForm state="idle" language="en" onSubmit={fn()} onAskForOwner={fn()} />
          </div>
        }
      >
        <TurnRows turns={beforeTheCode} />
      </ChenPage>
      <div className="board-verify__inbox">
        <DemoInboxPanel viewer="visitor" language="en" items={[codeItem]} onRetry={fn()} />
      </div>
      <ChenPage label={STATES.verified}>
        <TurnRows turns={beforeTheCode} />
        <VerifiedLine text={VERIFIED} assurance="demo_code" language="en" />
        <TurnRows turns={afterTheCode} />
      </ChenPage>
      <div className="board-verify__footer">
        <ConceptFooter poweredBy />
      </div>
    </main>
  );
}

const meta = {
  title: 'Boards/Confirm it’s you',
  render: () => <ChenVerify />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Public-Verify-Run1',
    canvasNote: [
      'Both states and the Demo inbox between them, as on the board: VerifyCodeForm under the verify card while the code is on its way, then VerifiedLine with “Simulated verification” and the document_link card after it.',
      'The form starts empty where the board shows the code typed in; the inbox entry’s body is the kernel’s code message, longer than the board’s.',
      'Each page is embedded and the concept footer shows once under all three columns, since one document can’t hold two pages’ landmarks; the board draws the footer under each page.',
      'The receipts are the fixture’s: the reply check under the verify card, and the release and reply check under the return, where the board adds “Verification started”.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, userEvent }) => {
    const waiting = canvas.getByRole('region', { name: STATES.waiting });
    const verified = canvas.getByRole('region', { name: STATES.verified });
    for (const page of [waiting, verified]) {
      const log = within(page).getByRole('log', { name: 'Conversation with Chen & Co. CPA' });
      expectConversationType(log);
      await expectReceiptsUnderMessages(log);
      await expect(page).toHaveTextContent('Claude, an AI answering for Chen & Co. CPA');
      expectComputed(one(page, '.cd-composer__box'), SPEC.composer);
    }

    // While the code is on its way: the form under the verify card, its Confirm the primary button.
    const field = within(waiting).getByLabelText('6-digit code');
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    const verifyCard = some(waiting, '.cd-reply-card').find((card) => card.textContent?.includes(chen.blocks.verify_prompt.en.title ?? ''));
    await expect(field.getBoundingClientRect().top).toBeGreaterThan(verifyCard?.getBoundingClientRect().bottom ?? Infinity);
    expectComputed(within(waiting).getByRole('button', { name: 'Confirm' }), SPEC.primary);

    // The Demo inbox between them holds only the code, from the fetched entry.
    const inbox = canvas.getByRole('region', { name: 'Demo inbox' });
    await expect(inbox).toHaveTextContent(codeItem.entry?.body ?? '');

    // After the code: the verified line, labelled simulated, then the return as a document card.
    await expect(within(verified).getByText(`${VERIFIED}. Simulated verification`)).toBeVisible();
    const documentCard = some(verified, '.cd-reply-card').find((card) => card.textContent?.includes(chen.blocks.document_link.en.title ?? ''));
    await expect(documentCard).toBeDefined();

    // focus_order_is_logical: each page's Ask for Linda Chen, its form or card action, then its composer.
    const download = within(verified).getByRole('link', { name: /Download/ });
    await expectTabOrder(userEvent, [
      within(waiting).getByRole('button', { name: `Ask for ${OWNER}` }),
      field,
      within(waiting).getByRole('button', { name: 'I can’t get the code' }),
      within(waiting).getByRole('textbox', { name: 'Message Chen & Co. CPA' }),
      within(verified).getByRole('button', { name: `Ask for ${OWNER}` }),
      download,
      within(verified).getByRole('textbox', { name: 'Message Chen & Co. CPA' }),
    ]);
  },
};
