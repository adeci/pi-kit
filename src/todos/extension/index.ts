import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Resolve the installed package before loading shared UI through a discovery symlink. */
export default async function todos(pi: ExtensionAPI) {
  const directory = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const { default: install } = await import(join(directory, "main.ts"));
  return install(pi);
}
