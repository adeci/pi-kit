// Foreground bash blocks the conversation. Commands that routinely take
// minutes go through Pueue instead; everything else gets a timeout backstop.

/** Default timeout, in seconds, for foreground bash calls that set none. */
export const DEFAULT_BASH_TIMEOUT = 120;

// Curated rather than exhaustive: each pattern is routinely slow (builds,
// system evaluations, dependency installs). A false positive costs one
// resubmission through pi-jobs; a miss blocks the conversation for minutes.
const LONG_RUNNING: [RegExp, string][] = [
  [/\bnix\s+(build|flake\s+check|copy)\b/, "nix build/check/copy"],
  [/\bnix-build\b/, "nix-build"],
  [/\b(nixos|darwin)-rebuild\b/, "system rebuild"],
  [/\bclan\s+machines\s+(update|install)\b/, "clan deployment"],
  [/\bnix\s+eval\b[^\n;&|]*\.toplevel\b/, "system toplevel evaluation"],
  [/\bcargo\s+(build|test|clippy)\b/, "cargo build/test"],
  [
    /\b(npm|pnpm|yarn)\s+(ci|install|test)\b/,
    "dependency install or test suite",
  ],
  [/\b(docker|podman)\s+build\b/, "container build"],
];

const PI_JOBS = /(^|[\s;&|(])pi-jobs(\s|$)/;

export interface DaemonState {
  ok: boolean;
  detail: string;
}

/** Returns a short label when a command is known to be long-running. */
export function longRunning(command: string): string | undefined {
  if (PI_JOBS.test(command)) return undefined;
  return LONG_RUNNING.find(([pattern]) => pattern.test(command))?.[1];
}

/**
 * Inspect a bash tool call. Returns a block result for long-running commands,
 * and otherwise sets a default timeout on the input in place.
 */
export function guardBash(
  input: { command?: unknown; timeout?: unknown },
  daemon: DaemonState | undefined,
): { block: true; reason: string } | undefined {
  const command = typeof input.command === "string" ? input.command : "";
  const label = longRunning(command);
  if (label) {
    const reason =
      daemon && !daemon.ok
        ? `This is a long-running command (${label}), but pi-jobs is not ready: ${daemon.detail} If only the callback is unverified, run pi-jobs doctor and retry; otherwise tell the user. Do not run long commands in foreground bash.`
        : `This is a long-running command (${label}). Run it with pi-jobs run --name NAME (command text on stdin): it streams output and returns the exit code if it finishes within 90 seconds, otherwise it detaches with exit 75 and you are notified when it finishes. Use pi-jobs run --detach to start it and move on. Do not run it in foreground bash.`;
    return { block: true, reason };
  }
  if (PI_JOBS.test(command)) {
    // pi-jobs run/wait detach on their own 90-second deadline and arm a watch.
    // A shorter bash timeout would kill the CLI first (SIGKILL), leaving the
    // job running with no watch, so never let one undercut that deadline.
    if (
      typeof input.timeout === "number" &&
      input.timeout < DEFAULT_BASH_TIMEOUT
    )
      input.timeout = DEFAULT_BASH_TIMEOUT;
  } else if (input.timeout === undefined || input.timeout === null)
    input.timeout = DEFAULT_BASH_TIMEOUT;
  return undefined;
}
