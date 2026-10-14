import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Resolve profile discovery symlinks before importing shared UI modules. */
export default async function goal(pi: ExtensionAPI) {
  const directory = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const { default: install } = await import(join(directory, "main.ts"));
  return install(pi);
}
