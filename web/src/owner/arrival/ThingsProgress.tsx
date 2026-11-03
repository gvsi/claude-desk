import { doneCaption, THINGS, type Thing } from './doneSignals.ts';

/** One segment per thing, in list order, with the caption as its accessible name. */
export function ThingsProgress({ done }: { done: Readonly<Partial<Record<Thing, unknown>>> }) {
  const count = THINGS.filter((thing) => done[thing] !== undefined).length;
  return (
    <div className="cd-things__progress" role="progressbar" aria-label={doneCaption(count)} aria-valuemin={0} aria-valuemax={THINGS.length} aria-valuenow={count}>
      {THINGS.map((thing) => <span key={thing} className={done[thing] === undefined ? 'cd-things__segment' : 'cd-things__segment cd-things__segment--done'} />)}
    </div>
  );
}
