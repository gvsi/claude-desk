import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { PublicDesk } from '../../../api/contracts.ts';
import { aboutLinkHref, brandColor, openStatusLine } from './guards.ts';
import { PublicShell, type PublicOpenStatus, type PublicShellProps } from './PublicShell.tsx';

describe('PublicShell guards', () => {
  it('brand_colors_are_hex_or_tokens', () => {
    expect(brandColor('#1F4E4A', 'var(--bg-panel)')).toBe('#1F4E4A');
    expect(brandColor(' #b87333 ', 'var(--line-hairline)')).toBe('#b87333');
    expect(brandColor('var(--text-primary)', 'var(--text-secondary)')).toBe('var(--text-primary)');
    // Anything else falls back: it could load a resource or reach past its property.
    for (const value of ['url(https://x)', 'red; x', 'red', '#fff', '#1f4e4a80', 'var(--a), url(x)', 'rgb(0,0,0)', '', 'expression(x)']) {
      expect(brandColor(value, 'var(--bg-panel)'), value).toBe('var(--bg-panel)');
    }
  });

  it('about_links_stay_on_this_site', () => {
    expect(aboutLinkHref('/d/turner-plumbing-k3x9q2/agents')).toBe('/d/turner-plumbing-k3x9q2/agents');
    expect(aboutLinkHref('/d/turner-plumbing-k3x9q2/agents#send')).toBe('/d/turner-plumbing-k3x9q2/agents#send');
    // A scheme, another host, a backslash or whitespace is no link at all.
    for (const href of ['javascript:alert(1)', '//elsewhere.example/x', '/\\elsewhere.example', 'https://elsewhere.example', 'data:text/html,x', 'agents', '/d/x y', '', ' /d/x']) {
      expect(aboutLinkHref(href), href).toBeNull();
    }
  });

  it('open_status_is_whole_or_absent', () => {
    expect(openStatusLine({ text: 'Open now, until 6:00 pm', open: true })).toEqual({ text: 'Open now, until 6:00 pm', open: true });
    expect(openStatusLine({ text: 'Cerrado ahora. Abre el lunes a las 8:00', open: false })).toEqual({
      text: 'Cerrado ahora. Abre el lunes a las 8:00',
      open: false,
    });
    // Only the words and the dot reach the header, the words exactly as the kernel wrote them.
    const fromKernel = { open: true, text: ' Open now ', until: null, as_of: '2026-10-29T10:00:00-07:00' };
    expect(openStatusLine(fromKernel)).toEqual({ text: ' Open now ', open: true });
    // Anything else is no line: a dot with no words, or a dot that could disagree with its words.
    const malformed = [
      undefined,
      null,
      'Open now',
      { text: '', open: true },
      { text: '  ', open: false },
      { text: 'Open now' },
      { text: 'Open now', open: 'true' },
      { text: 'Closed now. Opens Monday at 8:00 am', open: 0 },
      { text: 42, open: true },
      { open: false },
    ];
    for (const value of malformed) expect(openStatusLine(value), JSON.stringify(value)).toBeNull();
  });

  it('no_free_text_header_line', () => {
    // Everything a visitor reads comes from the kernel or is the shell's own static copy. A free-text
    // header line would be a slot outside both, which a screen could fill with a time or an amount
    // worked out on the page, so the shell has none. Its one status line is the kernel's open
    // status, `PublicDesk.open_status` as served, of which it reads the words and the boolean.
    expectTypeOf<PublicShellProps>().not.toHaveProperty('statusLine');
    expectTypeOf<PublicShellProps['openStatus']>().toEqualTypeOf<PublicDesk['open_status'] | undefined>();
    const base: PublicShellProps = {
      brand: { name: 'Turner Plumbing', tagline: 'Main line', monogram: 'T', field: '#1F4E4A', ink: '#ffffff', inkSecondary: '#e6e6e6', statusHandled: '#6fa859', accent: '#B87333' },
      ownerName: 'Mike Turner',
      language: 'en',
      onAskForOwner: () => {},
      composer: null,
      children: null,
    };
    const render = (props: PublicShellProps) => renderToStaticMarkup(createElement(PublicShell, props));

    const freeText = render({ ...base, statusLine: 'Open until 6:00 pm' } as PublicShellProps);
    expect(freeText).toContain('Turner Plumbing');
    expect(freeText).not.toContain('Open until');

    // The kernel's words, exactly once and exactly as written.
    const kernelLine = render({
      ...base,
      openStatus: {
        open: true,
        until: '2026-10-29T18:00:00-07:00',
        opens_at: null,
        text: 'Open now, until 6:00 pm',
        as_of: '2026-10-29T10:00:00-07:00',
        refresh_at: '2026-10-29T18:00:00-07:00',
      },
    });
    expect(kernelLine.split('Open now, until 6:00 pm')).toHaveLength(2);

    // A Desk without hours: the kernel sends null, passed straight through, and there is no line.
    const noHours = render({ ...base, openStatus: null });
    expect(noHours).not.toContain('cd-public-shell__open-status');
    expect(noHours).not.toContain('cd-status-dot');

    // A status that isn't whole draws neither words nor a dot.
    const broken = render({ ...base, openStatus: { text: 'Open now', open: 'yes' } as unknown as PublicOpenStatus });
    expect(broken).not.toContain('Open now');
    expect(broken).not.toContain('cd-status-dot');
  });
});
