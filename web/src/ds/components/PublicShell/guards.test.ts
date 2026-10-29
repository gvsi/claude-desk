import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { aboutLinkHref, brandColor } from './guards.ts';
import { PublicShell, type PublicShellProps } from './PublicShell.tsx';

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
    expect(aboutLinkHref('/d/rivera-plumbing-k3x9q2/agents')).toBe('/d/rivera-plumbing-k3x9q2/agents');
    expect(aboutLinkHref('/d/rivera-plumbing-k3x9q2/agents#send')).toBe('/d/rivera-plumbing-k3x9q2/agents#send');
    // A scheme, another host, a backslash or whitespace is no link at all.
    for (const href of ['javascript:alert(1)', '//elsewhere.example/x', '/\\elsewhere.example', 'https://elsewhere.example', 'data:text/html,x', 'agents', '/d/x y', '', ' /d/x']) {
      expect(aboutLinkHref(href), href).toBeNull();
    }
  });

  it('no_free_text_header_line', () => {
    // Everything a visitor reads comes from the kernel or is the shell's own static copy. A header
    // status line was a free-text slot outside both, which a screen could fill with a time or an
    // amount worked out on the page, so the shell has none.
    expectTypeOf<PublicShellProps>().not.toHaveProperty('statusLine');
    const props = {
      brand: { name: 'Rivera Plumbing', tagline: 'Main line', monogram: 'R', field: '#1F4E4A', ink: '#ffffff', inkSecondary: '#e6e6e6', accent: '#B87333' },
      ownerName: 'Maria Rivera',
      language: 'en',
      onAskForOwner: () => {},
      composer: null,
      children: null,
      statusLine: 'Open until 6:00 pm',
    } as PublicShellProps;
    const markup = renderToStaticMarkup(createElement(PublicShell, props));
    expect(markup).toContain('Rivera Plumbing');
    expect(markup).not.toContain('Open until');
  });
});

