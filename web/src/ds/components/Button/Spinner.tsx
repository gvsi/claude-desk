/**
 * The busy spinner: a faint ring with a quarter arc on it, both in the current text color. The
 * stylesheet that places it turns it once every motion-spin and holds it still under reduced
 * motion. Drawn only (`aria-hidden`): the words beside it, or the busy button's label, say what is
 * happening.
 */
export function Spinner({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
