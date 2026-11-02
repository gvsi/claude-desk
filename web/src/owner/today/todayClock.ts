import { createContext, useContext } from 'react';

/**
 * The clock Today draws its time labels against ("12 min ago", "Today, 9:52 am", the greeting): the
 * browser's, read at each render, where nothing says otherwise. The still picture behind the intro
 * dialog gives the moment it reads its copy at, so it labels the copy as Today will once it opens.
 */
export const TodayClockContext = createContext<() => Date>(() => new Date());

/** The time Today's labels are drawn at, read now. */
export function useTodayNow(): Date {
  return useContext(TodayClockContext)();
}
