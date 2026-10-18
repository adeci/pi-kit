use std::{
    fs,
    io::Write,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Sandbox {
    _dir: tempfile::TempDir,
    config: std::path::PathBuf,
    daemon: Child,
}

impl Sandbox {
    fn new() -> Self {
        Self::with_callbacks(false)
    }

    fn with_callbacks(callbacks: bool) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("pj-")
            .tempdir_in("/tmp")
            .unwrap();
        let config = dir.path().join("config.yml");
        let d = dir.path().display();
        fs::write(&config, format!("shared:\n  pueue_directory: {d}/state\n  runtime_directory: {d}\n  unix_socket_path: {d}/sock\nclient: {{}}\ndaemon: {{}}\n")).unwrap();
        if callbacks {
            assert!(
                Command::new(env!("CARGO_BIN_EXE_pi-jobs"))
                    .args(["init", "--callbacks"])
                    .env("PI_JOBS_CONFIG", &config)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        let cli_directory = std::path::Path::new(env!("CARGO_BIN_EXE_pi-jobs"))
            .parent()
            .unwrap();
        let mut daemon = Command::new("pueued")
            .args(["-c", config.to_str().unwrap()])
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    cli_directory.display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .env("PI_EVENTS_BIN", dir.path().join("publisher"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        for _ in 0..100 {
            if Command::new("pueue")
                .args(["-c", config.to_str().unwrap(), "status"])
                .output()
                .unwrap()
                .status
                .success()
            {
                return Self {
                    _dir: dir,
                    config,
                    daemon,
                };
            }
            assert!(
                daemon.try_wait().unwrap().is_none(),
                "fixture daemon exited"
            );
            thread::sleep(Duration::from_millis(20));
        }
        panic!("fixture daemon did not start");
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_pi-jobs"));
        command
            .args(args)
            .env("PI_JOBS_CONFIG", &self.config)
            .env("PI_JOBS_SESSION", "test-owner")
            .env_remove("PI_EVENTS_SESSION")
            .env_remove("PI_EVENTS_SUBSCRIPTION")
            .env_remove("PI_JOBS_SOCKET")
            .env_remove("PI_JOBS_TOKEN");
        let publisher = self._dir.path().join("publisher");
        if publisher.exists() {
            command.env("PI_EVENTS_BIN", publisher);
        }
        command
    }

    fn publisher(&self) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let shell = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|directory| directory.join("bash"))
            .find(|path| path.is_file())
            .unwrap();
        let body = self._dir.path().join("body");
        let script = self._dir.path().join("publisher");
        fs::write(&script, format!("#!{}\nwhile IFS= read -r line || [ -n \"$line\" ]; do printf '%s' \"$line\"; done > '{}'\n", shell.display(), body.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        body
    }

    /// A publisher that appends one line per call: its arguments, then the
    /// event payload. Lets tests count watch and consumption signals.
    fn recorder(&self) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let shell = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|directory| directory.join("bash"))
            .find(|path| path.is_file())
            .unwrap();
        let log = self._dir.path().join("published");
        let script = self._dir.path().join("publisher");
        fs::write(&script, format!("#!{}\n{{ printf '%s ' \"$@\"; while IFS= read -r line || [ -n \"$line\" ]; do printf '%s' \"$line\"; done; printf '\\n'; }} >> '{}'\n", shell.display(), log.display())).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        log
    }

    /// Published payloads for one topic, in order.
    fn published(log: &std::path::Path, topic: &str) -> Vec<serde_json::Value> {
        let marker = format!("--topic {topic} ");
        fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains(&marker))
            .map(|line| serde_json::from_str(&line[line.find('{').unwrap()..]).unwrap())
            .collect()
    }

    fn live(&self, args: &[&str]) -> Command {
        let mut command = self.command(args);
        command.env("PI_EVENTS_SESSION", "test-owner");
        command
    }

    fn submit_live(&self, args: &[&str], text: &str) -> (String, std::process::Output) {
        use std::io::Write;
        let mut child = self
            .live(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        let handle = stderr
            .lines()
            .find_map(|line| line.strip_prefix("job="))
            .and_then(|value| value.split_whitespace().next())
            .unwrap_or_else(|| panic!("No handle: {stderr}"))
            .to_string();
        (handle, output)
    }

    fn cli(&self, args: &[&str]) -> std::process::Output {
        self.command(args).output().unwrap()
    }

    fn submit(&self, args: &[&str], text: &str) -> (String, std::process::Output) {
        use std::io::Write;
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        let handle = stderr
            .lines()
            .find_map(|line| {
                line.strip_prefix("job=")
                    .and_then(|value| value.split_whitespace().next())
            })
            .unwrap_or_else(|| panic!("No handle: {stderr}"))
            .to_string();
        (handle, output)
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = Command::new("pueue")
            .args(["-c", self.config.to_str().unwrap(), "shutdown"])
            .output();
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

#[test]
fn callback_installation_preserves_config_values_and_custom_hooks() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::Builder::new()
        .prefix("pj-'quoted-")
        .tempdir_in("/tmp")
        .unwrap();
    let path = dir.path().join("config.yml");
    let original = "daemon:\n  default_parallel_tasks: 3\n  future_setting: preserved\ngroups:\n  custom:\n    parallel: 7\n";
    fs::write(&path, original).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    let configure = || {
        Command::new(env!("CARGO_BIN_EXE_pi-jobs"))
            .args(["init", "--callbacks"])
            .env("PI_JOBS_CONFIG", &path)
            .output()
            .unwrap()
    };
    assert!(configure().status.success());
    let config: serde_yaml::Value = serde_yaml::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(config["daemon"]["default_parallel_tasks"].as_u64(), Some(3));
    assert_eq!(
        config["daemon"]["future_setting"].as_str(),
        Some("preserved")
    );
    assert_eq!(config["groups"]["custom"]["parallel"].as_u64(), Some(7));
    let callback = config["daemon"]["callback"].as_str().unwrap();
    assert!(callback.starts_with("pi-jobs _notify {{id}} --config "));
    assert!(callback.contains("'\\''"));
    assert!(!callback.contains("{{command}}") && !callback.contains("{{output}}"));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o640
    );
    let installed = fs::read(&path).unwrap();
    assert!(configure().status.success());
    assert_eq!(fs::read(&path).unwrap(), installed);
    let custom = "# keep this exact file\ndaemon:\n  callback: 'echo custom {{id}}'\n";
    fs::write(&path, custom).unwrap();
    let result = configure();
    assert!(result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Kept existing"));
    assert_eq!(fs::read_to_string(&path).unwrap(), custom);
}

#[test]
fn doctor_checks_the_live_hook_and_forget_refuses_active_work() {
    let stale = Sandbox::new();
    stale.publisher();
    assert!(stale.cli(&["init", "--callbacks"]).status.success());
    let result = stale.cli(&["doctor"]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("running daemon"));
    let fresh = Sandbox::with_callbacks(true);
    fresh.publisher();
    let before = fresh.cli(&["status", "--json"]).stdout;
    let health: serde_json::Value = serde_json::from_slice(&fresh.cli(&["health"]).stdout).unwrap();
    assert_eq!(health["callback_verified"], false);
    assert_eq!(fresh.cli(&["status", "--json"]).stdout, before);
    assert!(fresh.cli(&["doctor"]).status.success());
    let health: serde_json::Value = serde_json::from_slice(&fresh.cli(&["health"]).stdout).unwrap();
    assert_eq!(health["callback_verified"], true);
    let (handle, _) = fresh.submit(&["run", "--detach"], "sleep 1; echo kept");
    assert!(!fresh.cli(&["forget", &handle]).status.success());
    assert!(
        fresh
            .cli(&["wait", &handle, "--timeout", "2"])
            .status
            .success()
    );
    assert!(fresh.cli(&["forget", &handle]).status.success());
}

#[test]
fn native_callback_emits_the_protected_handle_for_a_failed_task() {
    let sandbox = Sandbox::with_callbacks(true);
    let body = sandbox.publisher();
    let (handle, submitted) =
        sandbox.submit(&["run", "--detach"], "printf 'untrusted output'; exit 7");
    assert!(submitted.status.success());
    let mut received = None;
    for _ in 0..250 {
        received = fs::read(&body)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if received.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        received.unwrap(),
        serde_json::json!({"handle": handle, "owner": "test-owner"})
    );
}

#[test]
fn queued_removal_emits_a_change_without_a_native_callback() {
    let sandbox = Sandbox::with_callbacks(true);
    let body = sandbox.publisher();
    assert!(
        Command::new("pueue")
            .args([
                "--config",
                sandbox.config.to_str().unwrap(),
                "pause",
                "--group",
                "default"
            ])
            .output()
            .unwrap()
            .status
            .success()
    );
    let (handle, submitted) = sandbox.submit(&["run", "--detach"], "echo should-not-run");
    assert!(submitted.status.success());
    assert!(sandbox.cli(&["stop", &handle]).status.success());
    let received: serde_json::Value = serde_json::from_slice(&fs::read(body).unwrap()).unwrap();
    assert_eq!(
        received,
        serde_json::json!({"handle": handle, "owner": "test-owner"})
    );
}

#[test]
fn empty_isolated_daemon_has_no_jobs() {
    let sandbox = Sandbox::new();
    let out = sandbox.cli(&["status", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap(),
        serde_json::json!([])
    );
}

#[test]
fn detached_job_survives_its_cli_and_captures_environment() {
    let sandbox = Sandbox::new();
    let (handle, output) = sandbox.submit(
        &["run", "--detach", "--name", "build"],
        "sleep 0.2; printf 'completed:%s' \"$PI_JOBS_SESSION\"",
    );
    assert!(output.status.success());
    let waited = sandbox.cli(&["wait", &handle, "--timeout", "2"]);
    assert!(
        waited.status.success(),
        "{}",
        String::from_utf8_lossy(&waited.stderr)
    );
    assert!(String::from_utf8_lossy(&waited.stdout).contains("completed:test-owner"));
}

#[test]
fn soft_wait_limit_does_not_kill_execution() {
    let sandbox = Sandbox::new();
    let (handle, output) =
        sandbox.submit(&["run", "--timeout", "0.02"], "sleep 0.3; echo finished");
    assert_eq!(
        output.status.code(),
        Some(75),
        "A detached run exits 75, never a build-failure code"
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("still running after"));
    let waited = sandbox.cli(&["wait", &handle, "--timeout", "2"]);
    assert!(waited.status.success());
    assert!(String::from_utf8_lossy(&waited.stdout).contains("finished"));
}

#[test]
fn nonzero_exit_is_preserved() {
    let sandbox = Sandbox::new();
    let (_, output) = sandbox.submit(&["run"], "echo failed-output; exit 7");
    assert_eq!(output.status.code(), Some(7));
    assert!(String::from_utf8_lossy(&output.stdout).contains("failed-output"));
}

#[test]
fn foreign_and_stale_handles_cannot_stop_a_job() {
    let sandbox = Sandbox::new();
    let (handle, _) = sandbox.submit(&["run", "--detach"], "sleep 0.3; echo survived");
    assert!(
        !sandbox
            .command(&["stop", &handle])
            .env("PI_JOBS_SESSION", "other-owner")
            .output()
            .unwrap()
            .status
            .success()
    );
    let stale = format!("{}:{}", handle.split(':').next().unwrap(), "0".repeat(32));
    assert!(!sandbox.cli(&["stop", &stale]).status.success());
    assert!(
        !sandbox
            .cli(&["stop", handle.split(':').next().unwrap()])
            .status
            .success()
    );
    let waited = sandbox.cli(&["wait", &handle, "--timeout", "2"]);
    assert!(String::from_utf8_lossy(&waited.stdout).contains("survived"));
}

#[test]
fn cancelled_wait_does_not_cancel_the_job() {
    let sandbox = Sandbox::new();
    let (handle, _) = sandbox.submit(
        &["run", "--detach"],
        "sleep 0.4; echo finished-after-waiter",
    );
    let mut waiter = sandbox
        .command(&["wait", &handle])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(50));
    waiter.kill().unwrap();
    waiter.wait().unwrap();
    let waited = sandbox.cli(&["wait", &handle, "--timeout", "2"]);
    assert!(waited.status.success());
    assert!(String::from_utf8_lossy(&waited.stdout).contains("finished-after-waiter"));
}

#[test]
fn explicit_stop_kills_descendants_but_not_another_job() {
    let sandbox = Sandbox::new();
    let sentinel = sandbox._dir.path().join("orphan-sentinel");
    let command = format!(
        "sh -c 'sleep 0.7; echo orphan > {}' & wait",
        sentinel.display()
    );
    let (first, _) = sandbox.submit(&["run", "--detach"], &command);
    let (second, _) = sandbox.submit(&["run", "--detach"], "echo other-job");
    for _ in 0..100 {
        let status: serde_json::Value =
            serde_json::from_slice(&sandbox.cli(&["status", "--json", &first]).stdout).unwrap();
        if status[0]["state"] == "running" {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let before = sandbox.cli(&["status", "--json", &first]);
    let stop = sandbox.cli(&["stop", &first]);
    assert!(
        stop.status.success(),
        "before={} stop failed: {} {}",
        String::from_utf8_lossy(&before.stdout),
        String::from_utf8_lossy(&stop.stdout),
        String::from_utf8_lossy(&stop.stderr)
    );
    let stopped = sandbox.cli(&["wait", &first, "--timeout", "2"]);
    assert_eq!(stopped.status.code(), Some(137));
    let other = sandbox.cli(&["wait", &second, "--timeout", "2"]);
    assert!(other.status.success());
    assert!(String::from_utf8_lossy(&other.stdout).contains("other-job"));
    thread::sleep(Duration::from_millis(750));
    assert!(!sentinel.exists(), "Task descendant survived explicit stop");
}

#[test]
fn no_owner_does_not_expose_or_control_all_jobs() {
    let sandbox = Sandbox::new();
    let output = sandbox
        .command(&["status", "--json"])
        .env_remove("PI_JOBS_SESSION")
        .env_remove("PI_SESSION_ID")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("No job owner"));
}

#[test]
fn missing_daemon_is_not_started() {
    let dir = tempfile::Builder::new()
        .prefix("pj-")
        .tempdir_in("/tmp")
        .unwrap();
    let config = dir.path().join("config.yml");
    let d = dir.path().display();
    fs::write(&config, format!("shared:\n  pueue_directory: {d}/state\n  runtime_directory: {d}\n  unix_socket_path: {d}/sock\nclient: {{}}\ndaemon: {{}}\n")).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_pi-jobs"))
        .args(["status", "--json"])
        .env("PI_JOBS_CONFIG", config)
        .env("PI_JOBS_SESSION", "owner")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("never starts it automatically"));
    assert!(!dir.path().join("sock").exists());
    assert!(!dir.path().join("state").exists());
}

#[test]
fn stopping_an_unstarted_task_removes_it_without_controlling_a_replacement() {
    let sandbox = Sandbox::new();
    let pueue = |args: &[&str]| {
        Command::new("pueue")
            .arg("--config")
            .arg(&sandbox.config)
            .args(args)
            .output()
            .unwrap()
    };
    assert!(pueue(&["pause", "--group", "default"]).status.success());
    let (old, _) = sandbox.submit(&["run", "--detach"], "echo should-not-run");
    let status: serde_json::Value =
        serde_json::from_slice(&sandbox.cli(&["status", "--json", &old]).stdout).unwrap();
    assert_eq!(status[0]["state"], "queued");
    assert!(sandbox.cli(&["stop", &old]).status.success());
    let status: serde_json::Value =
        serde_json::from_slice(&sandbox.cli(&["status", "--json", &old]).stdout).unwrap();
    assert_eq!(status[0]["state"], "unavailable");
    let (new, _) = sandbox.submit(&["run", "--detach"], "echo replacement-survived");
    assert!(!sandbox.cli(&["stop", &old]).status.success());
    assert!(pueue(&["start", "--group", "default"]).status.success());
    let waited = sandbox.cli(&["wait", &new, "--timeout", "2"]);
    assert!(waited.status.success());
    assert!(String::from_utf8_lossy(&waited.stdout).contains("replacement-survived"));
}

#[test]
fn list_and_logs_are_scoped_to_the_owner() {
    let sandbox = Sandbox::new();
    let (handle, _) = sandbox.submit(&["run", "--detach"], "echo private-output");
    let list = sandbox
        .command(&["status", "--json"])
        .env("PI_JOBS_SESSION", "other-owner")
        .output()
        .unwrap();
    assert!(list.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&list.stdout).unwrap(),
        serde_json::json!([])
    );
    assert!(
        !sandbox
            .command(&["log", &handle])
            .env("PI_JOBS_SESSION", "other-owner")
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn unresponsive_daemon_has_a_bounded_error() {
    use std::os::unix::net::UnixListener;
    use std::time::Instant;
    let mut sandbox = Sandbox::new();
    sandbox.daemon.kill().unwrap();
    sandbox.daemon.wait().unwrap();
    let socket = sandbox._dir.path().join("sock");
    let _ = fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).unwrap();
    let server = thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_secs(4));
    });
    let start = Instant::now();
    let output = sandbox.cli(&["status", "--json"]);
    assert!(!output.status.success());
    assert!(
        start.elapsed() < Duration::from_secs(4),
        "Daemon handshake waited indefinitely"
    );
    server.join().unwrap();
}

