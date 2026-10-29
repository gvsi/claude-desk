import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { Button, type ButtonProps } from './Button.tsx';

describe('Button props', () => {
  it('a_link_never_opens_a_menu', () => {
    // A menu button is a button: a link can't open a menu or take a button's keys.
    expectTypeOf<{ variant: 'secondary'; menuOpen: false; children: string }>().toExtend<ButtonProps>();
    expectTypeOf<{ variant: 'secondary'; href: string; children: string }>().toExtend<ButtonProps>();
    expectTypeOf<{ variant: 'secondary'; href: string; menuOpen: boolean; children: string }>().not.toExtend<ButtonProps>();
    expectTypeOf<{ variant: 'secondary'; href: string; onKeyDown: () => void; children: string }>().not.toExtend<ButtonProps>();

    // A link that gets one anyway has neither a menu button's look nor its attributes.
    const forced = { variant: 'secondary', href: '/pay/k7Hq2vX9', menuOpen: true, children: 'Open payment page' } as unknown as ButtonProps;
    const html = renderToStaticMarkup(createElement(Button, forced));
    expect(html).toContain('<a ');
    expect(html).not.toContain('cd-button--menu');
    expect(html).not.toContain('aria-haspopup');
    expect(html).not.toContain('<svg');
  });

  it('only_a_link_opens_a_new_tab', () => {
    // `external` needs a link, and like `href` it never goes with a menu.
    expectTypeOf<{ variant: 'secondary'; href: string; external: true; children: string }>().toExtend<ButtonProps>();
    expectTypeOf<{ variant: 'secondary'; external: true; children: string }>().not.toExtend<ButtonProps>();
    expectTypeOf<{ variant: 'secondary'; external: true; menuOpen: false; children: string }>().not.toExtend<ButtonProps>();
    expectTypeOf<{ variant: 'secondary'; href: string; external: true; menuOpen: false; children: string }>().not.toExtend<ButtonProps>();
  });
});
