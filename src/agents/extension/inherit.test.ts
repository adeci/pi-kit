import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { childResourceArgs, parentResources } from "./inherit";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

test("forwards the parent's explicit resources and discovery flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agents-inherit-"));
  directories.push(root);
  await mkdir(join(root, "provider"));
  await writeFile(join(root, "provider", "index.ts"), "");
  await mkdir(join(root, "skill"));
  await writeFile(join(root, "skill", "SKILL.md"), "");
  const parent = parentResources(
    [
      "/usr/bin/node",
      "/opt/pi/cli.js",
      "--no-extensions",
      "-e",
      "./provider/index.ts",
      "--extension=builtin:mcp",
      "--skill",
      "skill/SKILL.md",
      "--model",
      "anthropic/x",
    ],
    root,
  );
  expect(parent).toEqual({
    extensions: [join(root, "provider", "index.ts"), "builtin:mcp"],
    skills: [join(root, "skill", "SKILL.md")],
    noExtensions: true,
    noSkills: false,
  });
  expect(
    childResourceArgs(
      parent,
      {
        extension: "/kit/child.ts",
        extensions: ["./provider/index.ts", "/role/extra.ts"],
        skills: ["/snapshots/0/SKILL.md"],
      },
      root,
    ),
  ).toEqual([
    "--no-extensions",
    "--extension",
    "/kit/child.ts",
    "--extension",
    join(root, "provider", "index.ts"),
    "--extension",
    "builtin:mcp",
    "--extension",
    "/role/extra.ts",
    "--skill",
    join(root, "skill", "SKILL.md"),
    "--skill",
    "/snapshots/0/SKILL.md",
  ]);
});

test("keeps discovery enabled when the parent did not disable it", () => {
  const parent = parentResources(["pi", "--model", "a/b"], "/");
  expect(
    childResourceArgs(
      parent,
      { extension: "/kit/child.ts", extensions: [], skills: [] },
      "/",
    ),
  ).toEqual(["--extension", "/kit/child.ts"]);
});

test("deduplicates resources by real path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agents-inherit-"));
  directories.push(root);
  await writeFile(join(root, "fixture.ts"), "");
  await symlink(join(root, "fixture.ts"), join(root, "link.ts"));
  const parent = parentResources(["pi", "-e", join(root, "link.ts")], root);
  expect(
    childResourceArgs(
      parent,
      {
        extension: "/kit/child.ts",
        extensions: [join(root, "fixture.ts")],
        skills: [],
      },
      root,
    ),
  ).toEqual([
    "--extension",
    "/kit/child.ts",
    "--extension",
    join(root, "fixture.ts"),
  ]);
});
