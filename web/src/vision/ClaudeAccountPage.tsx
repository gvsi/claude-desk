import { ClaudeMessage, Composer, MarginReceipt, PublicShell, SystemLine, Transcript, TranscriptRow, VisitorMessage } from '../ds/index.ts';
import { brandFrom } from '../public/brand.ts';
import {
  CLAUDE_ACCOUNT_ABOUT,
  CLAUDE_ACCOUNT_INVOICE,
  CLAUDE_ACCOUNT_SOURCES,
  CLAUDE_ACCOUNT_TURNS,
  CLAUDE_ACCOUNT_WELCOME,
  RIVERA_PUBLIC_DESK,
} from './data.ts';
import { ClaudeWords, noop, VisionFrame } from './VisionFrame.tsx';

/**
 * `/vision/claude-account` (N-R2-Vision-ClaudeAccount): Dana, a returning customer, back on Turner
 * Plumbing's public page signed in with her Claude account. Claude asks to use the account for this
 * visit, it matches her contact on record, Claude welcomes her back beside her last visit's booking
 * card, and her invoice comes as a document card only for her; the receipts say both the match and
 * her consent. It keeps the public page's rules: the AI disclosure, every booking and document only
 * in its card, and the concept footer.
 */
export function ClaudeAccountPage() {
  const { brand, ownerName } = brandFrom(RIVERA_PUBLIC_DESK);
  // Messages name the owner as the Desk serves the name; the shell's head asks for `ownerName`.
  const owner = RIVERA_PUBLIC_DESK.owner_display_name;
  const t = CLAUDE_ACCOUNT_TURNS;
  const s = CLAUDE_ACCOUNT_SOURCES;
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
          onAskForOwner={noop}
          inertAsk
          about={CLAUDE_ACCOUNT_ABOUT}
          composer={<Composer variant="visitor" label={composerLabel} placeholder={composerLabel} maxLength={2000} onSend={noop} inertSend />}
        >
          <Transcript label={`Conversation with ${brand.name}`}>
            <SystemLine text={t.signedIn} />
            <TranscriptRow margin={<MarginReceipt source={s.checked} plain={t.checked} ledgerSeq={40} />}>
              <ClaudeWords text={t.ask} ownerName={owner} />
            </TranscriptRow>
            <TranscriptRow>
              <VisitorMessage text={t.yes} />
            </TranscriptRow>
            <TranscriptRow
              margin={[
                <MarginReceipt key="matched" source={s.matched} plain={t.matchedReceipt} ledgerSeq={41} />,
                <MarginReceipt key="checked" source={s.checked} plain={t.checked} ledgerSeq={42} />,
              ]}
            >
              <ClaudeMessage blocks={CLAUDE_ACCOUNT_WELCOME} language="en" ownerName={owner} />
            </TranscriptRow>
            <TranscriptRow>
              <VisitorMessage text={t.invoice} />
            </TranscriptRow>
            <TranscriptRow
              margin={[
                <MarginReceipt key="checked" source={s.checked} plain={t.checked} ledgerSeq={43} />,
                <MarginReceipt key="released" source={s.released} plain={t.releasedReceipt} ledgerSeq={44} />,
              ]}
            >
              <ClaudeMessage blocks={CLAUDE_ACCOUNT_INVOICE} language="en" ownerName={owner} inertDownload />
            </TranscriptRow>
          </Transcript>
        </PublicShell>
      )}
    </VisionFrame>
  );
}
