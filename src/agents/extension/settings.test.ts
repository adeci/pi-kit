import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  stat,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { editSettings, conversation } from "./settings";

test("settings edits preserve raw paths/unknown fields and reject invalid or concurrent edits", async () => {
  const dir = await mkdtemp("/tmp/pa-settings-");
  const path = join(dir, "agents.json");
  try {
    await writeFile(join(dir, "prompt.md"), "Custom prompt");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        custom: "keep",
        note: "User-owned setting",
        roles: { task: { promptFile: "prompt.md" } },
      }),
    );
    await editSettings((raw) => {
      raw.roles.task.model = "fixture/task";
    }, path);
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.custom).toBe("keep");
    expect(raw.note).toBe("User-owned setting");
    expect(raw.roles.task).toEqual({
      promptFile: "prompt.md",
      model: "fixture/task",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const before = await readFile(path, "utf8");
    await expect(
      editSettings((raw) => {
        raw.maxConcurrency = -1;
      }, path),
    ).rejects.toThrow("maxConcurrency");
    expect(await readFile(path, "utf8")).toBe(before);
    await expect(
      editSettings((raw) => {
        raw.maxConcurrency = 4;
        writeFileSync(path, before + " ");
      }, path),
    ).rejects.toThrow("changed while editing");
    expect(await readFile(path, "utf8")).toBe(before + " ");
    await symlink(path, join(dir, "link.json"));
    await expect(
      editSettings(() => {}, join(dir, "link.json")),
    ).rejects.toThrow("symlink");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("conversation renders Pi messages/tools, not raw session JSON, with a live tail", () => {
  const lines = conversation(
    [
      JSON.stringify({ type: "session", id: "private-header" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Finding" },
            { type: "toolCall", name: "read", arguments: { path: "file" } },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "Contents" }],
        },
      }),
    ].join("\n"),
    "Live answer",
  );
  expect(lines.join("\n")).toContain("Assistant");
  expect(lines.join("\n")).toContain("→ read");
  expect(lines.join("\n")).toContain("Live answer");
  expect(lines.join("\n")).not.toContain("private-header");
});
