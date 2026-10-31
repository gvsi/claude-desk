# Notice

`Notice` is one quiet line about the state of things: a status dot, what happened and what to do, and the next step beside it.

## When to use

- `info` for something worth knowing that needs nothing ("Everything else overnight stayed inside your rules.").
- `waiting` while something is in progress ("Reconnecting to the chat").
- `error` when something failed, with what to do next ("That didn't send. Your message is still here; try again.").
- Not for a turn that ended silently, which shows nothing, and not for checkpoint results, which are margin receipts.

## What the consumer provides

- The words: what happened, then what to do. Never a code, a status number or server text. For errors use the static copy in `errorCopy.ts` (below), or the screen's own line for its HTTP error kinds.
- `action` when there is a next step: a `Button` ("Try again", `NEW_CHAT_LABEL`) or a `TextLink`. It sits at the right, and drops under the words on a narrow screen. Attached under a bubble on the right in a `TranscriptRow` (a visitor's message that didn't send), it always sits under the words, at the right, ending where the bubble ends, and the words start with the lines above them (see `TranscriptRow`).
- Keep a `waiting` or `info` notice mounted and change its words, when it should be announced as it changes. An `error` notice is an `alert` and is read out when it appears.

## Error copy (`errorCopy.ts`)

Static lines in English and Spanish, each a `CopyPair` (`{ en, es }`). No line contains a code, and a code this build doesn't know reads as `UNREACHABLE_COPY`, never as nothing.

| Export | Use |
| --- | --- |
| `evErrorCopy(ev, language)` | A visitor turn that ended with `EvError`: `session` is `CHAT_ENDED_COPY`, `rate_limited` is `RATE_LIMITED_COPY`, `kernel_unavailable`, `internal` and anything else are `UNREACHABLE_COPY`. |
| `errorCopy(code, language = 'en')` | An owner request that came back with `KernelError.code`: one plain line per code, so no owner request fails silently. |
| `UNREACHABLE_COPY` | "Something went wrong on our side. Try again in a moment." |
| `CHAT_ENDED_COPY` with `NEW_CHAT_LABEL` | "This chat ended. Start a new one to keep going." and the button "Start a new chat", which opens a new session. |
| `RATE_LIMITED_COPY` | "You're sending messages quickly. Wait a moment, then try again." |
| `AGENT_START_LOST_COPY` with `RELOAD_PAGE_LABEL` | On the agents page, when the answer to starting an agent was lost and the agent may be running: "The agent may have started, but we lost the answer. If you reload and send it again, it may run twice." and the button "Reload the page". |
| `SETUP_START_LOST_COPY` | An owner line, in English only and so a plain string, not a `CopyPair`: when the answer to starting setup was lost and the setup interview may already exist, "Setup may have started, but we lost the answer. If you reload and start again, you may get two drafts." |
| `AGENT_START_RETRY_COPY` | On the agents page, once starting an agent is safe to repeat, in place of `AGENT_START_LOST_COPY`: "We lost the answer, so we don't know yet whether the agent started. Try again: if it did, you'll see it." / "Perdimos la respuesta, así que aún no sabemos si el agente empezó. Inténtalo de nuevo: si empezó, lo verás." |
| `SETUP_START_RETRY_COPY` | An owner line in English, once starting setup is safe to repeat, in place of `SETUP_START_LOST_COPY`: "We lost the answer, so we don't know yet whether setup started. Try again: if it did, you'll go straight to it." |
| `SETUP_START_SLOW_COPY` | An owner line in English, when setup takes longer than usual to start: "Setup is taking longer than usual to start. Try again in a moment." |
| `SETUP_START_SPENT_COPY` | An owner line in English, when setup didn't start: "Setup didn't start. If a draft Desk shows in your Desks, open it from there. Otherwise, start again." Its wording isn't settled yet, so no screen uses it so far. |
| `DEMO_BUDGET_COPY` | The demo has spent its model budget for now: "The demo has used its budget for now. Try again later." |

Owner lines by `KernelError.code`:

| Code | Line |
| --- | --- |
| `auth` | "Your session ended. Open the demo again to keep going." |
| `not_found`, `closed` | "This isn't available anymore. Reload to see where things stand." |
| `conflict`, `stale_generation`, `mode_owner`, `mode_paused` | "This changed while you were looking. Reload to see where it stands." |
| `invalid` | "That didn't go through. Check it and try again." |
| `rate_limited` | "That's a lot of requests at once. Wait a moment, then try again." |
| `seed_unproved` | "Rules can't be checked right now. Try again in a moment." |
| `internal`, `replayed` | `UNREACHABLE_COPY` |

After a conflict (`conflict`, `stale_generation`, `mode_owner`, `mode_paused`), use `CHANGED_REFRESHED`, "This changed while you were looking. Here's where it stands now.", when the screen has already read the item again and shows it as it stands; use the reload line above when the screen can't refresh in place and the owner has to reload.

Both maps are `satisfies Record<…Code, CopyPair>`, so a code added to the contract without a line is a compile error.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `tone` | `'info' \| 'waiting' \| 'error'` | Required. The dot is hollow for `info`, `status-held` for `waiting`, `status-refused` for `error`. |
| `children` | `ReactNode` | Required; `.cd-type-meta`, `text-secondary` (`text-primary` for an error). |
| `action` | `ReactNode` | The next step. |

`role="alert"` for `error`, `role="status"` otherwise. No fill and no border, so a notice can sit inside a card without making a card in a card.
