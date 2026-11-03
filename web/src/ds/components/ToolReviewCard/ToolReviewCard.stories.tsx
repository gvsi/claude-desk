import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ToolReviewCard } from './ToolReviewCard.tsx';

const { changedRefund } = rivera;
const changed = rivera.toolProfiles.createRefundChanged;
const reviewedHash = changed.pending_sha256;

const SUMMARY = "Stripe changed “Refund”, so it's turned off until you review it. Until you decide, it can't run at all.";
const QUOTE_LABEL = 'Quoted from the connector. Claude never sees this text; it sees only the description you confirmed.';
const TRUST_LINE = 'Turning it back on trusts the new definition and checks your rules again before it runs.';
const NO_HASH = "This change can't be reviewed right now. Reload the page.";

const meta = {
  title: 'Connectors/ToolReviewCard',
  component: ToolReviewCard,
  args: {
    title: changedRefund.tool,
    connector: changedRefund.connector,
    profile: changed,
    noticed: changedRefund.noticedReview,
    onTurnBackOn: fn(),
    onKeepOff: fn(),
  },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ToolReviewCard {...args} />
    </div>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Conn-14-Changed-Review',
    canvasNote:
      'The quote is the fixture\'s drifted definition, whose markup must show as text, not the board\'s sentence. "What you confirmed before" shows description_confirmed, the text Claude sees, where the board shows the tool\'s short line.',
  },
} satisfies Meta<typeof ToolReviewCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CreateRefundChanged: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // mock_badge_always_beside_external_names: the card names Stripe with its badge at the top, so
    // the summary's "Stripe changed" sits in a card that says it is a mock.
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    const card = canvas.getByRole('region', { name: 'Needs your review' });
    // A held dot and "Needs your review", with the connector and its badge and when it was noticed
    // at the right.
    const status = within(card).getByRole('heading', { level: 2, name: 'Needs your review' });
    await expect(status.querySelector('.cd-status-dot--held')).toHaveAttribute('aria-hidden', 'true');
    const noticed = card.querySelector<HTMLElement>('.cd-tool-review__noticed');
    await expect(noticed?.textContent?.replace(/\s+/g, ' ')).toBe(`Stripe Mock · ${args.noticed}`);
    await expect(noticed).toBeVisible();
    // quoted_definition_is_text: the summary in serif, Claude's words.
    const summary = within(card).getByText(SUMMARY);
    expectComputed(summary, { fontFamily: '"Source Serif 4", Georgia, serif', fontSize: '20px' });
    // What was confirmed before: the confirmed description and its effects.
    await expect(within(card).getByRole('heading', { level: 3, name: 'What you confirmed before' })).toBeVisible();
    await expect(within(card).getByText(changed.description_confirmed)).toBeVisible();
    await expect(within(card).getByText("Moves money out. Can't be undone.")).toBeVisible();
    // What the connector says now: a blockquote labelled as a quote, holding the definition as literal text.
    await expect(within(card).getByRole('heading', { level: 3, name: 'What the connector says now' })).toBeVisible();
    const quote = canvasElement.querySelector('blockquote');
    if (quote === null) throw new Error('No quote');
    await expect(quote).toHaveAccessibleName(QUOTE_LABEL);
    await expect(within(quote).getByText(QUOTE_LABEL)).toBeVisible();
    const text = quote.querySelector('[data-copy="user"]');
    if (!(text instanceof HTMLElement)) throw new Error('No quoted text');
    await expect(text.textContent).toBe(changed.pending_definition_text);
    await expect(text.children).toHaveLength(0);
    // Its markup is text: no image was made, and nothing ran.
    await expect(canvasElement.querySelectorAll('img')).toHaveLength(0);
    await expect(text).toHaveTextContent('<img src=x onerror=alert(1)>');
    expectComputed(quote, {
      paddingTop: '10px',
      paddingLeft: '12px',
      borderTopWidth: '1px',
      borderTopColor: 'rgba(250, 249, 245, 0.12)',
      backgroundColor: 'rgb(28, 27, 25)',
    });
    expectComputed(text, { fontFamily: '"JetBrains Mono", ui-monospace, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
    await expect(within(card).getByText(TRUST_LINE)).toBeVisible();

    // confirm_names_the_reviewed_hash: Tab to "Turn back on", then Enter turns it back on once,
    // with the hash of the definition the owner reviewed.
    const turnBackOn = within(card).getByRole('button', { name: 'Turn back on' });
    const keepOff = within(card).getByRole('button', { name: 'Keep off' });
    await userEvent.tab();
    await expect(turnBackOn).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{Enter}');
    await expect(args.onTurnBackOn).toHaveBeenCalledTimes(1);
    await expect(args.onTurnBackOn).toHaveBeenCalledWith(reviewedHash);
    await expect(args.onTurnBackOn).not.toHaveBeenCalledWith(changed.definition_sha256);
    // It waits for its answer: the pressed button spins, the other waits.
    await expect(turnBackOn).toHaveAttribute('aria-busy', 'true');
    await expect(turnBackOn.querySelectorAll('.cd-button__spinner')).toHaveLength(1);
    await expect(keepOff).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(keepOff);
    await expect(args.onKeepOff).not.toHaveBeenCalled();
  },
};

