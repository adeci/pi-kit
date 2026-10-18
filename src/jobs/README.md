# Jobs

[Setup](../../docs/usage.md)

## Daemon setup

After deploying, check `systemctl --user status pi-jobs-pueue.service`. The service leaves scheduling to Pueue and preserves existing configuration values. It adds the completion callback only if no callback is configured; an existing custom callback is left unchanged. Use `pueue --config "$(pi-jobs config-path)" parallel N` to change concurrency yourself. User lingering is a separate choice if execution must continue after the last login session ends.

Without the module:

```sh
pi-jobs init --callbacks
pueued --config "$(pi-jobs config-path)"
```

Run the daemon in another terminal. Once it is running, use `pi-jobs doctor` before attaching watches. This explicit check submits a no-op with an empty environment, tests the running callback, and removes the finished probe. It does not restart Pueue or change scheduling settings. The readiness record is tied to the daemon socket and expires after a restart; it stores no watches or notifications. The managed NixOS and nix-darwin services run this check automatically after every daemon start (on NixOS as the separate `pi-jobs-doctor.service`, so a failed check never fails the daemon); run it by hand only for a daemon you start yourself. A missing publisher is reported separately and disables watch registration, not job execution.

`init` requires `XDG_RUNTIME_DIR` and Bash on `PATH`. For notifications, the daemon also needs `pi-jobs` and `pi-events` on `PATH`. Configure the hook before starting Pueue; changing its file does not activate it in an already-running daemon. Do not restart Pueue while relying on active jobs surviving. `init --callbacks` never overwrites a custom callback. A custom or chained hook can be used if it invokes the same numeric-ID helper and passes `doctor`.

Managed configs resolve `bash` through the daemon PATH. Notification helpers use the daemon's current `PATH`/`PI_EVENTS_BIN`. Missing executables produce diagnostics; they never delete the result. Keep executable paths and Nix generations available while jobs run.

## Run and manage jobs

With both extensions loaded:

```sh
printf '%s\n' 'nix build .#some-package' | pi-jobs run --name build
printf '%s\n' 'nix flake check' | pi-jobs run --detach --name checks
pi-jobs status HANDLE
pi-jobs log HANDLE
pi-jobs wait HANDLE --timeout 10
pi-jobs stop HANDLE
```

Use the full `ID:INCARNATION` handle. The CLI checks owner and incarnation before reading or controlling a job. Outside Pi, set `PI_JOBS_SESSION` explicitly. Session ownership is a control safeguard, not isolation from other programs running as your user.

`run` is foreground-first: it submits the job, streams its output, and exits with the job's own exit code if it finishes within `--timeout` seconds (default 90, below the 120-second foreground Bash cap). A run still going at its deadline detaches: it exits 75, prints the handle and how to resume, and leaves its completion watch to deliver the result. The watch is armed at submission, so a run that finishes in the foreground consumes its own notice and never produces one. `run --detach` exits 0 and arms the watch immediately; use it to start something and move on. `wait` streams the same way (default 90 seconds); at its deadline it also exits 75 and leaves execution running, keeping whatever watch the job already has: it never arms a second one. Exit 75 always means "still running, detached". Finished commands preserve their exit code. `stop` is explicit; stopping an unstarted job removes its record, which then reports `unavailable`. Native Pueue clients bypass the jobs CLI's control lock.

Detached jobs (`--detach`, or a run that reached its deadline) attach a live watch when both extensions are available. `--check-in SECONDS` adds display-only progress notifications; intervals must be 10–604800 seconds. The loaded jobs extension includes this CLI guidance in Pi's system prompt even when skills are disabled. It also guards foreground Bash: known long-running commands (Nix builds and toplevel evaluations, system rebuilds, cargo/npm builds and tests, container builds) are refused with an instruction to run them with `pi-jobs run`, and other foreground calls without an explicit timeout get a 120-second timeout. `pi-jobs` commands get no injected timeout, and an explicit one below 120 seconds is raised to 120, so a Bash timeout cannot cut a foreground run short of its own deadline. Because the watch is armed at submission, a foreground run killed by Escape or a timeout still reports back when the job finishes. In interactive Pi a one-line indicator above the editor lists what the session is listening for, for example `◉ listening  build-x 1m12s · checks 20s · 2 new`: armed job watches with elapsed time, and quiet results that arrived since your last prompt. It is hidden when nothing is armed or new. Agent watches stay in the Subagents widget. At session start the extension runs the read-only `pi-jobs health` check and adds a warning to the prompt when Pueue is not ready; it never starts the daemon or runs `doctor` itself. `/jobs` opens the job selector in interactive Pi; `/jobs watch HANDLE [SECONDS]` and `/jobs unwatch HANDLE` manage watches. Closing Pi discards watches. Pueue invokes a short-lived helper with only the numeric task ID. The helper resolves the protected handle and sends `job.changed` to live observers; the extension verifies its active watch and reads the terminal result before notifying Pi. Registration checks status immediately to catch fast jobs. Detached live-watch completion does not poll; only explicitly requested progress check-ins use timers. Foreground `run`/`wait` still polls status and streams logs. Queued removals send a signal from `stop`, because Pueue does not call its callback for removed tasks. Jobs and logs remain in Pueue: inspect them or explicitly watch them again after reopening. Completed records and logs have no automatic retention policy yet. There is no promise that a running command survives a machine reboot or Pueue failure.

Commands inherit the submitting environment, which Pueue retains alongside task records and logs. That can include credentials and old executable paths. Omit sensitive variables deliberately, for example `printf 'make\n' | env -u API_TOKEN pi-jobs run --detach`; do not dump task environments into an agent conversation. Required command dependencies and Nix generations must remain available while jobs run.

There is no automatic cleanup. Use `pi-jobs status` to inspect your owned jobs, then `pi-jobs forget HANDLE` to delete an explicitly selected finished job, its logs, and its captured environment. `forget` refuses active jobs and checks the full owner/incarnation handle. Keep results you still need; cleanup is not a side effect of closing Pi or unwatching.

Submission and watch registration are separate operations. If notification setup fails, the submitted job still exists. Inspect it instead of resubmitting. `unwatch` does not recall an already accepted completion.

Finished jobs are quiet. While Pi is busy, the events extension holds the notice and appends it at the next tool boundary, so it lands before the model's final answer without an extra request; one that arrives during the final answer is appended after it, again without a new turn. When Pi is idle the card is shown and the notice joins the context for your next prompt; it never starts a turn by itself. Reading the result yourself counts as receiving it, structurally rather than by matching output: when `pi-jobs status`, `wait` or `log` reports a finished job owned by this session, the CLI sends a `job.consumed` signal to the live attachment. The extension drops the watch and withdraws the pending notice, including one that arrives after the read. An explicit `pi-jobs watch HANDLE` wants the result again and re-arms it. Running status, wait timeouts and logs of unfinished jobs send nothing. `wait` and `log` still print `job=HANDLE STATE exit=CODE` on stderr for the reader. Job execution and retained logs are unchanged.
