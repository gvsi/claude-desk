/**
 * Stands in for `rehype-raw` in every build, test and story (`resolve.alias` in `vite.config.ts`).
 * Streamdown imports rehype-raw only for its default plugin list, which ChatMarkdown replaces so
 * that HTML in Claude's text renders as text. Without this stand-in, rehype-raw's HTML parser
 * (`hast-util-raw` with `parse5`, about a third of Streamdown's weight) ships unused; with it,
 * nothing in the app can parse raw HTML into elements.
 *
 * As a rehype plugin it does nothing: it adds no step.
 */
export default function rehypeRaw(): void {}
