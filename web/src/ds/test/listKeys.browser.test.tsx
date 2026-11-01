/**
 * Lists of the screen's lines keep a key per item even when two lines read the same: two rules
 * with the same reason, or a check repeated. Keyed by text alone, React would warn that two
 * children share a key and could drop or reuse one when the list changes.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';

import { Breadcrumb } from '../components/Breadcrumb/Breadcrumb.tsx';
import { ChangeReview } from '../components/ChangeReview/ChangeReview.tsx';
import { ConnectionPanel } from '../components/ConnectionPanel/ConnectionPanel.tsx';
import { ConnectorReview } from '../components/ConnectorReview/ConnectorReview.tsx';
import { chen, rivera } from '../fixtures/index.ts';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  consoleError.mockRestore();
});

/** React's warnings about two children with the same key, from this test's renders. */
function sameKeyWarnings(): unknown[][] {
  return consoleError.mock.calls.filter((call: unknown[]) => call.some((part: unknown) => String(part).includes('same key')));
}

function itemsReading(text: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('li, p')].filter((el) => el.textContent?.trim() === text);
}

it('change_review_checks_keep_a_key_each', () => {
  const line = 'Always-on rules still hold.';
  act(() =>
    root.render(<ChangeReview rows={[]} hasOtherChanges checks={{ status: 'checked', lines: [line, line] }} onConfirm={() => undefined} onCancel={() => undefined} />),
  );
  expect(itemsReading(line)).toHaveLength(2);
  expect(sameKeyWarnings()).toEqual([]);
});

it('connection_panel_confirm_keeps_a_key_each', () => {
  const tool = 'Payment link';
  const rule = 'Payments up to $300 go through.';
  act(() =>
    root.render(
      <ConnectionPanel
        connector={rivera.connectors.views.payments}
        off={{ kind: 'turn_off', consequence: rivera.paymentsConnection.consequence, stops: { tools: [tool, tool], rules: [rule, rule] }, onTurnOff: () => undefined }}
      />,
    ),
  );
  const open = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Turn off Payments');
  if (!open) throw new Error('No Turn off button');
  act(() => open.click());
  expect(itemsReading(tool)).toHaveLength(2);
  expect(itemsReading(rule)).toHaveLength(2);
  expect(sameKeyWarnings()).toEqual([]);
});

it('connector_review_coverage_keeps_a_key_each', () => {
  const text = 'No money moves without your rule or a signed limit';
  act(() =>
    root.render(
      <ConnectorReview
        connector={chen.connectors.views.payments}
        tools={[
          {
            key: 'native.payment_link',
            name: 'Payment link',
            description: "Makes a one-time link for a quote. Charges money. Can't be undone.",
            mode: 'ask',
            coveredBy: [
              { text, mode: 'always_on' },
              { text, mode: 'always_on' },
            ],
          },
        ]}
        onTurnOn={() => undefined}
        onCancel={() => undefined}
      />,
    ),
  );
  expect(itemsReading(`Covered by your always-on rule: ${text}`)).toHaveLength(2);
  expect(sameKeyWarnings()).toEqual([]);
});

it('breadcrumb_keeps_a_step_by_its_key', () => {
  // A trail whose steps carry their own keys: when a step is added above them, each keeps its own
  // element, so React never hands one step's element to another.
  const page = { key: 'page', label: 'Change your payment limit' };
  act(() => root.render(<Breadcrumb items={[{ key: 'rules', label: 'Rules', href: '/rules' }, page]} />));
  const before = container.querySelector('[aria-current="page"]')?.closest('li');
  act(() => root.render(<Breadcrumb items={[{ key: 'desk', label: 'Rivera Plumbing', href: '/' }, { key: 'rules', label: 'Rules', href: '/rules' }, page]} />));
  const after = container.querySelector('[aria-current="page"]')?.closest('li');
  expect(after?.textContent).toContain('Change your payment limit');
  expect(after).toBe(before);
  expect(sameKeyWarnings()).toEqual([]);
});
