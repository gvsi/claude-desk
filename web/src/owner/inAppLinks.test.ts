import type { MouseEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { followInAppLinks } from './inAppLinks.ts';

/** A plain left click on a link with `href` inside a page container, as React hands it over. */
function clickOn(href: string) {
  const container = document.createElement('div');
  const link = document.createElement('a');
  link.setAttribute('href', href);
  container.append(link);
  const preventDefault = vi.fn();
  const event = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: link,
    currentTarget: container,
    preventDefault,
  } as unknown as MouseEvent<HTMLElement>;
  const navigate = vi.fn();
  followInAppLinks(navigate)(event);
  return { navigate, preventDefault };
}

describe('followInAppLinks', () => {
  it('routes_a_path_on_this_site', () => {
    const { navigate, preventDefault } = clickOn('/app/desk-1/conversations/ses-1?from=today#row-2');
    expect(navigate).toHaveBeenCalledWith('/app/desk-1/conversations/ses-1?from=today#row-2');
    expect(preventDefault).toHaveBeenCalled();
  });

  it('leaves_other_sites_to_the_browser', () => {
    for (const href of ['//evil.example/x', '/\\evil.example/x', '/\\/evil.example', 'https://evil.example/x', 'mailto:a@b.example']) {
      const { navigate, preventDefault } = clickOn(href);
      expect(navigate, href).not.toHaveBeenCalled();
      expect(preventDefault, href).not.toHaveBeenCalled();
    }
  });
});
