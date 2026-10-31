import { ConceptFooter } from '../ds/index.ts';
import { PHONE_PAGE } from './data.ts';
import { VisionFrame } from './VisionFrame.tsx';

/** `/vision/phone` (N-R2-Vision-Phone): the owner's Today and a visitor's chat, as phone apps. */
export function PhonePage() {
  return (
    <VisionFrame title={PHONE_PAGE.title}>
      {(bar) => (
        <div className="cd-vision-phone-page">
          {bar}
          <ConceptFooter />
        </div>
      )}
    </VisionFrame>
  );
}
