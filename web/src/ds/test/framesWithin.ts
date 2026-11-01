import { animationWithin } from './animationWithin.ts';

/** Draws `count` frames, or names the stalled phase and cancels its pending frame. */
export async function framesWithin(name: string, count = 1): Promise<number> {
  let frame = 0;
  try {
    return await animationWithin(new Promise<number>((resolve) => {
      let remaining = count;
      const drawn = (at: number) => {
        remaining -= 1;
        if (remaining === 0) resolve(at);
        else frame = requestAnimationFrame(drawn);
      };
      frame = requestAnimationFrame(drawn);
    }), name);
  } finally {
    cancelAnimationFrame(frame);
  }
}
