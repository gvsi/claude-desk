import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { SETUP_COPY } from './copy.ts';
import { aroundBusiness, changeSomethingPath, opensSetupChat, setupPath } from './shared.ts';

it('avoids a second sentence stop after a business name while preserving the name and other copy', () => {
  const cases: readonly [string, readonly string[], string][] = [
    ['Chen & Co.', SETUP_COPY.situations.subtitle, 'How your rules will handle things that really happen at Chen & Co. Nothing here is real.'],
    ['Acme!', SETUP_COPY.situations.subtitle, 'How your rules will handle things that really happen at Acme! Nothing here is real.'],
    ['Who?', SETUP_COPY.situations.subtitle, 'How your rules will handle things that really happen at Who? Nothing here is real.'],
    ['Chen & Co.  ', SETUP_COPY.situations.subtitle, 'How your rules will handle things that really happen at Chen & Co.   Nothing here is real.'],
    ['Rivera Plumbing', SETUP_COPY.situations.subtitle, 'How your rules will handle things that really happen at Rivera Plumbing. Nothing here is real.'],
    ['', SETUP_COPY.situations.subtitle, 'How your rules will handle things that really happen at your business. Nothing here is real.'],
    ['Chen & Co.', SETUP_COPY.tools.subtitle, `${SETUP_COPY.tools.subtitle[0]}Chen & Co.${SETUP_COPY.tools.subtitle[1]}`],
    ['Acme!', ['Before ', '.. After'], 'Before Acme!. After'],
    ['<script>alert(1)</script>.', SETUP_COPY.situations.subtitle, 'How your rules will handle things that really happen at <script>alert(1)</script>. Nothing here is real.'],
  ];

  for (const [business, copy, expected] of cases) {
    const line = document.createElement('div');
    line.innerHTML = renderToStaticMarkup(aroundBusiness(copy, business));
    expect(line.textContent, business).toBe(expected);
    expect(line.querySelector('script')).toBeNull();
    expect(line.querySelector('[data-copy="user"]')?.textContent ?? null).toBe(business === '' ? null : business);
  }
});

it('leads "Change something" to the setup chat on the same interview, and back to its step', () => {
  expect(setupPath('i1')).toBe('/app/setup/i1');
  expect(changeSomethingPath('i1')).toBe('/app/setup/i1?chat');
  // An id is a path segment, never a way out of setup's path.
  expect(changeSomethingPath('a/../b?x')).toBe('/app/setup/a%2F..%2Fb%3Fx?chat');
  expect(opensSetupChat(new URLSearchParams('chat'))).toBe(true);
  expect(opensSetupChat(new URLSearchParams('chat=1'))).toBe(true);
  expect(opensSetupChat(new URLSearchParams(''))).toBe(false);
  expect(opensSetupChat(new URLSearchParams('chatty'))).toBe(false);
});
