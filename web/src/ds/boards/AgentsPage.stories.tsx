import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { AgentOutcome } from '../../api/contracts.ts';
import { AGENT_CARD_BLOCKS } from '../../mocks/agents.ts';
import { CodeBlock } from '../components/CodeBlock/CodeBlock.tsx';
import { CopyField } from '../components/CopyField/CopyField.tsx';
import { OUTCOME_TONE } from '../components/OutcomeMenu/outcomeWords.ts';
import { StatusLabel, type StatusTone } from '../components/StatusDot/StatusDot.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { FONT_TIMEOUT, withinDeadline } from '../test/fonts.ts';
import { AgentsCard, AgentsFrame, brandOf } from './parts.tsx';
import { SPEC, expectAgentsDisclosure, expectFooter, expectFooterAtFoot, expectTabOrder, one } from './spec.ts';

import '../../public/agents/AgentCardPage.css';

/** The live page's ABILITY_TONE: the rules' dots beside the kernel's outcome words. */
const ABILITY_TONE = {
  allowed: OUTCOME_TONE.auto,
  asks_first: OUTCOME_TONE.ask,
  never: OUTCOME_TONE.never,
} as const satisfies Record<AgentOutcome, StatusTone>;

/** The example request, as the board writes it: the A2A contract's endpoint, headers and body. */
const REQUEST = [
  'POST /api/a2a/rivera',
  'X-Agent-Key-Id: demo-7f3a2c',
  'X-Agent-Ts: 2026-10-30T09:12:04Z',
  'X-Agent-Nonce: 7c2e91d4',
  'X-Agent-Sig: <Ed25519 signature, lowercase hex>',
  '',
  '{"desk_slug": "rivera", "message": "Earliest visit for a leaking water heater"}',
].join('\n');

/** How a request is signed, in the AgentAuth contract's terms, as the board writes it. */
const SIGNING = [
  'Headers: X-Agent-Key-Id, X-Agent-Ts, X-Agent-Nonce, X-Agent-Sig',
  'Payload fields: desk_slug, ts, nonce, body_sha256',
  'Canonical form: RFC 8785 JSON',
  'Algorithm: Ed25519',
  'Encoding: lowercase hex',
  'Time window: 5 minutes',
];

/**
 * The card’s ten abilities, in the order redrawn on 2026-11-02, the two customer lines with the
 * kernel’s straight apostrophe (canvas v380).
 */
const ABILITIES = [
  'Get a quote from the price list',
  'Find open times',
  'Book a visit',
  'Get a payment link for a quote',
  'Pay for a quote within a signed limit',
  'Leave contact details',
  'Ask for a callback',
  'Verify a customer with a code sent to their contact on record',
  "Receive a verified customer's own documents",
  "List a verified customer's own charges",
];

/** Keep the board's ten words in order, with each fixture outcome visibly below its ability. */
async function expectAbilities(region: HTMLElement) {
  const items = within(region).getAllByRole('listitem');
  await expect(items.map((item) => one(item, '.cd-agents-page__ability-text').textContent)).toEqual(ABILITIES);
  await expect(items).toHaveLength(AGENT_CARD_BLOCKS.en.length);
  for (const [index, block] of AGENT_CARD_BLOCKS.en.entries()) {
    const item = items[index]!;
    const words = one(item, '.cd-agents-page__ability-text');
    const outcome = one(item, '.cd-agents-page__outcome');
    await expect(outcome.textContent).toBe(block.outcome_text);
    await expect(outcome).toBeVisible();
    await expect(outcome.querySelectorAll('.cd-status-dot')).toHaveLength(1);
    await expect(one(outcome, '.cd-status-dot')).toHaveClass('cd-status-dot--handled');
    await expect(outcome.getBoundingClientRect().top - words.getBoundingClientRect().bottom).toBe(8);
  }
}

