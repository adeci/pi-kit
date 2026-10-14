import { test, expect } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaults,
  loadSettings,
  parseSettings,
  saveSettings,
  thresholdInput,
} from "./settings";

test("defaults and exact model settings", () => {
  expect(parseSettings({})).toEqual(defaults);
  expect(
    parseSettings({
      model: { provider: "provider", id: "org/model" },
      threshold: 65,
      enabled: false,
    }).model?.id,
  ).toBe("org/model");
});
for (const raw of [
  null,
  [],
  { enabled: "yes" },
  { threshold: 0 },
  { threshold: 100 },
  { threshold: 80.5 },
  { model: "alias" },
  { model: { provider: "p", id: "" } },
])
  test(`reject invalid settings ${JSON.stringify(raw)}`, () => {
    expect(() => parseSettings(raw)).toThrow();
  });
test("freeform threshold accepts whole percentages only; empty and invalid input have no value", () => {
  for (const number of [1, 9, 80, 96, 99]) {
    expect(parseSettings({ threshold: number }).threshold).toBe(number);
    expect(thresholdInput(String(number))).toBe(number);
    expect(thresholdInput(` ${number}% `)).toBe(number);
  }
  for (const value of [
    undefined,
    "",
    " ",
    "0",
    "100",
    "-1",
    "80.5",
    "1e1",
    "0x10",
    "NaN",
    "20%%",
    "abc",
  ])
    expect(thresholdInput(value)).toBeUndefined();
});
test("settings writes preserve unknown fields, stay private and refuse symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "handoff-settings-"));
  const path = join(directory, "handoff.json");
  try {
    expect(await loadSettings(path)).toEqual(defaults);
    await writeFile(path, JSON.stringify({ other: { keep: true } }));
    await saveSettings({ threshold: 70 }, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      other: { keep: true },
      threshold: 70,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(saveSettings({ threshold: 0 }, path)).rejects.toThrow();
    const link = join(directory, "link.json");
    await symlink(path, link);
    await expect(loadSettings(link)).rejects.toThrow("symlink");
    await expect(saveSettings({ enabled: false }, link)).rejects.toThrow(
      "symlink",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
