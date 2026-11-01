/** The text after a name, without a second sentence stop. */
export function afterName(name: string, rest: string): string {
  return /[.!?]$/.test(name.trimEnd()) && rest.startsWith('.') ? rest.slice(1) : rest;
}
