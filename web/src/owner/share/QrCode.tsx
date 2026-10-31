import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

import './QrCode.css';

export interface QrCodeProps {
  /** The Desk's public link, which the code opens. */
  url: string;
}

/**
 * The QR code for the Desk's link, made here in the browser and shown as an image that fills the
 * square its parent gives it (the printable card's, or setup's live step's): dark modules on its own
 * light quiet zone, so it scans on paper and on any phone. Nothing shows until it is made, or if it
 * can't be; the link is written out near it either way.
 */
export function QrCode({ url }: QrCodeProps) {
  const [made, setMade] = useState<{ url: string; src: string } | null>(null);

  useEffect(() => {
    let current = true;
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((svg) => {
        if (current) setMade({ url, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
      })
      .catch(() => {
        if (current) setMade(null);
      });
    return () => {
      current = false;
    };
  }, [url]);

  // A code made for another link is never shown for this one.
  if (made === null || made.url !== url) return null;
  return <img className="cd-qr-code" src={made.src} alt={`QR code for ${url}`} />;
}
