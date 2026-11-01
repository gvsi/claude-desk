/** The API's character limits for setup public text. */
export function publicLineLimit(key: string): number {
  return key === 'policy:about' ? 1500 : key === 'contact' ? 200 : 500;
}
