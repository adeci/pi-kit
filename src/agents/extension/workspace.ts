import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  lstat,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Workspace } from "./types";

const installedGit = join(
  dirname(realpathSync(fileURLToPath(import.meta.url))),
  "..",
  "git",
);

export async function git(
  cwd: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    input?: string;
    maxBytes?: number;
  } = {},
): Promise<string> {
  return new Promise((done, reject) => {
    const env = { ...process.env };
    for (const name of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
    ])
      delete env[name];
    const child = spawn(
      existsSync(installedGit) ? installedGit : "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-C",
        cwd,
        ...args,
      ],
      {
        env: { ...env, GIT_TERMINAL_PROMPT: "0", ...options.env },
        stdio: "pipe",
      },
    );
    const max = options.maxBytes ?? 32 * 1024 * 1024;
    let output = Buffer.alloc(0),
      error = "",
      failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("Git operation timed out");
      child.kill("SIGKILL");
    }, 60000);
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > max) {
        failure = new Error(
          "Git output exceeds configured snapshot/patch limit",
        );
        child.kill("SIGKILL");
      } else output = Buffer.concat([output, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      error = (error + chunk.toString()).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0)
        reject(failure ?? new Error(`git ${args[0]} failed: ${error.trim()}`));
      else {
        try {
          done(new TextDecoder("utf-8", { fatal: true }).decode(output));
        } catch {
          reject(
            new Error(
              "Git snapshot/diff output is not UTF-8; refusing a lossy workspace or patch.",
            ),
          );
        }
      }
    });
  });
}
export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}
export async function snapshotTree(
  cwd: string,
  maxBytes: number,
): Promise<string> {
  const root = await repoRoot(cwd);
  const entries = await git(root, ["ls-files", "--stage"]);
  if (/^160000 /m.test(entries))
    throw new Error(
      "Submodule snapshots are unsupported; use an explicitly shared checkout if appropriate.",
    );
  const paths = await git(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const attributes = (
    await git(root, ["check-attr", "-z", "--stdin", "filter"], { input: paths })
  ).split("\0");
  for (let index = 2; index < attributes.length; index += 3)
    if (!["unspecified", "unset"].includes(attributes[index]))
      throw new Error(
        "External Git filters are unsupported by workspace snapshots; use an explicitly shared checkout if appropriate.",
      );
  const changed =
    (await git(root, ["diff", "--name-only", "HEAD", "-z"])) +
    (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  let bytes = 0;
  for (const path of new Set(changed.split("\0").filter(Boolean))) {
    try {
      bytes += (await lstat(join(root, path))).size;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    if (bytes > maxBytes)
      throw new Error(
        `Uncommitted snapshot exceeds ${maxBytes} bytes; commit or ignore bulk before isolated delegation.`,
      );
  }
  const index = join(
    (await git(root, ["rev-parse", "--absolute-git-dir"])).trim(),
    `pi-agents-index-${randomBytes(8).toString("hex")}`,
  );
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(root, ["read-tree", "HEAD"], { env });
    await git(root, ["add", "--all", "--", "."], { env });
    return (await git(root, ["write-tree"], { env })).trim();
  } finally {
    await unlink(index).catch(() => {});
    await unlink(`${index}.lock`).catch(() => {});
  }
}
export async function createWorkspace(
  cwd: string,
  directory: string,
  maxBytes: number,
): Promise<{ workspace: Workspace; cwd: string }> {
  const source = await repoRoot(cwd);
  const placement = relative(source, resolve(directory));
  if (!(
    placement === ".." ||
    placement.startsWith("../") ||
    isAbsolute(placement)
  ))
    throw new Error(
      "Agent state/workspace directory must be outside the caller repository.",
    );
  const head = (await git(source, ["rev-parse", "HEAD"])).trim();
  const initialTree = await snapshotTree(source, maxBytes);
  const commit = (
    await git(source, ["commit-tree", initialTree, "-p", head], {
      input: "pi-agents private working-state baseline\n",
      env: {
        GIT_AUTHOR_NAME: "pi-agents",
        GIT_AUTHOR_EMAIL: "pi-agents@localhost",
        GIT_COMMITTER_NAME: "pi-agents",
        GIT_COMMITTER_EMAIL: "pi-agents@localhost",
      },
    })
  ).trim();
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await git(source, ["worktree", "add", "--detach", directory, commit]);
    if (
      (await git(source, ["rev-parse", "HEAD"])).trim() !== head ||
      (await snapshotTree(source, maxBytes)) !== initialTree
    )
      throw new Error(
        "Caller working state changed during snapshot; isolated launch refused.",
      );
    return {
      workspace: { source, directory, head, initialTree },
      cwd: resolve(directory, relative(source, cwd)),
    };
  } catch (error) {
    await git(source, ["worktree", "remove", "--force", directory]).catch(
      () => {},
    );
    throw error;
  }
}
export async function capturePatch(
  workspace: Workspace,
  baseline: string,
  path: string,
  maxBytes: number,
): Promise<string> {
  const tree = await snapshotTree(workspace.directory, maxBytes);
  const patch = await git(
    workspace.directory,
    ["diff", "--binary", "--no-ext-diff", baseline, tree],
    { maxBytes },
  );
  await writeFile(path, patch, { mode: 0o600 });
  return patch;
}
export async function integrate(
  workspace: Workspace,
  path: string,
): Promise<void> {
  const patch = await readFile(path, "utf8");
  if (!patch.trim()) return;
  // No --index, --3way, stash, reset, or commits: preserve the caller's index.
  // git apply is atomic unless --reject is supplied; conflicts leave all paths unchanged.
  await git(workspace.source, ["apply", "--check", "--binary", "-"], {
    input: patch,
  });
  await git(workspace.source, ["apply", "--binary", "-"], { input: patch });
}
export async function removeWorkspace(workspace: Workspace): Promise<void> {
  await git(workspace.source, [
    "worktree",
    "remove",
    "--force",
    workspace.directory,
  ]);
  await rm(workspace.directory, { recursive: true, force: true });
}
