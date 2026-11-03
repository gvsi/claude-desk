import { Icon, type IconName } from '../../icons/index.tsx';

import './ConnectorIcon.css';

/** A connector's icon: the six built-in connectors, and the third-party apps by their own marks. */
export type ConnectorIconName =
  | 'quotes'
  | 'bookings'
  | 'leads'
  | 'verification'
  | 'documents'
  | 'payments'
  | 'stripe'
  | 'google_calendar';

/** Each built-in connector's line icon. */
const BUILT_IN = {
  store: 'store',
  quotes: 'quote',
  bookings: 'calendar',
  leads: 'person',
  verification: 'lock',
  documents: 'document',
  payments: 'card',
} as const satisfies Partial<Record<ConnectorIconName | 'store', IconName>>;

/**
 * Each third-party connector's own mark on the 24-unit grid, filled in its brand color token: Stripe's
 * in white on the dark grounds, as Stripe's guidelines allow, and in Stripe's own purple on the light
 * theme's paper; Google Calendar's in its own blue.
 * The path data is Simple Icons' (https://simpleicons.org), released under CC0.
 */
const BRAND = {
  stripe: {
    fill: 'var(--connector-stripe)',
    d: 'M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z',
  },
  google_calendar: {
    fill: 'var(--connector-google-blue)',
    d: 'M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z',
  },
} as const satisfies Partial<Record<ConnectorIconName, { fill: string; d: string }>>;

export interface ConnectorIconProps {
  icon: ConnectorIconName | 'store';
  /** Overrides the connector mark with a built-in glyph tile. */
  glyph?: IconName;
  /**
   * `page` (48 px, a connector's own page), `section` (36 px, the hub and cards) or `inline` (in a line
   * of meta: 24 px for a built-in tile, 20 px for a brand mark, which fills its box).
   */
  size: 'page' | 'section' | 'inline';
}

/**
 * A connector's icon, always beside its name and hidden from screen readers. A built-in connector's
 * line icon on a `fill-secondary` tile; a third-party connector's own mark, in its brand's color, with
 * no tile. An icon this build doesn't know shows an empty built-in tile.
 */
export function ConnectorIcon({ icon, glyph, size }: ConnectorIconProps) {
  const brand = glyph === undefined && Object.hasOwn(BRAND, icon) ? BRAND[icon as keyof typeof BRAND] : null;
  const line = glyph ?? (Object.hasOwn(BUILT_IN, icon) ? BUILT_IN[icon as keyof typeof BUILT_IN] : null);
  return (
    <span className={`cd-connector-icon cd-connector-icon--${size} cd-connector-icon--${brand ? 'brand' : 'built-in'}`} aria-hidden="true">
      {brand ? (
        <svg className="cd-connector-icon__mark" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path fill={brand.fill} d={brand.d} />
        </svg>
      ) : line ? (
        // Drawn at 20 px for its stroke, then scaled with the tile, as the boards draw it.
        <Icon name={line} size={20} className="cd-connector-icon__mark" />
      ) : null}
    </span>
  );
}
