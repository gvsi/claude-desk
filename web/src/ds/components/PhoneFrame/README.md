# PhoneFrame

`PhoneFrame` draws a phone on a page, a captioned screen that holds an app's page, and `PhoneTabBar` is the owner app's five tabs at the foot of that screen.

## When to use

- On the phone vision page (N-R2-Vision-Phone), which shows the owner's Today and a visitor's chat as phone apps, side by side, each in its own `PhoneFrame`.
- Not for the real app on a phone: the owner app on a phone is `AppShell`'s compact layout, and the public page is `PublicShell` at the window's width. The frame is a picture of an app that isn't built.

## PhoneFrame

- A `figure` named by its `caption` (through `aria-labelledby`, so every screen reader says it), with the caption 12 px under the screen in secondary `meta`, centered.
- The screen: 390 by 780 px on `bg-app`, a 1 px `line-card` outline with a phone's 44 px corners, its content clipped to them. It is a flex column: the consumer lays out the page (it scrolls or is cut off at the foot, as a phone would) and puts a `PhoneTabBar` or a visitor's composer last.
- In a window narrower than 390 px the screen narrows to fit, so nothing scrolls sideways.

## PhoneTabBar

- A `nav` named "Main" with five links, in this order: Today, Chats, Rules, Safety and More, each a 20 px icon over its name in `caption`. More uses the settings icon, as the board draws it, and holds the pages that don't get a tab: Connectors, Customers, Share and Settings. The board doesn't draw what More opens.
- The current tab is `aria-current="page"` in `text-primary`; the others are `text-secondary`. The icons are `aria-hidden`: the names say where each goes.
- On `bg-panel` with a `line-hairline` over it, padded 10 px 8 px 22 px (the last for a phone's home bar), the tabs spaced around the width.

## What the consumer provides

- `PhoneFrame`: `caption`, what the phone shows ("Today, for the owner", "The public chat, for a visitor"), and the screen's content as `children`.
- `PhoneTabBar`: `current`, the tab the page is, and `hrefs`, where each tab goes.

## Props

`PhoneFrame`:

| Prop | Type | Notes |
| --- | --- | --- |
| `caption` | `string` | Required. Under the screen, and the figure's name. |
| `children` | `ReactNode` | Required. The screen's content, a flex column. |

`PhoneTabBar`:

| Prop | Type | Notes |
| --- | --- | --- |
| `current` | `'today' \| 'chats' \| 'rules' \| 'safety' \| 'more'` | Required. Marked `aria-current="page"`. |
| `hrefs` | `Record<PhoneTab, string>` | Required. Each tab's link. |
