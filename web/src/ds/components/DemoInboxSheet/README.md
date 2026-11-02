# DemoInboxSheet

`DemoInboxSheet` is the Demo inbox where there is no room for it beside the page: a "Demo inbox" button with a count, which opens `DemoInboxPanel` in a modal sheet.

## When to use

- On the public page below 1280 px, with `viewer="visitor"`, where the inbox can't be a column beside the chat. The sheet rises from the bottom and opens itself when the first code arrives.
- With `viewer="owner"`, the owner's codes and alerts, as N-R2-Inbox-Sheet-Owner draws it: a 400 px column at the right, which the owner opens. The owner app no longer uses it: its notifications have their own page (REV-NOTIF). The owner's sheet stays for that board.
- Not at 1280 px and wider on the public page, where `DemoInboxPanel` sits beside the chat on its own.

## What the consumer provides

- What `DemoInboxPanel` takes: `viewer`, `items` in the order they arrived, `language` and `onRetry`. The sheet passes them on unchanged, so its rules hold here too: codes come only from fetched `DemoInboxEntry` bodies, and a visitor never sees the owner's alerts or checkpoints, nor counts them.
- Where the button goes. The sheet opens over the page wherever the button is.
- `notice`, when the screen has something to say about the inbox itself, such as that the latest read failed: an error `Notice` with its own Try again. It sits inside the sheet under the subtitle and above the entries, so the owner doesn't take the entries for the current ones while the page behind is inert. The screen keeps drawing it outside the sheet too when the sheet is closed.
- `onOpenChange`, to hear the sheet open and close, whatever did it (the button, the sheet opening itself, Escape, Close, a link inside, or the screen taking an open sheet away), instead of watching the page for an open dialog. It is called on each change only, not when the sheet first draws closed.

## What it shows

- The button: a secondary `Button`, "Demo inbox" / "Bandeja de demostración", with a `CountPill` 8 px after the words when there is something to read. The count is the entries the viewer may see, one per entry, and it is read with the button's name: "Demo inbox 1 entry".
- The sheet: a native modal `dialog` on `bg-surface`, over the page dimmed by `scrim`, named "Demo inbox". The panel's title has "Close" (a ghost button) at the right of its line; the panel takes the sheet's ground. For the owner the panel's subtitle is "What Claude would have sent you by text or email. Nothing is really sent."
  - A visitor's: from the bottom, the window's width, its top edge ruled in `line-card` and rounded at `radius-card`, at most the window's height less 40 px, scrolling inside. Padded 16 px over Close and at the sides, 24 px under the last entry.
  - The owner's: at the right, `min(400px, 100%)` wide and the window's height, ruled at its left in `line-card`. Padded 24 px.
- It appears in place; nothing slides or fades.

## Opening and closing

- A visitor's sheet opens itself once, when the first entry the visitor may see arrives (the count goes from nothing to something). A later entry only raises the count. An owner's alert in the items opens nothing, and isn't counted. Opening and closing the empty sheet before anything arrives doesn't use up that one opening.
- The button opens it at any time.
- Opened from the button, focus moves to Close. Opened by itself, focus moves to the sheet's heading (`tabIndex={-1}`), so the visitor's next keystroke, perhaps meant for the chat, doesn't press Close. Either way it stays inside the sheet; the page behind is inert (`showModal()`). Escape, Close, or the browser's own close request (a back gesture) closes it, and focus goes back to what had it: the button, or, when the sheet opened itself, where the visitor was typing. Following a link inside, such as "Open the request" under an owner's alert, closes it too, so it isn't left over the page the link opens. If what had focus inside goes while the sheet stays open, such as the notice's Try again once a read works, focus moves to the sheet's heading rather than out of the sheet.
- The open and close behavior is Dialog's `useModalDialog`, the same modal mechanism the Connectors change's picker and sign-in use.

## Copy (`inboxCopy.ts`)

| | English | Spanish |
| --- | --- | --- |
| Close | Close | Cerrar |
| Count | 1 entry, {n} entries | 1 entrada, {n} entradas |

The button and the sheet's name use the panel's title. Everything else is the panel's.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `viewer` | `'owner' \| 'visitor'` | Required. A visitor's sheet rises from the bottom and opens itself; the owner's is at the right. |
| `items` | `DemoInboxItem[]` | Required. Oldest first. |
| `language` | `'en' \| 'es'` | Required. |
| `onRetry` | `(entryId: string) => void` | Required. |
| `notice` | `ReactNode` | A line inside the sheet, under the subtitle and above the entries. |
| `onOpenChange` | `(open: boolean) => void` | Called when the sheet opens (`true`) or closes (`false`). |