function AgentsPage() {
  return (
    <AgentsFrame brand={brandOf(rivera.publicDesk.en)}>
      <AgentsCard title="What agents can do here">
        <ul className="cd-agents-page__abilities">
          {AGENT_CARD_BLOCKS.en.map((block, index) => (
            <li key={index} className="cd-agents-page__ability">
              <span className="cd-agents-page__ability-text cd-type-body">{block.text}</span>
              {block.outcome != null && block.outcome_text != null ? (
                <span className="cd-agents-page__outcome cd-type-meta">
                  <StatusLabel tone={ABILITY_TONE[block.outcome]}>{block.outcome_text}</StatusLabel>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </AgentsCard>
      <AgentsCard title="How agents prove who they are">
        <ul className="board-agents__list cd-type-meta">
          <li>Every request is signed with the agent’s own key and checked before anything else.</li>
          <li>Agents get what a public visitor gets, and pay only within a limit their owner’s wallet signed.</li>
          <li>To act for a customer on record, the agent asks for a code and sends it back as verify_code.</li>
          <li>No refunds go to agents.</li>
          <li>Every answer says it comes from Claude, an AI.</li>
        </ul>
      </AgentsCard>
      <AgentsCard title="Connect your own agent" lead="Connecting your own Claude means pointing an A2A client at this address. It isn’t a ready-made connector.">
        <CopyField value="https://desk.example/api/a2a/rivera" copyLabel="Copy address" layout="inline" language="en" onCopy={fn(async () => {})} />
        <ul className="board-agents__list board-agents__list--quiet cd-type-meta">
          {SIGNING.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <h3 className="board-agents__label cd-type-control">Example request</h3>
        <CodeBlock code={REQUEST} />
      </AgentsCard>
    </AgentsFrame>
  );
}

const meta = {
  title: 'Boards/Agents page',
  render: () => <AgentsPage />,
  // Redrawn at canvas v380: a 14-inch laptop's width and the full page's own 2200 px.
  globals: { viewport: { value: 'laptop-2200', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-R2-Agents-01-Page',
    canvasNote: [
      'Built against the board in review; sign-off pending.',
      'N-R2-Agents-01-Page and N-R2-Agents-06-Phone were redrawn at canvas v380 and match these stories at the new type scale: the full laptop page is 1512 × 2200 and the phone page is 390 × 2740. Each ability’s outcome sits under its words, with StatusLabel and the live page’s styles, as the live page has since #948. The ten abilities keep their order and words from the existing mock fixture, the two customer lines with the kernel’s straight apostrophe.',
      'The page for people’s AI agents, /d/:slug/agents: the public page’s brand header on its own (PublicBrandHeader), the endpoint as a CopyField with “Copy address”, and the example request as a CodeBlock, both in the code type.',
      'The column, its title and the cards’ lists are page layout the web app (plan 04) owns.',
      'The AI disclosure under the title is DisclosureLine, as the agents boards say it since a ruling on 2026-10-30; the v380 boards match its 19 px type and the larger title above it.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 2200]);
    await expectAgentsDisclosure(canvasElement);
    await withinDeadline(document.fonts.load('13px "JetBrains Mono"'), FONT_TIMEOUT, 'Agents page JetBrains Mono');
    // The brand header, 76 px with its rule, is the page's banner; the page's title is its one h1.
    const banner = canvas.getByRole('banner');
    await expect(Math.round(banner.getBoundingClientRect().height)).toBe(76);
    const title = canvas.getByRole('heading', { level: 1 });
    await expect(title).toHaveTextContent('Turner Plumbing for AI agents');
    expectComputed(title, SPEC.pageTitle);
    const main = canvas.getByRole('main');
    const column = one(main, '.board-agents__cards');
    await expect([Math.round(column.getBoundingClientRect().left), Math.round(column.getBoundingClientRect().width)]).toEqual([376, 760]);
    const abilities = canvas.getByRole('region', { name: 'What agents can do here' });
    await expectAbilities(abilities);

    // The endpoint on its line with Copy address at the card's right; the request in the code type.
    const connect = canvas.getByRole('region', { name: 'Connect your own agent' });
    const address = one(connect, '.cd-copy-field__value');
    await expect(address).toHaveTextContent('https://desk.example/api/a2a/rivera');
    expectComputed(address, { fontFamily: /^"JetBrains Mono"/, fontSize: '13px' });
    const copy = within(connect).getByRole('button', { name: 'Copy address' });
    await expect(Math.round(copy.getBoundingClientRect().right)).toBe(1119);
    // The address in its outlined box, below the ten abilities and their outcomes: from 393 px,
    // 32 px tall at 1306, measured with the live page's outcome rows at the new type scale;
    // ending 8 px before the button (597 px wide once the interface font has loaded).
    await withinDeadline(document.fonts.ready, FONT_TIMEOUT, 'Agents page fonts');
    const addressBox = address.getBoundingClientRect();
    await expect([Math.round(addressBox.left), Math.round(addressBox.top), Math.round(addressBox.height)]).toEqual([393, 1306, 32]);
    await expect(Math.round(copy.getBoundingClientRect().left - addressBox.right)).toBe(8);
    expectComputed(address, { borderTopColor: 'rgba(250, 249, 245, 0.36)', borderTopLeftRadius: '8px' });
    const request = one(connect, 'pre');
    await expect(request.textContent).toBe(REQUEST);
    // request_follows_the_a2a_contract: the API's endpoint, the four AgentAuth headers, then an
    // A2ARequest body with the Desk's slug and the message, nothing else.
    await expect(address).toHaveTextContent(/^https:\/\/desk\.example\/api\/a2a\/rivera$/);
    const [requestLine, ...rest] = REQUEST.split('\n');
    await expect(requestLine).toBe('POST /api/a2a/rivera');
    const blank = rest.indexOf('');
    await expect(rest.slice(0, blank).map((header) => header.split(':')[0])).toEqual(['X-Agent-Key-Id', 'X-Agent-Ts', 'X-Agent-Nonce', 'X-Agent-Sig']);
    await expect(Object.keys(JSON.parse(rest.slice(blank + 1).join('\n')) as object)).toEqual(['desk_slug', 'message']);
    // The signing lines name the same contract.
    await expect([...connect.querySelectorAll('li')].map((item) => item.textContent)).toEqual(SIGNING);
    // The card's inner width, and whole 20 px lines between 12 px above and below, at least one per
    // line of the request: a wider fallback font may wrap the longest one.
    await expect(Math.round(request.getBoundingClientRect().width)).toBe(726);
    const lines = (request.getBoundingClientRect().height - 24) / 20;
    await expect(Number.isInteger(lines)).toBe(true);
    await expect(lines).toBeGreaterThanOrEqual(REQUEST.split('\n').length);
    await expect(request.scrollWidth).toBeLessThanOrEqual(request.clientWidth);

    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
    await expectTabOrder(userEvent, [canvas.getByRole('link', { name: 'Back to the chat' }), copy]);
  },
};

export const Phone: Story = {
  // Redrawn at canvas v380: a phone's width and the full page's own 2740 px, its footer at the foot.
  globals: { viewport: { value: 'phone-2740', isRotated: false } },
  parameters: { canvas: 'N-R2-Agents-06-Phone' },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([390, 2740]);
    await withinDeadline(document.fonts.ready, FONT_TIMEOUT, 'Agents phone fonts');
    await expectAgentsDisclosure(canvasElement);
    const column = one(canvas.getByRole('main'), '.board-agents__cards');
    await expect([Math.round(column.getBoundingClientRect().left), Math.round(column.getBoundingClientRect().width)]).toEqual([16, 358]);
    const abilities = canvas.getByRole('region', { name: 'What agents can do here' });
    await expectAbilities(abilities);
    const connect = canvas.getByRole('region', { name: 'Connect your own agent' });
    const address = one(connect, '.cd-copy-field__value');
    const copy = within(connect).getByRole('button', { name: 'Copy address' });
    await expect(address).toHaveTextContent('https://desk.example/api/a2a/rivera');
    await expect(Math.round(copy.getBoundingClientRect().top - address.getBoundingClientRect().bottom)).toBe(8);
    const request = one(connect, 'pre');
    await expect(request.textContent).toBe(REQUEST);
    await expect(request.scrollWidth).toBeLessThanOrEqual(request.clientWidth);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);
    await expectTabOrder(userEvent, [canvas.getByRole('link', { name: 'Back to the chat' }), copy]);
  },
};
