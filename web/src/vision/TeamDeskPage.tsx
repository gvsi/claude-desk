import { ConceptFooter } from '../ds/index.ts';
import { TEAM_OWNER } from './data.ts';
import { VisionFrame, VisionOwnerShell } from './VisionFrame.tsx';

/** `/vision/team-desk` (N-R2-Vision-TeamDesk): Rivera Plumbing's team asking its own Desk. */
export function TeamDeskPage() {
  return (
    <VisionFrame title="Rivera Plumbing team">
      {(bar) => (
        <VisionOwnerShell bar={bar} {...TEAM_OWNER}>
          <div className="cd-vision-page cd-vision-team">
            <ConceptFooter />
          </div>
        </VisionOwnerShell>
      )}
    </VisionFrame>
  );
}
