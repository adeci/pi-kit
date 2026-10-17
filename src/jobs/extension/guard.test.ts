import { expect, test } from "bun:test";
import { DEFAULT_BASH_TIMEOUT, guardBash, longRunning } from "./guard";

test("known long-running commands are detected", () => {
  for (const command of [
    "nix build .#packages.x86_64-linux.handy --no-link",
    "set -e; nix flake check",
    "nixos-rebuild switch --flake .",
    "nix eval .#nixosConfigurations.modus.config.system.build.toplevel.drvPath",
    "cd src && cargo test --release",
    "pnpm install",
    "docker build -t x .",
  ])
    expect(longRunning(command)).toBeString();
});

test("quick commands and pi-jobs submissions pass", () => {
  for (const command of [
    "git status --short",
    "rg -n 'system.build.toplevel' modules",
    "nix eval .#packages.x86_64-linux.handy.meta.mainProgram --raw",
    "printf 'nix build .#x\\n' | pi-jobs run --detach --name build",
    "pi-jobs wait 3:" + "a".repeat(32) + " --timeout 30",
  ])
    expect(longRunning(command)).toBeUndefined();
});

test("long commands are refused with a daemon-aware reason", () => {
  const input = { command: "nix build .#x" };
  expect(guardBash(input, { ok: true, detail: "" })?.reason).toContain(
    "pi-jobs run --detach",
  );
  const down = guardBash(input, {
    ok: false,
    detail: "Pueue unavailable at /run/user/1/pi-jobs/pueue/socket.",
  });
  expect(down?.block).toBe(true);
  expect(down?.reason).toContain("Pueue unavailable");
  expect(down?.reason).toContain("Do not run long commands in foreground bash");
});

test("other foreground commands get a timeout backstop", () => {
  const input: { command: string; timeout?: number } = { command: "ls" };
  expect(guardBash(input, undefined)).toBeUndefined();
  expect(input.timeout).toBe(DEFAULT_BASH_TIMEOUT);
  const explicit = { command: "ls", timeout: 5 };
  guardBash(explicit, undefined);
  expect(explicit.timeout).toBe(5);
  const wait: { command: string; timeout?: number } = {
    command: "pi-jobs wait 1:" + "a".repeat(32),
  };
  guardBash(wait, undefined);
  expect(wait.timeout).toBeUndefined();
});
