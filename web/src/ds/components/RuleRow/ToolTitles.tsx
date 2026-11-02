import { Fragment } from 'react';

/**
 * Tools named by their titles inside a line of the screen's words. A title is the tool's own (a
 * business tool's from setup, a connected tool's from its definition), so it is untrusted text:
 * each one shows as its own user-text item, never joined into the screen's sentence as one string.
 */
export interface ToolTitles {
  titles: readonly string[];
}

/**
 * The titles as one list, in the words `listWords` joins them with ("Quote", "Quote and Refund",
 * "Quote, Book a visit and Refund"): the commas and "and" are the screen's, and each title is its
 * own `data-copy="user"` span.
 */
export function ToolTitleList({ titles }: ToolTitles) {
  return (
    <>
      {titles.map((title, index) => (
        <Fragment key={index}>
          {index === 0 ? null : index === titles.length - 1 ? ' and ' : ', '}
          <span data-copy="user">{title}</span>
        </Fragment>
      ))}
    </>
  );
}

/** Whether `titles` names at least one tool. */
export function namesATool(titles: ToolTitles): boolean {
  return titles.titles.some((title) => title.trim() !== '');
}
