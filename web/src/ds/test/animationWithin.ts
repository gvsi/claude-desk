/** Animation waits fail at their own phase, well before Storybook's whole-story ceiling. */
export async function animationWithin<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not settle within 2000 ms`)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Name the CSS animation, transition property or scripted animation in a stalled wait. */
export function animationLabel(animation: Animation): string {
  if (animation instanceof CSSAnimation) return animation.animationName;
  if (animation instanceof CSSTransition) return `${animation.transitionProperty} transition`;
  return animation.id || 'unnamed animation';
}
