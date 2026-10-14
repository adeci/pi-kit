import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { configPath, loadConfig } from "./config";

async function contents(path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(
        "Agents config is a symlink; edit its target rather than replacing the link.",
      );
    const data = await readFile(path);
    if (data.length > 262144) throw new Error("Agents config exceeds 256 KiB");
    return data.toString("utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function rawSettings(path = configPath()) {
  const data = await contents(path);
  return data === undefined ? { version: 1 } : JSON.parse(data);
}

/** Keep unknown settings and relative resource paths; never persist expanded defaults. */
export async function editSettings(
  edit: (raw: any) => void,
  path = configPath(),
) {
  const before = await contents(path);
  const raw = before === undefined ? { version: 1 } : JSON.parse(before);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Agents config must be an object");
  edit(raw);
  const data = JSON.stringify(raw, null, 2) + "\n";
  if (Buffer.byteLength(data) > 262144)
    throw new Error("Agents config exceeds 256 KiB");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    const config = await loadConfig(temporary);
    if ((await contents(path)) !== before)
      throw new Error(
        "Agents config changed while editing; reopen Settings and retry.",
      );
    await rename(temporary, path);
    return config;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function conversation(text: string, streaming = ""): string[] {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "message" || !record.message) continue;
    const message = record.message;
    rows.push(
      message.role === "assistant"
        ? "Assistant"
        : message.role === "toolResult"
          ? `Tool · ${message.toolName ?? "result"}${message.isError ? " · error" : ""}`
          : message.role === "user"
            ? "Assignment / guidance"
            : "Context",
    );
    if (typeof message.content === "string") rows.push(message.content);
    else
      for (const block of message.content ?? []) {
        if (block.type === "text") rows.push(block.text);
        else if (block.type === "thinking")
          rows.push(`Thinking: ${block.thinking}`);
        else if (block.type === "toolCall")
          rows.push(
            `→ ${block.name}\n${JSON.stringify(block.arguments, null, 2)}`,
          );
      }
    rows.push("");
  }
  if (streaming) rows.push("Assistant · streaming", streaming.slice(-8192));
  return rows.length
    ? rows.flatMap((row) => row.split("\n"))
    : ["Waiting for the first turn…"];
}
