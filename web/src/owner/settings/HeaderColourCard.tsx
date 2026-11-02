import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import type { BrandPalette } from '../../api/contracts.ts';
import { isUncertain, OWNER_ERROR_COPY, request } from '../../api/http.ts';
import type { BusinessOut, DeskSummary } from '../../api/views.ts';
import { Card, Notice } from '../../ds/index.ts';
import { brandFrom } from '../../public/brand.ts';
import { PALETTE_KEYS, PALETTE_NAMES, paletteBrand, paletteKey } from '../../public/palette.ts';
import { DESKS_KEY, confirmDesks, useDesks } from '../useDesks.ts';

/** The signed SET-02 card: a palette pick saves on tap and previews before the answer arrives. */
export function HeaderColourCard({ business, desk }: { business: BusinessOut; desk: DeskSummary }) {
  const queryClient = useQueryClient();
  const { dataUpdatedAt, status } = useDesks(desk.desk_id, { passive: true });
  const titleId = useId();
  const captionId = useId();
  const [optimistic, setOptimistic] = useState<BrandPalette | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const pickCounter = useRef(0);
  const unconfirmed = useRef(false);
  const uncertainSave = useRef(false);
  const selected = optimistic ?? paletteKey(business.brand);
  const shown = optimistic === null ? business.brand ?? {} : paletteBrand(optimistic);
  const { brand } = brandFrom({ business_name: business.name, desk_name: desk.name, owner_display_name: business.owner_display_name, brand: shown });

  const save = useMutation({
    // Aborting fetch cannot undo a server write. Serialize writes, even across remounts,
    // so the latest pick reaches storage after every earlier write has settled.
    scope: { id: `header-colour:${business.business_id}` },
    mutationFn: ({ palette }: { palette: BrandPalette; pick: number }) => request('setBusiness', {
      params: { desk_id: desk.desk_id },
      body: { name: business.name, owner_display_name: business.owner_display_name, timezone: business.timezone, brand_palette: palette, brand: {} },
    }),
    onMutate: () => queryClient.cancelQueries({ queryKey: DESKS_KEY }),
    onError: async (err, { palette, pick }) => {
      if (isUncertain(err)) uncertainSave.current = true;
      if (pick !== pickCounter.current) return;
      let previous = paletteKey(queryClient.getQueryData<BusinessOut[]>(DESKS_KEY)?.find((item) => item.business_id === business.business_id)?.brand ?? business.brand);
      if (uncertainSave.current) {
        // A lost response can follow a committed write. Only a fresh read can confirm a rollback.
        await queryClient.cancelQueries({ queryKey: DESKS_KEY });
        const read = await confirmDesks(queryClient);
        if (pick !== pickCounter.current) return;
        if (read === null) {
          unconfirmed.current = true;
          setFailure(OWNER_ERROR_COPY.network);
          return;
        }
        // This read is confirmed even if the following settle refetch fails.
        setOptimistic(null);
        const now = read.find((item) => item.business_id === business.business_id);
        if (now === undefined || paletteKey(now.brand) === palette) return;
        previous = paletteKey(now.brand);
      }
      setOptimistic(null);
      setFailure(`That didn't save, so your header is still ${previous === null ? 'Custom colour' : PALETTE_NAMES[previous]}.`);
    },
    onSettled: async () => {
      // Responses can arrive out of order across mounts. Read the server after every outcome;
      // never carry a mutation's old palette into the shared cache.
      await queryClient.invalidateQueries({ queryKey: DESKS_KEY });
    },
  });

  useEffect(() => {
    // Keep the preview through the write and its readback. If both reads failed, keep it until
    // a later successful read (or leaving the page) settles the unconfirmed choice.
    // The read timestamp changes even when structural sharing preserves the business object.
    if (save.isPending || status !== 'success') return;
    setOptimistic(null);
    if (unconfirmed.current) {
      setFailure(null);
      unconfirmed.current = false;
    }
  }, [dataUpdatedAt, status, save.isPending]);

  function pick(palette: BrandPalette) {
    if (palette === selected && !unconfirmed.current) return;
    if (!save.isPending) uncertainSave.current = false;
    unconfirmed.current = false;
    setFailure(null);
    setOptimistic(palette);
    save.mutate({ palette, pick: ++pickCounter.current });
  }

  function move(event: KeyboardEvent<HTMLButtonElement>, palette: BrandPalette) {
    const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (direction === undefined) return;
    event.preventDefault();
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
        <div role="radiogroup" aria-labelledby={titleId} aria-describedby={captionId} className="cd-header-colour__swatches">
          {PALETTE_KEYS.map((palette) => (
            <button
              key={palette}
              type="button"
              role="radio"
              aria-label={PALETTE_NAMES[palette]}
              aria-checked={palette === selected}
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
          // The public header's own field and inks: paper ink on the owner's colour in both themes,
          // the theme's on the panel.
          style={
            {
              backgroundColor: brand.field,
              borderBottomColor: brand.accent,
              color: brand.ink,
              '--cd-header-colour-ink-secondary': brand.inkSecondary,
            } as CSSProperties
          }
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
