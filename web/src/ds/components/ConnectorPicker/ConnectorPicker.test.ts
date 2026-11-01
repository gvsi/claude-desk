import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { ConnectorPicker } from './ConnectorPicker.tsx';

// This copy test renders static markup; opening the dialog belongs to its browser tests.
vi.mock('../Dialog/useModalDialog.ts', () => ({ useModalDialog: () => ({}) }));

it('does not double a business name’s sentence stop in the introduction', () => {
  const cases = [
    ['Chen & Co.', 'Add what fits Chen & Co.'],
    ['Acme!', 'Add what fits Acme!'],
    ['Who?', 'Add what fits Who?'],
    ['Turner Plumbing', 'Add what fits Turner Plumbing.'],
    ['<b>Chen</b> & Co.', 'Add what fits <b>Chen</b> & Co.'],
  ] as const;
  for (const [business, lead] of cases) {
    const root = document.createElement('div');
    root.innerHTML = renderToStaticMarkup(createElement(ConnectorPicker, {
      business, builtIn: [], external: [], onChoose: () => {}, onClose: () => {},
    }));
    const intro = root.querySelector('.cd-connector-picker__intro');
    expect(intro?.textContent).toBe(`${lead} Each tool you add starts at Ask me first unless one of your rules already covers it, and you review them before anything turns on.`);
    expect(intro?.querySelector('b')).toBeNull();
  }
});
