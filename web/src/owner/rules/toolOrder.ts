/** Rules' reading order, independent of the Connectors catalog. Google Calendar has no tools yet. */
const CONNECTOR_ORDER: readonly string[] = ['quotes', 'bookings', 'payments', 'stripe', 'documents', 'leads', 'verification', 'google_calendar'];

/** A copy in Rules' order, shared by the page's model and the Rules board stories. */
export function inRulesOrder<T extends { connector: { id: string } }>(sections: readonly T[]): T[] {
  return [...sections].sort((a, b) => CONNECTOR_ORDER.indexOf(a.connector.id) - CONNECTOR_ORDER.indexOf(b.connector.id));
}