fn live_sandbox() -> (Sandbox, std::path::PathBuf) {
    let sandbox = Sandbox::with_callbacks(true);
    let log = sandbox.recorder();
    let doctor = sandbox.cli(&["doctor"]);
    assert!(
        doctor.status.success(),
        "{}",
        String::from_utf8_lossy(&doctor.stderr)
    );
    (sandbox, log)
}

#[test]
fn foreground_run_is_armed_from_submission_and_consumes_its_own_result() {
    let (sandbox, log) = live_sandbox();
    // Finishes in time: real exit code, output streamed. The watch armed at
    // submission is consumed by this in-band read, so no notice remains.
    let (quick, output) = sandbox.submit_live(&["run", "--name", "quick"], "echo streamed; exit 3");
    assert_eq!(output.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&output.stdout).contains("streamed"));
    let watches = Sandbox::published(&log, "job.watch");
    assert_eq!(watches.len(), 1);
    assert_eq!(watches[0]["handle"], quick.as_str());
    assert_eq!(
        Sandbox::published(&log, "job.consumed"),
        vec![serde_json::json!({"handles": [quick]})]
    );
    // Outlives its deadline: exit 75, a clear message, still exactly one watch
    // for it and no receipt, so the watch delivers the result later.
    let (slow, output) = sandbox.submit_live(&["run", "--timeout", "0.3"], "sleep 1.5; echo late");
    assert_eq!(output.status.code(), Some(75));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("still running"), "{stdout}");
    assert!(stdout.contains(&format!("pi-jobs wait {slow}")), "{stdout}");
    assert!(stdout.contains("notice will arrive"), "{stdout}");
    let watches = Sandbox::published(&log, "job.watch");
    assert_eq!(watches.len(), 2);
    assert_eq!(watches[1]["handle"], slow.as_str());
    assert_eq!(Sandbox::published(&log, "job.consumed").len(), 1);
    // A wait timeout re-detaches with 75 and never arms a second watch.
    let waited = sandbox
        .live(&["wait", &slow, "--timeout", "0.2"])
        .output()
        .unwrap();
    assert_eq!(waited.status.code(), Some(75));
    assert_eq!(Sandbox::published(&log, "job.watch").len(), 2);
    assert_eq!(Sandbox::published(&log, "job.consumed").len(), 1);
    // A wait that finishes in-band is a read: one receipt for that handle.
    let waited = sandbox
        .live(&["wait", &slow, "--timeout", "5"])
        .output()
        .unwrap();
    assert_eq!(waited.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&waited.stdout).contains("late"));
    assert_eq!(
        Sandbox::published(&log, "job.consumed")[1],
        serde_json::json!({"handles": [slow]})
    );
}

