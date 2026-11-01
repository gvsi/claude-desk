/** The text after a name, without a second sentence stop. */
export function afterName(name: string, rest: string): string {
  return /[.!?]$/.test(name.trimEnd()) && rest.startsWith('.') ? rest.slice(1) : rest;
}

/** The first word of the owner's name, as the API writes `Today.greeting_name`. */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}
