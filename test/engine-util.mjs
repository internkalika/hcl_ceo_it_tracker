import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const html = readFileSync(path.join(root, "index.html"), "utf8");

/** Load the page's OWN bundled parser/engine (unchanged generated code) so tests exercise the real thing. */
export function loadEngine() {
  const a = html.indexOf("const ENGINE = ") + "const ENGINE = ".length;
  const endMarker = "})({ env: {} }, { from: function (x) { return x; } });";
  const b = html.indexOf(endMarker) + endMarker.length;
  return (0, eval)(html.slice(a, b));
}
export function loadEmbedded() {
  const a = html.indexOf("const EMBEDDED = ") + "const EMBEDDED = ".length;
  const b = html.indexOf("}; // { data, source }") + 1;
  return JSON.parse(html.slice(a, b));
}
export const fixture = (name) => new Uint8Array(readFileSync(path.join(root, "test/fixtures", name)));
