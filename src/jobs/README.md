# Jobs

[Setup](../../docs/usage.md)

## Daemon setup

After deploying, check `systemctl --user status pi-jobs-pueue.service`. The service leaves scheduling to Pueue and preserves existing configuration values. It adds the completion callback only if no callback is configured; an existing custom callback is left unchanged. Use `pueue --config "$(pi-jobs config-path)" parallel N` to change concurrency yourself. User lingering is a separate choice if execution must continue after the last login session ends.

Without the module:

```sh
pi-jobs init --callbacks
pueued --config "$(pi-jobs config-path)"
```

Run the daemon in another terminal. Once it is running, use `pi-jobs doctor` before attaching watches. This explicit check submits a no-op with an empty environment, tests the running callback, and removes the finished probe. It does not restart Pueue or change scheduling settings. The readiness record is tied to the daemon socket and expires after a restart; it stores no watches or notifications. A missing publisher is reported separately and disables watch registration, not job execution.

`init` requires `XDG_RUNTIME_DIR` and Bash on `PATH`. For notifications, the daemon also needs `pi-jobs` and `pi-events` on `PATH`. Configure the hook before starting Pueue; changing its file does not activate it in an already-running daemon. Do not restart Pueue while relying on active jobs surviving. `init --callbacks` never overwrites a custom callback. A custom or chained hook can be used if it invokes the same numeric-ID helper and passes `doctor`.

Managed configs resolve `bash` through the daemon PATH. Notification helpers use the daemon's current `PATH`/`PI_EVENTS_BIN`. Missing executables produce diagnostics; they never delete the result. Keep executable paths and Nix generations available while jobs run.

## Run and manage jobs

With both extensions loaded:

```sh
printf '%s\n' 'nix build .#some-package' | pi-jobs run --detach --name build
pi-jobs status HANDLE
pi-jobs log HANDLE
pi-jobs wait HANDLE --timeout 10
pi-jobs stop HANDLE
```

Use the full `ID:INCARNATION` handle. The CLI checks owner and incarnation before reading or controlling a job. Outside Pi, set `PI_JOBS_SESSION` explicitly. Session ownership is a control safeguard, not isolation from other programs running as your user.

A wait timeout exits 0 and leaves execution running. Finished commands preserve their exit code. `stop` is explicit; stopping an unstarted job removes its record, which then reports `unavailable`. Native Pueue clients bypass the jobs CLI's control lock.

Detached submissions attach a live watch when both extensions are available. `--check-in SECONDS` adds display-only progress notifications; intervals must be 10–604800 seconds. The loaded jobs extension includes this CLI guidance in Pi's system prompt even when skills are disabled. `/jobs` opens the job selector in interactive Pi; `/jobs watch HANDLE [SECONDS]` and `/jobs unwatch HANDLE` manage watches. Closing Pi discards watches. Pueue invokes a short-lived helper with only the numeric task ID. The helper resolves the protected handle and sends `job.changed` to live observers; the extension verifies its active watch and reads the terminal result before notifying Pi. Registration checks status immediately to catch fast jobs. Detached live-watch completion does not poll; only explicitly requested progress check-ins use timers. Foreground `run`/`wait` still polls status and streams logs. Queued removals send a signal from `stop`, because Pueue does not call its callback for removed tasks. Jobs and logs remain in Pueue: inspect them or explicitly watch them again after reopening. Completed records and logs have no automatic retention policy yet. There is no promise that a running command survives a machine reboot or Pueue failure.

Commands inherit the submitting environment, which Pueue retains alongside task records and logs. That can include credentials and old executable paths. Omit sensitive variables deliberately, for example `printf 'make\n' | env -u API_TOKEN pi-jobs run --detach`; do not dump task environments into an agent conversation. Required command dependencies and Nix generations must remain available while jobs run.

There is no automatic cleanup. Use `pi-jobs status` to inspect your owned jobs, then `pi-jobs forget HANDLE` to delete an explicitly selected finished job, its logs, and its captured environment. `forget` refuses active jobs and checks the full owner/incarnation handle. Keep results you still need; cleanup is not a side effect of closing Pi or unwatching.

Submission and watch registration are separate operations. If notification setup fails, the submitted job still exists. Inspect it instead of resubmitting. `unwatch` does not recall an already accepted completion. While Pi is busy, the events extension keeps notifications pending until the final continuation boundary. If a Bash result already returned the same terminal status and the notification's retained output, that pending notification is suppressed. Running status, elapsed waits and incomplete output do not qualify. Unread notifications still wake the model; job execution and retained logs are unchanged.
