# SubNav

`SubNav` lists the pages of one section, such as Settings, with the page the owner is on marked.

## When to use

- In Settings, beside its pages: General, Knowledge, Notifications, Channels and Billing. Connectors live only under Rules, so Settings lists no Integrations or Connectors page.
- Not for the app's own pages, which are the `Sidebar`'s, and not for a trail back up, which is a `Breadcrumb`.

## What it shows

- A `nav` named by `label`, holding a list of links in `.cd-type-control`.
- Vertical rows like the sidebar's: `size-nav-row` (36 px) tall, at `radius-control`, 10 px in from each side. A hovered row takes `fill-hover`; the current one `bg-selected`, with no accent bar, and `aria-current="page"`.
- Under 768 px, where the app shell drops its sidebar, the rows become one line that scrolls sideways inside itself, so the page never does.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. Names the navigation: "Settings". |
| `items` | `{ key: string; label: string; href: string }[]` | Required, in order. |
| `current` | `string` | Required. The `key` of the page the owner is on. |
| `linkComponent` | `ComponentType<SidebarLinkProps>` | The app's router link; a plain `<a>` by default. |
