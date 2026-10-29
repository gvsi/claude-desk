# Whisper

`Whisper` shows an owner's whisper in their transcript: a caption that says only Claude sees it, then the words in a dashed bubble.

## When to use

- Each whisper in the owner's conversation view. A visitor never sees a whisper, so it never appears on the public page.

## What the consumer provides

- `caption`: who and when, in the consumer's words, such as "Your whisper, 12:08. Only Claude sees this." The time is a display string the owner screen formats; the design system formats none.
- `text`: the whisper exactly as the owner wrote it, marked `data-copy="user"`.

## Look

- The caption is a secondary caption with the struck-out eye icon (`whisper`), which is `aria-hidden`.
- The words are in the body type inside a 1 px dashed `line-control` border at the card radius, with no fill. The bubble hugs the words and wraps at the column's width.
- The dash marks the whisper as something that never reached the visitor, and the caption says so in words.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `caption` | `string` | Required. |
| `text` | `string` | Required. |
