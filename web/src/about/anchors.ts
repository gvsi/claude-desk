/**
 * A heading's anchor on the About pages: lower case, apostrophes dropped, everything else but letters and digits a
 * hyphen. The reading pages' documents (`markdown.ts`) and the Vision article's sections take theirs from it, so an
 * address names a section the same way on all three.
 */
export function slug(text: string): string {
  return text.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}
