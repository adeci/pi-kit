import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Resolve profile discovery symlinks before importing sibling modules: the
 * specifier is derived from this file's real path, so a static `./main.ts`
 * import is not usable here. Same loader shape as the other pi-kit components.
 */
export default async function claudeBilling(pi: ExtensionAPI) {
  const directory = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const { default: install } = await import(join(directory, "main.ts"));
  return install(pi);
}
