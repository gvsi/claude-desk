/**
 * Asserts computed styles, so a story can mirror the design canvas value by value: strings must
 * match exactly, RegExps are tested. Every mismatch is listed in one `Error`.
 */

type StyleKey = keyof CSSStyleDeclaration;

export type ComputedExpectation = Partial<Record<StyleKey, string | RegExp>>;

function describeElement(el: Element): string {
  const ds = el.getAttribute('data-ds');
  const classes = [...el.classList].map((name) => `.${name}`).join('');
  return `<${el.tagName.toLowerCase()}${ds ? ` data-ds="${ds}"` : ''}>${classes}`;
}

export function expectComputed(el: Element, expected: ComputedExpectation): void {
  const entries = Object.entries(expected) as [StyleKey, string | RegExp][];
  if (entries.length === 0) throw new Error(`expectComputed: nothing to check on ${describeElement(el)}`);
  const view = el.ownerDocument.defaultView;
  if (!view || !el.isConnected) throw new Error(`expectComputed: ${describeElement(el)} is not in a rendered document`);
  const style = view.getComputedStyle(el);
  const mismatches: string[] = [];
  for (const [key, want] of entries) {
    const got = style[key];
    if (typeof got !== 'string') {
      mismatches.push(`${String(key)}: not a style property`);
      continue;
    }
    if (typeof want === 'string') {
      if (got !== want) mismatches.push(`${String(key)}: expected "${want}", got "${got}"`);
    } else {
      want.lastIndex = 0;
      if (!want.test(got)) mismatches.push(`${String(key)}: expected ${String(want)}, got "${got}"`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Computed style of ${describeElement(el)} differs:\n${mismatches.map((m) => `- ${m}`).join('\n')}`);
  }
}
