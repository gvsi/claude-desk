import { ClaudeMessage, Composer, FactCard, MarginReceipt, PublicShell, SuggestionChips, SystemLine, Transcript, TranscriptRow, VisitorMessage, type ReceiptSource } from '../ds/index.ts';
import { brandFrom } from '../public/brand.ts';
import { CITY_DESK, CITY_INSPECTION_TIMES, CITY_PERMIT, CITY_SOURCES, CITY_SUGGESTIONS, CITY_TURNS, CITY_VERIFY_PROMPT, proseOf } from './data.ts';
import { ClaudeWords, noop, VisionFrame } from './VisionFrame.tsx';

/** The two receipts under each of Claude's answers: the reply's check, then what ran or what waits for a person. */
function cityReceipts(seq: number, source: ReceiptSource, plain: string) {
  return [
    <MarginReceipt key="checked" source={CITY_SOURCES.checked} plain={CITY_TURNS.checked} ledgerSeq={seq} />,
    <MarginReceipt key="action" source={source} plain={plain} ledgerSeq={seq + 1} />,
  ];
}

/**
 * `/vision/city-office` (N-R2-Vision-CityOffice-Resident): Marcus Bell, a resident, on the public
 * Desk of Meridian Bay Permits, a fictional city permits office. He confirms it's him with a code
 * sent to the email on his application, then gets his permit's status with the fee due, the next
 * steps and the open inspection times, each in its card; whether his garage conversion needs a
 * permit is a plan checker's decision, so it is held for staff. It keeps the public page's rules:
 * the AI disclosure, every fee, date, time and status only in a card, and the concept footer.
 * Nothing here is live: the composer, the suggestions and "Ask for Permit Center staff" do nothing.
 */
export function CityOfficePage() {
  const { brand, ownerName } = brandFrom(CITY_DESK);
  // Messages name the owner as the Desk serves the name; the shell's head asks for `ownerName`.
  const staff = CITY_DESK.owner_display_name;
  const t = CITY_TURNS;
  const s = CITY_SOURCES;
  const composerLabel = `Message ${brand.name}`;
  return (
    // As the public page names its tab: the business.
    <VisionFrame title={brand.name}>
      {(bar) => (
        <PublicShell
          banner={bar}
          brand={brand}
          ownerName={ownerName}
          language="en"
          openStatus={CITY_DESK.open_status}
          onAskForOwner={noop}
          inertAsk
          about={CITY_DESK.charter}
          composer={<Composer variant="visitor" label={composerLabel} placeholder={composerLabel} maxLength={2000} onSend={noop} inertSend />}
        >
          <Transcript label={`Conversation with ${brand.name}`}>
            <TranscriptRow>
              <VisitorMessage text={t.status} />
            </TranscriptRow>
            <TranscriptRow margin={cityReceipts(51, s.executed, t.codeSent)}>
              <ClaudeMessage plainProse blocks={[...proseOf(t.verifyFirst), CITY_VERIFY_PROMPT]} language="en" ownerName={staff} />
            </TranscriptRow>
            <SystemLine text={t.verified} />
            <TranscriptRow margin={cityReceipts(53, s.executed, t.readFile)}>
              {/* One answer: Claude's words lead into each fact card. */}
              <div className="cd-vision-city__answer">
                <ClaudeWords text={t.stands} ownerName={staff} />
                <FactCard {...CITY_PERMIT.status} />
                <ClaudeWords text={t.next} ownerName={staff} />
                <FactCard {...CITY_PERMIT.nextSteps} />
              </div>
            </TranscriptRow>
            <TranscriptRow>
              <VisitorMessage text={t.inspector} />
            </TranscriptRow>
            <TranscriptRow margin={cityReceipts(55, s.executed, t.readCalendar)}>
              <ClaudeMessage plainProse blocks={[...proseOf(t.times), CITY_INSPECTION_TIMES]} language="en" ownerName={staff} />
            </TranscriptRow>
            <TranscriptRow>
              <VisitorMessage text={t.garage} />
            </TranscriptRow>
            <TranscriptRow margin={cityReceipts(57, s.held, t.waitingForStaff)}>
              <ClaudeWords text={t.staffDecides} ownerName={staff} />
            </TranscriptRow>
          </Transcript>
          {/* A vision page makes no requests: a suggestion goes nowhere, and its first pick says so. */}
          <div className="cd-vision-city__suggestions">
            <SuggestionChips label="Try asking" suggestions={CITY_SUGGESTIONS} onPick={noop} inertSuggestions />
          </div>
        </PublicShell>
      )}
    </VisionFrame>
  );
}
