import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import type { BrandPalette } from '../../api/contracts.ts';
import { isUncertain, OWNER_ERROR_COPY, request } from '../../api/http.ts';
import type { BusinessOut, DeskSummary } from '../../api/views.ts';
import { Card, Notice } from '../../ds/index.ts';
import { brandFrom } from '../../public/brand.ts';
import { PALETTE_KEYS, PALETTE_NAMES, paletteBrand, paletteKey } from '../../public/palette.ts';
import { DESKS_KEY, desksQuery } from '../useDesks.ts';

/** The signed SET-02 card: a palette pick saves on tap and previews before the answer arrives. */
export function HeaderColourCard({ business, desk }: { business: BusinessOut; desk: DeskSummary }) {
  const queryClient = useQueryClient();
  const titleId = useId();
  const captionId = useId();
  const [optimistic, setOptimistic] = useState<BrandPalette | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Fence a second click before React has drawn the pending state. Controls keep their focus.
  const saving = useRef(false);
  const unconfirmed = useRef(false);
  const selected = optimistic ?? paletteKey(business.brand);
  const shown = optimistic === null ? business.brand ?? {} : paletteBrand(optimistic);
  const { brand } = brandFrom({ business_name: business.name, desk_name: desk.name, owner_display_name: business.owner_display_name, brand: shown });

  const save = useMutation({
    mutationFn: (palette: BrandPalette) => request('setBusiness', {
      params: { desk_id: desk.desk_id },
      body: { name: business.name, owner_display_name: business.owner_display_name, timezone: business.timezone, brand_palette: palette, brand: {} },
    }),
    onMutate: () => queryClient.cancelQueries({ queryKey: DESKS_KEY }),
    onError: async (err) => {
      const previous = paletteKey(business.brand);
      if (isUncertain(err)) {
        // A lost response can follow a committed write. Only a fresh read can confirm a rollback.
        await queryClient.cancelQueries({ queryKey: DESKS_KEY });
        const read = await queryClient.fetchQuery(desksQuery()).catch(() => null);
        if (read === null) {
          unconfirmed.current = true;
          setFailure(OWNER_ERROR_COPY.network);
          return;
        }
        const now = read.find((item) => item.business_id === business.business_id);
        if (now === undefined || paletteKey(now.brand) !== previous) return;
      }
      setFailure(`That didn't save, so your header is still ${previous === null ? 'Custom colour' : PALETTE_NAMES[previous]}.`);
    },
    onSettled: async () => {
      // Responses can arrive out of order across mounts. Read the server after every outcome;
      // never carry a mutation's old palette into the shared cache.
      await queryClient.invalidateQueries({ queryKey: DESKS_KEY });
      saving.current = false;
    },
  });

  useEffect(() => {
    // Keep the preview through the write and its readback. If both reads failed, keep it until
    // a later successful read (or leaving the page) settles the unconfirmed choice.
    if (save.isPending || queryClient.getQueryState(DESKS_KEY)?.status !== 'success') return;
    setOptimistic(null);
    if (unconfirmed.current) {
      setFailure(null);
      unconfirmed.current = false;
    }
  }, [business, save.isPending, queryClient]);

  function pick(palette: BrandPalette) {
    if (saving.current || palette === selected) return;
    saving.current = true;
    unconfirmed.current = false;
    setFailure(null);
    setOptimistic(palette);
    save.mutate(palette);
  }

  function move(event: KeyboardEvent<HTMLButtonElement>, palette: BrandPalette) {
    const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    if (saving.current) return;
    const index = (PALETTE_KEYS.indexOf(palette) + direction + PALETTE_KEYS.length) % PALETTE_KEYS.length;
    const next = PALETTE_KEYS[index]!;
    const group = event.currentTarget.parentElement;
    group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
    pick(next);
  }

  return (
    <Card as="section" labelledBy={titleId} padding={0}>
      <div className="cd-header-colour">
        <div className="cd-header-colour__head">
          <h2 id={titleId} className="cd-type-control">Header colour</h2>
          <p id={captionId} className="cd-type-caption cd-settings__quiet">The bar at the top of your public page.</p>
        </div>
        <div role="radiogroup" aria-labelledby={titleId} aria-describedby={captionId} aria-busy={save.isPending} className="cd-header-colour__swatches">
          {PALETTE_KEYS.map((palette) => (
            <button
              key={palette}
              type="button"
              role="radio"
              aria-label={PALETTE_NAMES[palette]}
              aria-checked={palette === selected}
              aria-disabled={save.isPending || undefined}
              tabIndex={palette === (selected ?? 'none') ? 0 : -1}
              className={`cd-header-colour__swatch${palette === 'none' ? ' cd-header-colour__swatch--none' : ''}`}
              style={{ '--swatch-field': palette === 'none' ? 'var(--bg-panel)' : paletteBrand(palette).primary } as CSSProperties}
              onClick={() => pick(palette)}
              onKeyDown={(event) => move(event, palette)}
            >
              {palette === 'none' ? <span className="cd-header-colour__none-clip" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        <p className="cd-type-caption cd-settings__quiet">{selected === null ? 'Custom colour' : PALETTE_NAMES[selected]}</p>
        <div
          className="cd-header-colour__preview"
          role="group"
          aria-label="Header preview"
          style={{ backgroundColor: brand.field, borderBottomColor: brand.accent, color: brand.ink }}
        >
          <span className="cd-header-colour__monogram cd-type-wordmark" aria-hidden="true">{brand.monogram}</span>
          <div className="cd-header-colour__names" data-copy="user">
            <p className="cd-type-brand-name">{brand.name}</p>
            <p className="cd-type-meta cd-settings__quiet">{brand.tagline}</p>
          </div>
        </div>
        {failure === null ? null : <Notice tone="error">{failure}</Notice>}
      </div>
    </Card>
  );
}
