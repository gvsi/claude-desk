import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { ApprovalCard } from '../components/ApprovalCard/ApprovalCard.tsx';
import { Card } from '../components/Card/Card.tsx';
import { Greeting } from '../components/Greeting/Greeting.tsx';
import { Notice } from '../components/Notice/Notice.tsx';
import { RecentRequests } from '../components/RecentRequests/RecentRequests.tsx';
import { SectionHeader } from '../components/SectionHeader/SectionHeader.tsx';
import { ToolChangedItem } from '../components/ToolChangedItem/ToolChangedItem.tsx';
import { ToolPageHeader } from '../components/ToolPageHeader/ToolPageHeader.tsx';
import { ToolReviewCard } from '../components/ToolReviewCard/ToolReviewCard.tsx';
import { ToolRulesCard } from '../components/ToolRulesCard/ToolRulesCard.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../test/expectMockBadges.ts';
import { fixtureHeldRule } from '../test/heldRule.ts';
import { AskAboutRules, BoardPage, PageSection, RiveraFrame, Trail, riveraRulesFor, SIDEBAR_NOTE, SIDEBAR_ROW_NOTE } from './parts.tsx';
import { CONNECTORS_SPEC, SPEC, expectFooter, expectOutcomeMenus, expectOwnerFrame, expectRulesComposer, expectTabOrder, one } from './spec.ts';

const COUNTS = { conversations: { n: 2, label: '2 live conversations' }, safety: { n: 2, label: '2 blocked' } };
const { changedRefund } = rivera;
const changed = rivera.toolProfiles.createRefundChanged;
const REFUND_CHIPS = ['Let Dana get refunds up to $50 without asking', 'Why was Dana’s refund held?'];
const TOOL_CHANGED = "Stripe changed “Refund”, so it's off until you review it.";

/** Since the tool went off, no refund could be held: the requests before it changed. */
const REQUESTS_BEFORE = rivera.recentRequests.refund.slice(1).map((row) => ({ ...row, href: `#${row.key}` }));

