import { ConceptFooter } from '../ds/index.ts';
import { VisionFrame } from './VisionFrame.tsx';

/** `/vision/claude-account` (N-R2-Vision-ClaudeAccount): Dana, back on Rivera's public page, signed in. */
export function ClaudeAccountPage() {
  return (
    <VisionFrame title="Rivera Plumbing">
      {(bar) => (
        <div>
          {bar}
          <ConceptFooter />
        </div>
      )}
    </VisionFrame>
  );
}
