# ChannelList

`ChannelList` shows where visitors reach a Desk, one row per channel, each saying how someone is known there.

## When to use

- On Settings › Channels (N-Run2-Settings-Channels, and N-R2-Vision-Channels under the vision bar), under the line "Where visitors reach this Desk. Each place proves who someone is in its own way; your rules apply everywhere."
- Only there. The rows are the owner's view of how the always-on baseline holds on each channel; the public link is the one the prototype runs.

## What it shows

- A `section` `Card` named "Channels", with no padding of its own, holding a list (`role="list"`) of six rows, in this order:

  | Channel | How someone is known there | Status |
  | --- | --- | --- |
  | Public link | "{publicLink}. Visitors confirm who they are with a code sent to their contact on record." | "On", beside a sage `StatusDot` |
  | Email | "Replies to your business address. The sender’s address is a hint, never proof: private data still needs a code." | `Pill` "Coming later" |
  | Website embed | "The same chat on your own site, with the same rules and the same disclosure." | `Pill` "Coming later" |
  | WhatsApp and iMessage | "The phone number is the contact on record when it matches; otherwise a code goes to the number you have." | `Pill` "Coming later" |
  | Slack | "For team Desks. A workspace member is known by their Slack account, within the rules you set." | `Pill` "Coming later" |
  | Voice | "Calls answered by Claude, an AI, which says so first. Private data still needs a code." | `Pill` "Coming later" |

- The words are fixed (`LATER_CHANNELS` holds the five that aren't built), word for word as both Channels boards write them: each restates the baseline (an address or a number is a hint until it matches the contact on record, private data needs a code, Claude says it's an AI), so a screen can't soften them.
- Nothing in a row is a control: no switch, link or button.

## What the consumer provides

- `publicLink`: the Desk's public link as the owner reads it, "desk.example/rivera".

## Layout

- Each row is padded 14 px 16 px, a `line-hairline` above every row but the first: the name in `body` type at weight 520, the line 2 px under it in secondary `meta`, and the status at the right, 16 px after the words, on one line. "On" is `meta` in primary ink, 8 px after its dot.
- On a narrow line the words wrap and the status keeps its place at the right.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `publicLink` | `string` | Required. Shown at the start of the public link's line. |

Also exported: `LATER_CHANNELS` and the `ChannelView` type.
