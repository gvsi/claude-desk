import { describe, expect, it } from 'vitest';

import { aboutLinkHref, brandColor } from './guards.ts';

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
});
