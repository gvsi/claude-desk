/**
 * Waits until nothing under `root` is still animating, so a test measures a screen at rest rather
 * than partway through its one moment. An animation cancelled on the way counts as done.
 */
export async function settled(root: Element): Promise<void> {
  await Promise.all(root.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)));
}
