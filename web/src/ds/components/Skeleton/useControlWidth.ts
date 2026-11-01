import { useLayoutEffect, useState, type RefObject } from 'react';

/** A control's existing label and CSS, used only for measurement; no words enter the shape. */
export interface ControlMeasurement {
  label: string;
  className: string;
  tagName?: 'button' | 'a' | 'span';
  /** A label wrapper with its own gap, such as the inbox's label and count. */
  contentClassName?: string;
  suffix?: { label?: string; className?: string; width?: string };
}

/**
 * A control's width: canvas text metrics for its label in the real control's computed font, plus
 * that control's padding, borders, minimum width and optional suffix. A hidden probe with the
 * control's CSS and no words is appended to `parent` to read them, and removed before this returns.
 * Also gives the probe's computed font, so a caller can request that face. Pass a 2D context to
 * reuse one canvas across measurements.
 */
export function measureControlWidth(
  parent: HTMLElement,
  { label, className, tagName, contentClassName, suffix }: ControlMeasurement,
  context: CanvasRenderingContext2D = document.createElement('canvas').getContext('2d')!,
): { width: number; font: string } {
  const probe = document.createElement(tagName ?? 'button');
  probe.className = className;
  probe.inert = true;
  probe.setAttribute('aria-hidden', 'true');
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: 'max-content', maxWidth: 'none' });
  parent.append(probe);
  const textWidth = (element: HTMLElement, text: string) => {
    const style = getComputedStyle(element);
    context.font = style.font;
    let spacing = 0;
    if ('letterSpacing' in context) context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    else spacing = (Number.parseFloat(style.letterSpacing) || 0) * [...text].length;
    if ('wordSpacing' in context) context.wordSpacing = style.wordSpacing === 'normal' ? '0px' : style.wordSpacing;
    const edges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'] as const;
    const size = context.measureText(text).width + spacing + edges.reduce((sum, edge) => sum + (Number.parseFloat(style[edge]) || 0), 0);
    return Math.max(size, Number.parseFloat(style.minWidth) || 0);
  };
  try {
    const font = getComputedStyle(probe).font;
    let width = textWidth(probe, label);
    if (suffix) {
      const content = document.createElement('span');
      content.className = contentClassName ?? '';
      probe.append(content);
      const after = document.createElement('span');
      after.className = suffix.className ?? '';
      content.append(after);
      if (suffix.width) after.style.width = suffix.width;
      width += suffix.width ? after.getBoundingClientRect().width : textWidth(after, suffix.label ?? '');
      width += Number.parseFloat(getComputedStyle(contentClassName ? content : probe).columnGap) || 0;
    }
    return { width, font };
  } finally {
    probe.remove();
  }
}

/** Canvas text metrics plus the real control's computed padding, borders and optional suffix. */
export function useControlWidth(ref: RefObject<HTMLSpanElement | null>, control: ControlMeasurement | undefined): number | undefined {
  const [width, setWidth] = useState<number>();
  const { label, className, tagName, contentClassName, suffix } = control ?? {};
  useLayoutEffect(() => {
    const shape = ref.current;
    if (!shape || label === undefined || className === undefined) return;
    let live = true;
    const context = document.createElement('canvas').getContext('2d')!;
    const measure = () => {
      if (!live || !shape.parentElement) return '';
      const measured = measureControlWidth(shape.parentElement, { label, className, tagName, contentClassName, suffix }, context);
      setWidth(measured.width);
      return measured.font;
    };
    const font = measure();
    // Request the face even though the empty shape itself has no text to trigger a font load.
    if (font) void document.fonts.load(font, label).then(measure, measure);
    void document.fonts.ready.then(measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => { live = false; document.fonts.removeEventListener('loadingdone', measure); };
  }, [ref, label, className, tagName, contentClassName, suffix?.label, suffix?.className, suffix?.width]);
  return control ? width : undefined;
}
