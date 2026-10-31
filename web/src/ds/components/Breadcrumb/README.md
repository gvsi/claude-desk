# Breadcrumb

`Breadcrumb` shows where a connector's or a tool's page sits under Connectors, and links back up: "Connectors / Stripe / Refund".

## When to use

- At the top of a connector's page ("Connectors / Payments"), a tool's page ("Connectors / Stripe / Refund") and the add-a-connector pages ("Connectors / Google Calendar"), as the Connectors tab boards draw them.
- At the top of a review reached from Rules, naming the page by its title: "Rules / Ask me first" for a preset, "Rules / Change your payment limit" for the payment limit.
- Not on the Connectors page or the Rules page themselves, which are the tops of their trails, and not in Settings.

## What it shows

- A `nav` named "Breadcrumb" holding an ordered list, in `.cd-type-meta`.
- Every item but the last is a link back up, in `accent-blue` with the quiet underline `TextLink` draws.
- The last item is the page itself: plain `text-primary` text with `aria-current="page"`.
- Between items, the boards' "/" in `text-tertiary`, 8 px from each side, `aria-hidden`, so a screen reader hears only the names.
- A long trail wraps onto a second line rather than scrolling sideways.
- A name someone chose (a customer's, a business's) in a label is the screen's to mark as user text: pass the label as a node with the name in its own `<span data-copy="user">`. The rest of the trail stays the screen's words.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `items` | `{ label: ReactNode; href?: string }[]` | Required, from the top down, ending with the page. A label is usually a string; it is a node when it holds a name to mark as user text. An item before the last with no `href` shows as plain text. |
| `linkComponent` | `ComponentType<RulesLinkProps>` | The app's router link; a plain `<a>` by default. |
