import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Pi discovery may load this through a profile symlink. Resolve before importing siblings. */
export default async function agents(pi: ExtensionAPI) {
  const directory = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const { default: install } = await import(join(directory, "main.ts"));
  return install(pi);
}