const meta = {
  title: 'Boards/A tool changed',
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Today: Story = {
  name: 'A tool changed, Today',
  render: () => (
    <RiveraFrame current="today" counts={COUNTS}>
      <BoardPage>
        <Greeting text="Good morning, Mike" presence={{ line: 'Quiet right now.', people: [] }} />
        <section className="board-page-section" aria-labelledby="board-needs-you">
          <SectionHeader id="board-needs-you" title="Needs you" count={{ n: 2, label: '2 need you' }} />
          <ToolChangedItem
            connector={changedRefund.connector}
            tool={changedRefund.tool}
            noticed={changedRefund.noticedToday}
            consequence={changedRefund.consequence}
            onReview={fn()}
          />
          <ApprovalCard
            decision={rivera.decisions.held}
            rule={fixtureHeldRule(rivera.decisions.held)}
            context={
              <>
                From the visitor: “<span data-copy="user">How much to clear a clogged drain? Can I get 15% off if I pay cash?</span>”
              </>
            }
            waiting="Web chat, 2 min ago"
            onAnswer={fn()}
          />
        </section>
        <section className="board-page-section" aria-labelledby="board-since-last-night">
          <SectionHeader id="board-since-last-night" title="Since last night" />
          <Card padding={20}>
            <p className="board-briefing__summary cd-type-summary">
              All 7 conversations stayed inside your rules. I booked three visits, answered a question and stopped two attempts. Nothing was shared.
            </p>
          </Card>
        </section>
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-13-Changed-Today',
    canvasNote: [
      'The changed tool is first under “Needs you”, as its own card. The held quote keeps the signed Today’s ApprovalCard (N-Today-Run1, N-Answers-TwoButtons), where the board draws it as a short row in the same card.',
      'The presence line keeps the signed Today’s size (N-Today-Run1), where this board draws it a size smaller. The rest of Today is left out, as the board leaves it out.',
      SIDEBAR_ROW_NOTE,
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Today');
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Good morning, Mike' }), SPEC.greeting);
    // tool_changed_item_says_what_and_why: first under Needs you, with its held dot and its Mock words.
    const item = canvas.getByRole('article', { name: TOOL_CHANGED });
    const approval = canvas.getByRole('article', { name: `Held for you: ${rivera.decisions.held.reason_plain}` });
    await expect(item.compareDocumentPosition(approval) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(within(item).getByText(`Stripe · Mock · ${changedRefund.noticedToday}. ${changedRefund.consequence}`)).toBeVisible();
    await expect(one(item, '.cd-status-dot--held')).toHaveAttribute('aria-hidden', 'true');
    // The changed tool's card is compact, padded 16 px; the held request and the briefing keep 20 px.
    expectComputed(item, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
    expectComputed(approval, SPEC.card);
    expectComputed(one(canvasElement, '.board-briefing__summary').closest('.cd-card') as HTMLElement, SPEC.card);
    await expectFooter(canvasElement);
    // focus_order_is_logical: the nav, then Review, then the held request's answers.
    const review = within(item).getByRole('button', { name: 'Review' });
    const nav = within(canvas.getByRole('navigation', { name: 'Main' })).getAllByRole('link');
    const answers = [...approval.querySelectorAll<HTMLElement>('button')];
    await expectTabOrder(userEvent, [...nav, review, ...answers]);
  },
};

export const Review: Story = {
  name: 'A tool changed, review',
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Stripe', 'Refund']} />
        <ToolPageHeader {...rivera.toolPages.refund} status="needs_review" />
        <ToolReviewCard
          title={changedRefund.tool}
          connector={changedRefund.connector}
          profile={changed}
          noticed={changedRefund.noticedReview}
          onTurnBackOn={fn()}
          onKeepOff={fn()}
        />
        <PageSection title="Your rules for refund">
          <ToolRulesCard label="Your rules for refund" rules={riveraRulesFor('payments.create_refund', ['pay_out', 'private_data'])} onAddRule={fn()} />
        </PageSection>
        <AskAboutRules placeholder="Ask Claude to change a rule for refund" chips={REFUND_CHIPS} />
        <RecentRequests rows={REQUESTS_BEFORE} />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-14-Changed-Review',
    canvasNote: [
      'The quote is the fixture’s changed definition, whose markup must show as text, not the board’s sentence. “What you confirmed before” shows the description Claude sees, where the board shows the tool’s short line.',
      'The card’s top line names Stripe with its Mock badge before when it was noticed, as Today’s changed-tool item does, where the board shows only when it was noticed.',
      'The recent requests are those before the tool went off, as the board lists them.',
      'The tool page’s suggestion chips will follow the Rules page’s newest-held-request pattern once the tool pages are built.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const main = canvas.getByRole('main');
    await expect(within(main).getByText('Off until you review a change')).toBeVisible();
    // Stripe is named with its Mock badge in the source line; the trail names it as the board does.
    await expect(expectMockBesideExternalNames(one(main, '.cd-tool-page-header'))).toBe(1);
    // quoted_definition_is_text: the changed definition quoted exactly, in the quote's look, no image.
    // A compact card, as the board draws it.
    expectComputed(within(main).getByRole('region', { name: 'Needs your review' }), { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
    const quote = one(main, '.cd-tool-review__quote');
    expectComputed(quote, CONNECTORS_SPEC.quotedDefinition);
    const text = one(quote, '.cd-tool-review__quote-text');
    expectComputed(text, CONNECTORS_SPEC.quotedDefinitionText);
    await expect(text.textContent).toBe(changed.pending_definition_text);
    await expect(main.querySelector('img')).toBeNull();
    const ask = await expectRulesComposer(main, 'Ask Claude to change a rule for refund', REFUND_CHIPS);
    await expectFooter(canvasElement);
    // focus_order_is_logical: the trail, Turn back on, Keep off, then the rules.
    const turnBack = within(main).getByRole('button', { name: 'Turn back on' });
    expectComputed(turnBack, SPEC.primary);
    const keepOff = within(main).getByRole('button', { name: 'Keep off' });
    const [menu] = expectOutcomeMenus(within(main).getByRole('region', { name: 'Your rules for refund' }));
    const crumbs = within(within(main).getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    await expectTabOrder(userEvent, [...crumbs, turnBack, keepOff, menu as HTMLElement, ask.composer]);
  },
};

export const After: Story = {
  name: 'A tool changed, after',
  render: () => (
    <RiveraFrame current="rules" counts={COUNTS}>
      <BoardPage>
        <Trail items={['Connectors', 'Stripe', 'Refund']} />
        <ToolPageHeader {...rivera.toolPages.refund} status="enabled" definitionNote="Definition reviewed today" />
        <Notice tone="info">{changedRefund.backOn}</Notice>
        <PageSection title="Your rules for refund">
          <ToolRulesCard label="Your rules for refund" rules={riveraRulesFor('payments.create_refund', ['pay_out', 'private_data'])} onAddRule={fn()} />
        </PageSection>
        <AskAboutRules placeholder="Ask Claude to change a rule for refund" chips={REFUND_CHIPS} />
        <RecentRequests rows={REQUESTS_BEFORE} />
      </BoardPage>
    </RiveraFrame>
  ),
  parameters: {
    canvas: 'N-Conn-15-Changed-After',
    canvasNote: [
      'The Refund page right after the reviewed definition was confirmed: on again, its definition reviewed today, and the screen’s notice.',
      'The tool page’s suggestion chips will follow the Rules page’s newest-held-request pattern once the tool pages are built.',
      SIDEBAR_NOTE,
    ].join(' '),
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(window.innerWidth).toBe(1512);
    await expectOwnerFrame(canvasElement, 'Rules');
    const main = canvas.getByRole('main');
    await expect(within(main).getByText('Definition reviewed today', { exact: false })).toBeVisible();
    await expect(within(main).getByRole('status')).toHaveTextContent(changedRefund.backOn);
    const ask = await expectRulesComposer(main, 'Ask Claude to change a rule for refund', REFUND_CHIPS);
    await expectFooter(canvasElement);
    const [menu] = expectOutcomeMenus(main);
    const crumbs = within(within(main).getByRole('navigation', { name: 'Breadcrumb' })).getAllByRole('link');
    await expectTabOrder(userEvent, [...crumbs, menu as HTMLElement, ask.composer, ...ask.chips]);
  },
};
