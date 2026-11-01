/** The API's limits for setup public text; contact is reserved for its upcoming review row. */
export function publicLineLimit(key: string): number {
  return key === 'policy:about' ? 1500 : key === 'policy:contact' ? 200 : 500;
}