#[test]
fn killed_foreground_run_keeps_its_watch() {
    // Escape or a bash timeout SIGKILLs the CLI mid-follow. The job keeps
    // running and its watch, armed at submission, must still deliver it.
    let (sandbox, log) = live_sandbox();
    let mut child = sandbox
        .live(&["run", "--name", "killed"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"sleep 1; echo survived")
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Sandbox::published(&log, "job.watch").is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    child.kill().unwrap();
    let _ = child.wait();
    assert_eq!(Sandbox::published(&log, "job.watch").len(), 1);
    assert!(Sandbox::published(&log, "job.consumed").is_empty());
}

#[test]
fn detach_arms_immediately_and_reads_of_finished_jobs_are_receipts() {
    let (sandbox, log) = live_sandbox();
    let (handle, output) = sandbox.submit_live(&["run", "--detach"], "sleep 0.6; echo done");
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        Sandbox::published(&log, "job.watch"),
        vec![serde_json::json!({"handle": handle, "interval": null})]
    );
    // Running: status and log are not receipts.
    assert!(
        sandbox
            .live(&["status", &handle])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(
        sandbox
            .live(&["log", &handle])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(Sandbox::published(&log, "job.consumed").is_empty());
    // Outside a live Pi attachment nothing is published.
    assert_eq!(
        sandbox
            .cli(&["wait", &handle, "--timeout", "5"])
            .status
            .code(),
        Some(0)
    );
    assert!(Sandbox::published(&log, "job.consumed").is_empty());
    let receipt = serde_json::json!({"handles": [handle]});
    for (index, command) in [
        vec!["status", handle.as_str()],
        vec!["status", "--json"],
        vec!["log", handle.as_str(), "--lines", "1"],
        vec!["wait", handle.as_str()],
    ]
    .iter()
    .enumerate()
    {
        let output = sandbox.live(command).output().unwrap();
        assert_eq!(output.status.code(), Some(0), "{command:?}");
        let receipts = Sandbox::published(&log, "job.consumed");
        assert_eq!(receipts.len(), index + 1, "{command:?}");
        assert_eq!(receipts[index], receipt, "{command:?}");
    }
    // log keeps its terminal line for the reader.
    let output = sandbox.live(&["log", &handle]).output().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&output.stderr).lines().last(),
        Some(format!("job={handle} success exit=0").as_str())
    );
    assert_eq!(Sandbox::published(&log, "job.watch").len(), 1);
}