export const KeepOff: Story = {
  parameters: { canvasNote: 'The same review, answered "Keep off"; the board draws the review only.' },
  play: async ({ args, canvas, userEvent, canvasElement }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Keep off' }));
    await expect(args.onKeepOff).toHaveBeenCalledTimes(1);
    await expect(args.onKeepOff).toHaveBeenCalledWith(reviewedHash);
    await expect(args.onTurnBackOn).not.toHaveBeenCalled();
  },
};

export const Sending: Story = {
  args: { pending: true },
  parameters: { canvasNote: 'The review while the screen sends the answer; no board draws it.' },
  play: async ({ args, canvas, userEvent, canvasElement }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    const card = canvas.getByRole('region', { name: 'Needs your review' });
    await expect(card.querySelector('.cd-tool-review')).toHaveAttribute('aria-busy', 'true');
    // Both answers wait, and neither can be sent again.
    for (const name of ['Turn back on', 'Keep off']) {
      const button = within(card).getByRole('button', { name });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(button);
    }
    await expect(args.onTurnBackOn).not.toHaveBeenCalled();
    await expect(args.onKeepOff).not.toHaveBeenCalled();
  },
};

export const ChangedAgain: Story = {
  args: { error: changedRefund.conflict },
  parameters: { canvasNote: 'The review after the tool changed again while the owner was reviewing; no board draws it.' },
  play: async ({ args, canvas, userEvent, canvasElement }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expect(canvas.getByRole('alert')).toHaveTextContent(changedRefund.conflict);
    // The answers work again, still naming the reviewed definition.
    await userEvent.click(canvas.getByRole('button', { name: 'Turn back on' }));
    await expect(args.onTurnBackOn).toHaveBeenCalledWith(reviewedHash);
  },
};

export const NoHash: Story = {
  args: { profile: { ...changed, pending_sha256: null } },
  parameters: { canvasNote: "A changed tool whose new definition has no hash; no board draws it. Without the hash there's nothing to confirm." },
  play: async ({ args, canvas, userEvent, canvasElement }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    // no_hash_no_confirm: both answers are disabled, under the notice.
    const notice = canvas.getByText(NO_HASH);
    await expect(notice).toBeVisible();
    await expect(canvas.queryByText(TRUST_LINE)).toBeNull();
    for (const name of ['Turn back on', 'Keep off']) {
      const button = canvas.getByRole('button', { name });
      await expect(button).toBeDisabled();
      await expect(button.getBoundingClientRect().top).toBeGreaterThan(notice.getBoundingClientRect().bottom);
      await userEvent.click(button);
    }
    await expect(args.onTurnBackOn).not.toHaveBeenCalled();
    await expect(args.onKeepOff).not.toHaveBeenCalled();
  },
};

export const NoDefinitionText: Story = {
  args: { profile: { ...changed, pending_definition_text: null } },
  parameters: { canvasNote: "A changed tool whose new definition wasn't kept; no board draws it. With nothing to review, nothing can be confirmed." },
  play: async ({ canvas, canvasElement }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expect(canvas.getByText(NO_HASH)).toBeVisible();
    await expect(canvasElement.querySelector('blockquote')).toBeNull();
    for (const name of ['Turn back on', 'Keep off']) await expect(canvas.getByRole('button', { name })).toBeDisabled();
  },
};

/** no_text_no_confirm: a definition with nothing in it is nothing to review, so nothing can be answered. */
async function expectNothingToReview(canvas: Parameters<NonNullable<Story['play']>>[0]['canvas'], canvasElement: HTMLElement) {
  await expect(canvas.getByText(NO_HASH)).toBeVisible();
  await expect(canvas.queryByText(TRUST_LINE)).toBeNull();
  await expect(canvasElement.querySelector('blockquote')).toBeNull();
  for (const name of ['Turn back on', 'Keep off']) await expect(canvas.getByRole('button', { name })).toBeDisabled();
}

export const EmptyDefinitionText: Story = {
  args: { profile: { ...changed, pending_definition_text: '' } },
  parameters: { canvasNote: 'A changed tool whose new definition came back empty; no board draws it. With nothing to review, nothing can be confirmed.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expectNothingToReview(canvas, canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Turn back on' }));
    await expect(args.onTurnBackOn).not.toHaveBeenCalled();
  },
};

export const BlankDefinitionText: Story = {
  args: { profile: { ...changed, pending_definition_text: '  \n\t ' } },
  parameters: { canvasNote: 'A changed tool whose new definition is only spaces and line breaks; no board draws it. With nothing to review, nothing can be confirmed.' },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await expectNothingToReview(canvas, canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Keep off' }));
    await expect(args.onKeepOff).not.toHaveBeenCalled();
  },
};

export const IndentedDefinition: Story = {
  args: { profile: { ...changed, pending_definition_text: `\n  ${changed.pending_definition_text}\n` } },
  parameters: { canvasNote: 'A changed definition that starts and ends with blank space; no board draws it. The quote keeps the text exactly as sent.' },
  play: async ({ args, canvasElement }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    // The quote is the connector's words exactly as sent, leading and trailing space included.
    const text = canvasElement.querySelector('blockquote [data-copy="user"]');
    await expect(text?.textContent).toBe(args.profile.pending_definition_text);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvasNote: 'The review on a phone; no board draws it. The quoted definition wraps inside its box.' },
  play: async ({ canvasElement }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    const width = window.innerWidth;
    await expect(width).toBe(390);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};
