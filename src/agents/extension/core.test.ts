import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, narrow, resolveModel } from "./config";
import {
  capturePatch,
  createWorkspace,
  git,
  integrate,
  removeWorkspace,
  snapshotTree,
} from "./workspace";
import { listen, request } from "./control";
import { snapshotSkills } from "./skills";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "pi-agents-test-"));
  directories.push(path);
  return path;
}
async function repository() {
  const base = await temporary(),
    source = join(base, "repo");
  await mkdir(source);
  await git(source, ["init"]);
  await git(source, ["config", "user.name", "Fixture"]);
  await git(source, ["config", "user.email", "fixture@localhost"]);
  await writeFile(join(source, "tracked.txt"), "base\n");
  await writeFile(join(source, ".gitignore"), "*.secret\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "base"]);
  return { base, source };
}
test("OMP-style defaults and exact role resolution without fallback", async () => {
  const directory = await temporary();
  const path = join(directory, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      roles: { task: { model: "fixture/exact" } },
      maxConcurrency: 2,
    }),
  );
  const config = await loadConfig(path);
  expect(config.maxDepth).toBe(2);
  expect(config.maxConcurrency).toBe(2);
  expect(config.roles.task.maxConcurrency).toBe(2);
  expect(config.roles.task.requestBudget).toBe(200);
  expect(config.roles.scout.requestBudget).toBe(100);
  expect(config.idleTtlMs).toBe(420000);
  expect(
    resolveModel({ task: "x" }, config.roles.task, [
      { provider: "fixture", id: "exact" },
    ]),
  ).toBe("fixture/exact");
  expect(() =>
    resolveModel({ task: "x", model: "fixture/other" }, config.roles.task, [
      { provider: "fixture", id: "exact" },
    ]),
  ).toThrow("no fallback");
  expect(config.roles.scout.model).toBeNull();
  expect(() => resolveModel({ task: "x" }, config.roles.scout, [])).toThrow(
    "not configured",
  );
  expect(() => narrow(["write"], ["read"], "tools")).toThrow("role maximum");
});
test("invalid concurrency and malformed role settings fail clearly", async () => {
  const path = join(await temporary(), "config.json");
  await writeFile(path, JSON.stringify({ maxConcurrency: -1 }));
  await expect(loadConfig(path)).rejects.toThrow("maxConcurrency");
  await writeFile(
    path,
    JSON.stringify({ roles: { task: { tools: ["read", "read"] } } }),
  );
  await expect(loadConfig(path)).rejects.toThrow("tools");
});
test("isolated baseline includes dirty and untracked files, excludes ignored files and preserves caller index", async () => {
  const { base, source } = await repository();
  await writeFile(join(source, "tracked.txt"), "staged\n");
  await git(source, ["add", "tracked.txt"]);
  await writeFile(join(source, "tracked.txt"), "working\n");
  await writeFile(join(source, "draft.txt"), "untracked\n");
  await writeFile(join(source, "token.secret"), "excluded\n");
  const index = await git(source, ["ls-files", "--stage"]),
    head = await git(source, ["rev-parse", "HEAD"]);
  const { workspace } = await createWorkspace(
    source,
    join(base, "isolated"),
    1024 * 1024,
  );
  expect(await readFile(join(workspace.directory, "tracked.txt"), "utf8")).toBe(
    "working\n",
  );
  expect(await readFile(join(workspace.directory, "draft.txt"), "utf8")).toBe(
    "untracked\n",
  );
  await expect(
    readFile(join(workspace.directory, "token.secret")),
  ).rejects.toThrow();
  expect(await git(source, ["ls-files", "--stage"])).toBe(index);
  expect(await git(source, ["rev-parse", "HEAD"])).toBe(head);
  await removeWorkspace(workspace);
});
test("returned diff contains only agent changes; integration is atomic on conflict and does not stage", async () => {
  const { base, source } = await repository();
  await writeFile(join(source, "tracked.txt"), "staged\n");
  await git(source, ["add", "tracked.txt"]);
  await writeFile(join(source, "tracked.txt"), "working\n");
  await writeFile(join(source, "draft.txt"), "original draft\n");
  const index = await git(source, ["ls-files", "--stage"]);
  const { workspace } = await createWorkspace(
    source,
    join(base, "isolated"),
    1024 * 1024,
  );
  const baseline = await snapshotTree(workspace.directory, 1024 * 1024);
  await writeFile(join(workspace.directory, "tracked.txt"), "agent\n");
  await writeFile(join(workspace.directory, "new.txt"), "new\n");
  const path = join(base, "result.patch"),
    patch = await capturePatch(workspace, baseline, path, 1024 * 1024);
  expect(patch).not.toContain("draft.txt");
  expect(patch).toContain("-working");
  await writeFile(join(source, "tracked.txt"), "conflicting\n");
  await expect(integrate(workspace, path)).rejects.toThrow();
  expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe(
    "conflicting\n",
  );
  await expect(readFile(join(source, "new.txt"))).rejects.toThrow();
  await writeFile(join(source, "tracked.txt"), "working\n");
  await integrate(workspace, path);
  expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("agent\n");
  expect(await git(source, ["ls-files", "--stage"])).toBe(index);
  await removeWorkspace(workspace);
});
test("oversized dirty snapshots refuse isolation without dropping files", async () => {
  const { base, source } = await repository();
  await writeFile(join(source, "large.txt"), "x".repeat(2048));
  await expect(
    createWorkspace(source, join(base, "isolated"), 1024),
  ).rejects.toThrow("snapshot exceeds");
});
test("skill packages are frozen and internal links are refused", async () => {
  const base = await temporary(),
    source = join(base, "skill");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "original");
  const [copy] = await snapshotSkills([source], join(base, "copies"));
  await writeFile(join(source, "SKILL.md"), "changed");
  expect(await readFile(copy, "utf8")).toBe("original");
  await symlink(join(source, "SKILL.md"), join(source, "reference"));
  await expect(snapshotSkills([source], join(base, "bad"))).rejects.toThrow(
    "link",
  );
});
test("snapshots refuse unsupported filters rather than invoke hooks or omit file content", async () => {
  const { base, source } = await repository();
  await writeFile(
    join(source, ".gitattributes"),
    "tracked.txt filter=fixture\n",
  );
  await expect(
    createWorkspace(source, join(base, "isolated"), 1024),
  ).rejects.toThrow("External Git filters");
});
test("control socket rejects stale capabilities and cancellation does not cancel accepted work", async () => {
  const socket = join(await temporary(), "c.sock");
  let accepted = 0;
  const server = await listen(
    socket,
    (id, token, assignment) => {
      if (id !== "child" || token !== "current" || assignment !== "child:1")
        throw new Error("stale attachment");
    },
    async (_id, operation) => {
      accepted++;
      if (operation === "slow")
        await new Promise((resolve) => setTimeout(resolve, 50));
      return { accepted };
    },
  );
  try {
    await expect(
      request(
        { id: "child", socket, token: "stale", assignment: "child:1" },
        "status",
      ),
    ).rejects.toThrow("stale");
    await expect(
      request(
        { id: "child", socket, token: "current", assignment: "child:0" },
        "status",
      ),
    ).rejects.toThrow("stale");
    const controller = new AbortController();
    const operation = request(
      { id: "child", socket, token: "current", assignment: "child:1" },
      "slow",
      {},
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(operation).rejects.toThrow("not cancelled");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(accepted).toBe(1);
  } finally {
    await server.close();
  }
});
