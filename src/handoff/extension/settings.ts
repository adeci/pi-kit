import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface Settings {
  enabled: boolean;
  threshold: number;
  model: { provider: string; id: string } | null;
}
export const defaults: Settings = { enabled: true, threshold: 80, model: null };

export function thresholdInput(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text || !/^\d{1,2}%?$/.test(text)) return undefined;
  const threshold = Number(text.replace(/%$/, ""));
  return threshold >= 1 && threshold <= 99 ? threshold : undefined;
}
export const settingsPath = () =>
  process.env.PI_HANDOFF_CONFIG ??
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "pi-kit",
    "handoff.json",
  );

export function parseSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Handoff settings must be an object.");
  const value = { ...defaults, ...raw } as Settings;
  if (typeof value.enabled !== "boolean")
    throw new Error("Handoff enabled must be a boolean.");
  if (
    !Number.isInteger(value.threshold) ||
    value.threshold < 1 ||
    value.threshold > 99
  )
    throw new Error(
      "Handoff threshold must be an integer from 1 to 99 percent.",
    );
  if (
    value.model !== null &&
    (typeof value.model !== "object" ||
      Array.isArray(value.model) ||
      ![value.model.provider, value.model.id].every(
        (s) => typeof s === "string" && s.length > 0 && s.length <= 1024,
      ))
  )
    throw new Error("Handoff model must be null or an exact provider/id pair.");
  return {
    enabled: value.enabled,
    threshold: value.threshold,
    model: value.model,
  };
}
async function contents(path: string) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(
        "Handoff config is a symlink; edit its target rather than replacing the link.",
      );
    const data = await readFile(path, "utf8");
    if (Buffer.byteLength(data) > 16384)
      throw new Error("Handoff config exceeds 16 KiB.");
    return data;
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
export async function loadSettings(path = settingsPath()) {
  const data = await contents(path);
  return parseSettings(data === undefined ? {} : JSON.parse(data));
}
export async function saveSettings(
  edit: Partial<Settings>,
  path = settingsPath(),
) {
  const before = await contents(path);
  const raw = before === undefined ? {} : JSON.parse(before);
  parseSettings(raw);
  const next = { ...raw, ...edit };
  const result = parseSettings(next);
  const data = JSON.stringify(next, null, 2) + "\n";
  if (Buffer.byteLength(data) > 16384)
    throw new Error("Handoff config exceeds 16 KiB.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    if ((await contents(path)) !== before)
      throw new Error(
        "Handoff config changed while editing; reopen Settings and retry.",
      );
    await rename(temporary, path);
    return result;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
