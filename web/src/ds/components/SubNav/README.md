# SubNav

`SubNav` lists the pages of one section, such as Settings, with the page the owner is on marked.

## When to use

- In Settings, beside its pages: General, Notifications, Channels and Billing. Connectors have their own tab, so Settings lists no Integrations or Connectors page.
- Not for the app's own pages, which are the `Sidebar`'s, and not for a trail back up, which is a `Breadcrumb`.

## What it shows

- A `nav` named by `label`, holding a list of links in `.cd-type-control`.
- Vertical rows like the sidebar's, 2 px apart: `size-nav-row` (36 px) tall, at `radius-control`, 10 px in from each side, in `text-secondary`. A hovered row takes `fill-hover`; the current one is `text-primary` on `bg-selected`, with no accent bar, and `aria-current="page"`. N-Run2-Settings-General draws it `size-sub-nav` (200 px) wide, 40 px from the page's content.
- Under 768 px, where the app shell drops its sidebar, the rows become one line, 4 px apart, that scrolls sideways inside itself, so the page never does. As N-Run2-Settings-Phone draws it, the line runs edge to edge across the page's gutters, its first link at the gutter, over a `line-hairline` 4 px under the links. The gutter is the custom property `--cd-sub-nav-bleed`, `space-16` by default (a phone page's gutter); a page with other gutters sets it on SubNav or a parent, such as `--cd-sub-nav-bleed: var(--space-24)`. The scroller reaches 4 px above the links, so a focused link's ring is never clipped.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. Names the navigation: "Settings". |
| `items` | `{ key: string; label: string; href: string }[]` | Required, in order. |
| `current` | `string` | Required. The `key` of the page the owner is on. |
| `linkComponent` | `ComponentType<SidebarLinkProps>` | The app's router link; a plain `<a>` by default. |
