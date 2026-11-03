import { Pill } from '../Pill/Pill.tsx';

import './Landing.css';

/**
 * The fill a row or card lights up in where the owner's confirmed change landed: behind its words,
 * on `motion-fast`, held 1.6 s, then let go on `motion-base`. Its parent places it (positioned,
 * isolated, and with its own inset and corners). The parent keys it by its landing, so each new one
 * lights up again. Nothing under reduced motion: the end state has no fill. Shared by Rules and the
 * design system's connector and tool cards; its folder draws no Button, which the selected ground
 * can't take.
 */
export function LandedGlow() {
  return <span className="cd-landed-glow" aria-hidden="true" />;
}

/**
 * "Updated" where the owner's confirmed change landed, growing from 95% as it fades in on
 * `motion-base`; at once under reduced motion. Its parent sets the space before it.
 */
export function UpdatedPill() {
  return (
    <span className="cd-landed-updated">
      <Pill>Updated</Pill>
    </span>
  );
}
