import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Freeze explicitly selected skill packages before they enter the startup queue. */
export async function snapshotSkills(
  paths: string[],
  directory: string,
): Promise<string[]> {
  const snapshots: string[] = [];
  let bytes = 0,
    files = 0;
  for (const [index, path] of paths.entries()) {
    const resolved = await realpath(path);
    const source = (await stat(resolved)).isDirectory()
      ? resolved
      : dirname(resolved);
    if (
      !(await stat(resolved)).isDirectory() &&
      basename(resolved) !== "SKILL.md"
    )
      throw new Error(
        "Select individual SKILL.md files or skill package directories",
      );
    const target = join(directory, String(index));
    const copy = async (from: string, to: string, depth: number) => {
      if (depth > 12) throw new Error("Skill package exceeds depth limit");
      const before = await lstat(from);
      if (
        before.isSymbolicLink() ||
        (!before.isDirectory() && !before.isFile())
      )
        throw new Error(
          "Selected skill contains a link or special entry; use a self-contained package",
        );
      if (before.isDirectory()) {
        await mkdir(to, { recursive: true, mode: 0o700 });
        for (const name of (await readdir(from)).sort())
          await copy(join(from, name), join(to, name), depth + 1);
      } else {
        if (++files > 2048 || (bytes += before.size) > 16 * 1024 * 1024)
          throw new Error("Selected skills exceed 2048 files or 16 MiB");
        const data = await readFile(from),
          after = await lstat(from);
        if (
          before.ino !== after.ino ||
          before.dev !== after.dev ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          data.length !== before.size
        )
          throw new Error("Selected skill changed during snapshot");
        await writeFile(to, data, {
          mode: before.mode & 0o100 ? 0o700 : 0o600,
        });
      }
    };
    await copy(source, target, 0);
    await stat(join(target, "SKILL.md"));
    snapshots.push(join(target, "SKILL.md"));
  }
  return snapshots;
}
