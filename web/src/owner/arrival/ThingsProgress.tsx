import { doneCaption, THINGS, type Thing } from './doneSignals.ts';

/** One segment per thing, filled from the left by how many are done (never by which), with the caption as its accessible name. */
export function ThingsProgress({ done }: { done: Readonly<Partial<Record<Thing, unknown>>> }) {
  const count = THINGS.filter((thing) => done[thing] !== undefined).length;
  return (
    <div className="cd-things__progress" role="progressbar" aria-label={doneCaption(count)} aria-valuemin={0} aria-valuemax={THINGS.length} aria-valuenow={count}>
      {THINGS.map((thing, index) => <span key={thing} className={index < count ? 'cd-things__segment cd-things__segment--done' : 'cd-things__segment'} />)}
    </div>
  );
}
