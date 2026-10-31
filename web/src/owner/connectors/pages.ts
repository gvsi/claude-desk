/**
 * The Desk's Connectors pages, under `connectors/`: the Connectors page, each connector's page and
 * each tool's. They aren't built yet (Task 14 of the web app plan), so nothing links to them: the
 * sidebar draws no Connectors row, and Rules and All rules draw each connector and tool without a
 * link, so none of them opens the not-found page. Task 14 builds the pages and turns this on.
 */
export const CONNECTOR_PAGES_BUILT = false;

let built: boolean = CONNECTOR_PAGES_BUILT;

/**
 * The address of the Connectors page at `path` under the Desk (`connectors`, `connectors/{key}`,
 * `connectors/{key}/{tool}`), or none while those pages aren't built, or when there is no `path`:
 * then the screen draws its row without a link.
 */
export function connectorPageHref(deskId: string, path: string | undefined): string | undefined {
  return built && path !== undefined ? `/app/${encodeURIComponent(deskId)}/${path}` : undefined;
}

/**
 * Draws the owner app as if the Connectors pages were built (true) or not, for tests;
 * `CONNECTOR_PAGES_BUILT` is the app's own setting.
 */
export function setConnectorPagesBuilt(on: boolean): void {
  built = on;
}
