use std::{
    collections::HashMap,
    env, error, fs,
    io::{self, Read, Seek, SeekFrom, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    process, thread,
    time::{Duration, Instant},
};

use lexopt::{
    Arg::{Long, Short, Value},
    Parser, ValueExt,
};
use pueue_lib::{
    message::{AddRequest, KillRequest, Request, Response, TaskSelection},
    network_blocking::{
        protocol::{receive_bytes, receive_response, send_bytes, send_request},
        socket::GenericBlockingStream,
    },
    settings::Settings,
    state::State,
    task::{Task, TaskResult, TaskStatus},
};
use serde::{Deserialize, Serialize};

type Error = Box<dyn error::Error>;
const USAGE: &str = "pi-jobs <command> [options]
  init [--shell PATH] [--callbacks]
                              create config; optionally install completion callback
  doctor                      test the running callback; no daemon restart
  health                      inspect callback verification without submitting work
  config-path                 print selected config path
  run [--detach] [--timeout SECONDS] [-C DIR] [--name NAME] [--check-in SECONDS]
                              read command from stdin; no execution deadline
  status [HANDLE...] [--json] [--tail LINES]
  log HANDLE [--lines LINES]   full output by default
  wait HANDLE [--timeout SECONDS]
  stop HANDLE                 explicitly stop the task; wait cancellation never does
  forget HANDLE               delete a finished owned task and its retained data
  watch HANDLE [--check-in SECONDS]
  unwatch HANDLE              leave execution alive

Check-in intervals are 10-604800 seconds; progress does not wake the model.
Inside Pi, the jobs extension supplies session identity and watch attachment.
Outside Pi, set PI_JOBS_SESSION explicitly. PI_JOBS_CONFIG selects the isolated
Pueue config. Detached/pending operations exit 0, not a build-failure code.";

#[derive(Clone, Deserialize, Serialize)]
struct Label {
    owner: String,
    nonce: String,
    name: String,
}

#[derive(Clone, Serialize)]
struct Snapshot {
    handle: String,
    owner: String,
    name: String,
    state: String,
    exit_code: Option<i32>,
    elapsed_seconds: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    tail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn main() {
    match execute() {
        Ok(code) => process::exit(code.clamp(0, 255)),
        Err(error) => {
            eprintln!("pi-jobs: {error}");
            process::exit(1);
        }
    }
}

fn config_path() -> Result<PathBuf, Error> {
    if let Some(path) = env::var_os("PI_JOBS_CONFIG") {
        return Ok(PathBuf::from(path));
    }
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".config"));
    Ok(base.join("pi-jobs/pueue.yml"))
}

fn home() -> Result<PathBuf, Error> {
    Ok(PathBuf::from(env::var_os("HOME").ok_or("HOME is not set")?))
}

fn owner() -> Result<String, Error> {
    let value = env::var("PI_JOBS_SESSION")
        .or_else(|_| env::var("PI_SESSION_ID"))
        .map_err(
            |_| "No job owner: load the Pi jobs extension or set PI_JOBS_SESSION explicitly",
        )?;
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err("Invalid session identity".into());
    }
    Ok(value)
}

fn nonce() -> Result<String, Error> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn handle_parts(handle: &str) -> Result<(usize, &str), Error> {
    let (id, token) = handle
        .split_once(':')
        .ok_or("Expected job handle ID:INCARNATION, not a numeric Pueue ID")?;
    if token.len() != 32
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid job incarnation".into());
    }
    Ok((id.parse()?, token))
}

fn label(task: &Task) -> Option<Label> {
    serde_json::from_str(task.label.as_deref()?.strip_prefix("pi-jobs:")?).ok()
}

struct Daemon {
    stream: GenericBlockingStream,
    logs: PathBuf,
    settings: Settings,
}
impl Daemon {
    fn connect() -> Result<Self, Error> {
        Self::connect_at(config_path()?)
    }
    fn connect_at(path: PathBuf) -> Result<Self, Error> {
        if !path.is_file() {
            return Err(format!("No isolated config at {}. Run `pi-jobs init` and explicitly start the configured Pueue service.", path.display()).into());
        }
        let (settings, _) = Settings::read(&Some(path))?;
        if !settings.shared.use_unix_socket {
            return Err("pi-jobs supports a local Unix-socket daemon only".into());
        }
        let socket = settings.shared.unix_socket_path()?;
        let stream = UnixStream::connect(&socket).map_err(|error| format!("Pueue unavailable at {}: {error}. Start pi-jobs-pueue.service or your configured daemon; pi-jobs never starts it automatically.", socket.display()))?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        let mut stream: GenericBlockingStream = Box::new(stream);
        let secret = fs::read(settings.shared.shared_secret_path())?;
        send_bytes(&secret, &mut stream)?;
        let version = receive_bytes(&mut stream)?;
        if version.is_empty() {
            return Err("Pueue rejected authentication".into());
        }
        Ok(Self {
            stream,
            logs: settings.shared.pueue_directory().join("task_logs"),
            settings,
        })
    }
    fn request(&mut self, request: Request) -> Result<Response, Error> {
        send_request(request, &mut self.stream)?;
        Ok(receive_response(&mut self.stream)?)
    }
    fn state(&mut self) -> Result<State, Error> {
        match self.request(Request::Status)? {
            Response::Status(state) => Ok(*state),
            other => Err(format!("Unexpected daemon response: {other:?}").into()),
        }
    }
    fn checked<'a>(&self, state: &'a State, handle: &str, owner: &str) -> Result<&'a Task, Error> {
        let (id, token) = handle_parts(handle)?;
        let task = state.tasks.get(&id).ok_or("Unknown or stale job handle")?;
        let metadata = label(task).ok_or("Unknown or stale job handle")?;
        if metadata.owner != owner || metadata.nonce != token {
            return Err("Unknown, stale, or foreign-session job handle".into());
        }
        Ok(task)
    }
    fn log_path(&self, id: usize) -> PathBuf {
        self.logs.join(format!("{id}.log"))
    }
    // Serialize pi-jobs submissions and controls across processes. Pueue's
    // native protocol has no compare-and-kill; external edits remain outside
    // this guard. Never hold this lock while waiting or streaming stdout.
    fn control_lock(&self) -> Result<fs::File, Error> {
        let path = self
            .logs
            .parent()
            .ok_or("Invalid daemon state path")?
            .join(".pi-jobs-control.lock");
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(error) => {
                    return Err(format!("Could not acquire daemon control lock: {error}").into());
                }
            }
        }
    }
}

fn snapshot(
    task: &Task,
    metadata: Label,
    daemon: &Daemon,
    lines: Option<usize>,
) -> Result<Snapshot, Error> {
    let (state, exit, start, end) = match &task.status {
        TaskStatus::Queued { .. } => ("queued", None, None, None),
        TaskStatus::Stashed { .. } => ("stashed", None, None, None),
        TaskStatus::Locked { .. } => ("locked", None, None, None),
        TaskStatus::Running { start, .. } => ("running", None, Some(*start), None),
        TaskStatus::Paused { start, .. } => ("paused", None, Some(*start), None),
        TaskStatus::Done {
            start, end, result, ..
        } => {
            let (name, code) = match result {
                TaskResult::Success => ("success", 0),
                TaskResult::Failed(code) => ("failed", *code),
                TaskResult::Killed => ("killed", 137),
                TaskResult::FailedToSpawn(_) => ("failed-to-spawn", 127),
                TaskResult::Errored => ("errored", 1),
                TaskResult::DependencyFailed => ("dependency-failed", 1),
            };
            (name, Some(code), Some(*start), Some(*end))
        }
    };
    let elapsed = start
        .map(|start| (end.unwrap_or_else(chrono::Local::now) - start).num_seconds())
        .unwrap_or(0);
    let tail = lines
        .map(|count| tail(&daemon.log_path(task.id), count))
        .transpose()?;
    Ok(Snapshot {
        handle: format!("{}:{}", task.id, metadata.nonce),
        owner: metadata.owner,
        name: metadata.name,
        state: state.into(),
        exit_code: exit,
        elapsed_seconds: elapsed,
        tail,
        error: None,
    })
}

fn tail(path: &Path, lines: usize) -> Result<String, Error> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.into()),
    };
    let length = file.metadata()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(8192)))?;
    let mut bytes = Vec::new();
    file.take(8192).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<_> = text.lines().collect();
    Ok(all[all.len().saturating_sub(lines)..].join("\n"))
}

fn print_snapshot(job: &Snapshot) {
    println!(
        "job={} {}{}{} elapsed={}s",
        job.handle,
        job.state,
        job.exit_code
            .map(|code| format!(" exit={code}"))
            .unwrap_or_default(),
        if job.name.is_empty() {
            String::new()
        } else {
            format!(" ({})", job.name)
        },
        job.elapsed_seconds
    );
    if let Some(error) = &job.error {
        println!("{error}");
    }
    if let Some(tail) = &job.tail
        && !tail.is_empty()
    {
        println!("{tail}");
    }
}

fn execute() -> Result<i32, Error> {
    let mut parser = Parser::from_env();
    let command = match parser.next()? {
        Some(Value(value)) => value.string()?,
        Some(Long("help") | Short('h')) | None => {
            println!("{USAGE}");
            return Ok(0);
        }
        Some(Long("version")) => {
            println!("pi-jobs {}", env!("CARGO_PKG_VERSION"));
            return Ok(0);
        }
        Some(arg) => return Err(arg.unexpected().into()),
    };
    match command.as_str() {
        "init" => init(&mut parser),
        "_notify" => notify(&mut parser),
        "doctor" => doctor(&mut parser),
        "health" => {
            if parser.next()?.is_some() {
                return Err("health takes no arguments".into());
            }
            let result = callback_readiness();
            println!(
                "{}",
                serde_json::json!({"callback_verified": result.is_ok(), "error": result.err().map(|error| error.to_string())})
            );
            Ok(0)
        }
        "config-path" => {
            if parser.next()?.is_some() {
                return Err("config-path takes no arguments".into());
            }
            println!("{}", config_path()?.display());
            Ok(0)
        }
        "run" => run(&mut parser),
        "status" => status(&mut parser),
        "log" => logs(&mut parser),
        "wait" => wait(&mut parser),
        "stop" => stop(&mut parser),
        "forget" => forget(&mut parser),
        "watch" | "unwatch" => watch(&mut parser, &command),
        "help" => {
            println!("{USAGE}");
            Ok(0)
        }
        _ => Err(format!("Unknown command {command}\n{USAGE}").into()),
    }
}

#[derive(Deserialize, Serialize)]
struct CallbackReady {
    socket: String,
    publisher: Option<PathBuf>,
}

fn socket_identity(settings: &Settings) -> Result<String, Error> {
    let path = settings.shared.unix_socket_path()?;
    let info = fs::metadata(&path)?;
    Ok(format!(
        "{}:{}:{}:{}",
        path.display(),
        info.ino(),
        info.mtime(),
        info.mtime_nsec()
    ))
}

fn readiness_path(settings: &Settings) -> PathBuf {
    settings
        .shared
        .pueue_directory()
        .join("callback-ready.json")
}

fn events_binary() -> Result<PathBuf, Error> {
    let name = PathBuf::from(env::var_os("PI_EVENTS_BIN").unwrap_or_else(|| "pi-events".into()));
    let candidates = if name.components().count() > 1 {
        vec![name]
    } else {
        env::split_paths(&env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join(&name))
            .collect()
    };
    candidates.into_iter().find(|path| fs::metadata(path).is_ok_and(|info| info.is_file() && info.mode() & 0o111 != 0))
        .ok_or("pi-events is missing or not executable in this deployment. Fix PATH/PI_EVENTS_BIN; the job and logs remain in Pueue.".into())
}

fn doctor(parser: &mut Parser) -> Result<i32, Error> {
    if parser.next()?.is_some() {
        return Err("doctor takes no arguments".into());
    }
    let mut daemon = Daemon::connect()?;
    let identity = socket_identity(&daemon.settings)?;
    let _ = fs::remove_file(readiness_path(&daemon.settings));
    if let Some(shell) = daemon
        .settings
        .daemon
        .shell_command
        .as_ref()
        .and_then(|command| command.first())
        .filter(|shell| shell.starts_with("/nix/store/"))
    {
        eprintln!(
            "Configured shell uses a store path ({shell}). Keep that generation while jobs run; after draining, consider using bash from the daemon PATH before the next startup."
        );
    }
    let token = nonce()?;
    let tag = format!("pi-jobs-probe:{token}");
    let challenge = daemon
        .settings
        .shared
        .pueue_directory()
        .join(format!(".callback-probe-{token}"));
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&challenge)?
        .write_all(b"pending")?;
    // Explicit diagnostic: a no-op with an empty environment, not user work.
    let result = (|| -> Result<CallbackReady, Error> {
        let request = AddRequest {
            command: ":".into(),
            path: env::current_dir()?,
            envs: HashMap::new(),
            start_immediately: true,
            stashed: false,
            group: "default".into(),
            enqueue_at: None,
            dependencies: Vec::new(),
            priority: None,
            label: Some(tag.clone()),
        };
        let id = match daemon.request(Request::Add(request))? {
            Response::AddedTask(task) => task.task_id,
            other => return Err(format!("Cannot submit callback probe: {other:?}").into()),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut ready = None;
        while Instant::now() < deadline {
            ready = fs::read(&challenge)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<CallbackReady>(&bytes).ok());
            if ready.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let state = daemon.state()?;
        let task = state
            .tasks
            .get(&id)
            .filter(|task| task.label.as_deref() == Some(&tag));
        let successful = task.is_some_and(|task| {
            matches!(
                task.status,
                TaskStatus::Done {
                    result: TaskResult::Success,
                    ..
                }
            )
        });
        if let Some(task) = task {
            if task.is_done() {
                let _ = daemon.request(Request::Remove(vec![id]));
            } else {
                let _ = daemon.request(Request::Kill(KillRequest {
                    tasks: TaskSelection::TaskIds(vec![id]),
                    signal: None,
                }));
            }
        }
        let ready = ready.ok_or("The running daemon did not execute the callback probe. Editing config does not activate a hook. Configure it before the next planned startup; do not restart active jobs.")?;
        if !successful {
            return Err("Callback ran, but the shell probe failed. Check daemon.shell_command and keep required Nix generations until jobs are drained.".into());
        }
        if ready.socket != identity || socket_identity(&daemon.settings)? != identity {
            return Err("Daemon changed during callback check; run doctor again".into());
        }
        Ok(ready)
    })();
    let _ = fs::remove_file(challenge);
    let ready = result?;
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(readiness_path(&daemon.settings))?
        .write_all(serde_json::to_string(&ready)?.as_bytes())?;
    println!("Running callback verified. This check expires when the daemon socket changes.");
    if let Some(path) = ready.publisher {
        println!("Daemon publisher: {}", path.display());
    } else {
        println!(
            "Daemon publisher missing: install pi-events or fix PATH/PI_EVENTS_BIN, then run doctor again. Standalone job execution still works."
        );
    }
    Ok(0)
}

fn forget(parser: &mut Parser) -> Result<i32, Error> {
    let handle = parser.value()?.string()?;
    if parser.next()?.is_some() {
        return Err("forget takes one handle".into());
    }
    let mut daemon = Daemon::connect()?;
    let _control = daemon.control_lock()?;
    let state = daemon.state()?;
    let task = daemon.checked(&state, &handle, &owner()?)?;
    if !task.is_done() {
        return Err("Refusing to forget an active job; stop is a separate explicit action".into());
    }
    match daemon.request(Request::Remove(vec![task.id]))? {
        Response::Success(_) => {
            println!("job={handle} forgotten; its logs and captured environment are deleted");
            Ok(0)
        }
        Response::Failure(error) => Err(error.into()),
        other => Err(format!("Unexpected removal response: {other:?}").into()),
    }
}

fn callback_command(path: &Path) -> Result<String, Error> {
    let path = fs::canonicalize(path)?;
    let path = path.to_str().ok_or("Callback config path must be UTF-8")?;
    if path.contains("{{") {
        return Err("Callback config path cannot contain template expressions".into());
    }
    let quoted = format!("'{}'", path.replace('\'', "'\\''"));
    Ok(format!("pi-jobs _notify {{{{id}}}} --config {quoted}"))
}

fn install_callback(path: &Path) -> Result<(), Error> {
    let path = fs::canonicalize(path)?;
    let command = callback_command(&path)?;
    let mut config: serde_yaml::Value = serde_yaml::from_slice(&fs::read(&path)?)?;
    let daemon = config
        .as_mapping_mut()
        .ok_or("Invalid Pueue config")?
        .entry(serde_yaml::Value::from("daemon"))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()))
        .as_mapping_mut()
        .ok_or("Invalid Pueue daemon config")?;
    let key = serde_yaml::Value::from("callback");
    if let Some(existing) = daemon.get(&key).filter(|value| !value.is_null()) {
        if existing.as_str() != Some(&command) {
            eprintln!(
                "Kept existing Pueue callback unchanged. Run `pi-jobs doctor` after startup to check whether it invokes the notification helper."
            );
        }
        return Ok(());
    }
    daemon.insert(key, serde_yaml::Value::from(command));
    let temporary = path.with_file_name(format!(".pi-jobs-{}.yml", nonce()?));
    let result = (|| -> Result<(), Error> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.set_permissions(fs::metadata(&path)?.permissions())?;
        file.write_all(serde_yaml::to_string(&config)?.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

// Pueue passes only its numeric ID. Resolve the current protected handle,
// then let the live observer verify its own watch and read the result.
fn notify(parser: &mut Parser) -> Result<i32, Error> {
    let id: usize = parser.value()?.parse()?;
    let mut path = config_path()?;
    while let Some(arg) = parser.next()? {
        match arg {
            Long("config") => path = PathBuf::from(parser.value()?),
            _ => return Err(arg.unexpected().into()),
        }
    }
    let mut daemon = Daemon::connect_at(path)?;
    let state = daemon.state()?;
    let Some(task) = state.tasks.get(&id).filter(|task| task.is_done()) else {
        return Ok(0);
    };
    if let Some(probe) = task
        .label
        .as_deref()
        .and_then(|label| label.strip_prefix("pi-jobs-probe:"))
    {
        if probe.len() != 32 || !probe.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid callback probe".into());
        }
        let challenge = daemon
            .settings
            .shared
            .pueue_directory()
            .join(format!(".callback-probe-{probe}"));
        if fs::read(&challenge).is_ok_and(|bytes| bytes == b"pending") {
            let ready = CallbackReady {
                socket: socket_identity(&daemon.settings)?,
                publisher: events_binary().ok(),
            };
            fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(challenge)?
                .write_all(serde_json::to_string(&ready)?.as_bytes())?;
        }
    } else if let Some(metadata) = label(task) {
        publish_change(&format!("{id}:{}", metadata.nonce), &metadata.owner)?;
    }
    Ok(0)
}

fn publish_change(handle: &str, owner: &str) -> Result<(), Error> {
    // Use this deployment's publisher, not a path captured in an old task.
    let mut command = process::Command::new(events_binary()?);
    command
        .args([
            "publish",
            "--topic",
            "job.changed",
            "--source",
            "pi-jobs",
            "--to",
            owner,
        ])
        // This daemon-originated signal resolves current live observers. Their
        // in-memory protected-handle watches decide whether to notify a model.
        .env_remove("PI_EVENTS_SESSION")
        .env_remove("PI_EVENTS_SUBSCRIPTION")
        .stdin(process::Stdio::piped())
        .stdout(process::Stdio::null());
    let mut child = command.spawn().map_err(|error| format!("Cannot start pi-events: {error}. Check the daemon's PATH/PI_EVENTS_BIN; the job result is still in Pueue."))?;
    let request = serde_json::json!({"handle": handle, "owner": owner});
    child
        .stdin
        .take()
        .ok_or("Could not open event input")?
        .write_all(serde_json::to_string(&request)?.as_bytes())?;
    let status = child.wait()?;
    if !status.success() && status.code() != Some(3) {
        return Err("Completion signal publication failed".into());
    }
    Ok(())
}

fn init(parser: &mut Parser) -> Result<i32, Error> {
    let mut shell = "bash".to_string();
    let mut callbacks = false;
    while let Some(arg) = parser.next()? {
        match arg {
            Long("shell") => shell = parser.value()?.string()?,
            Long("callbacks") => callbacks = true,
            _ => return Err(arg.unexpected().into()),
        }
    }
    let path = config_path()?;
    if path.exists() {
        if callbacks {
            install_callback(&path)?;
        }
        println!("Using existing config {}", path.display());
        return Ok(0);
    }
    let state = env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".local/state"))
        .join("pi-jobs/pueue");
    let runtime = env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).ok_or("XDG_RUNTIME_DIR is required for init (set PI_JOBS_CONFIG to use an explicit custom config)")?.join("pi-jobs/pueue");
    for dir in [
        path.parent().ok_or("Invalid config path")?,
        state.as_path(),
        runtime.as_path(),
    ] {
        fs::create_dir_all(dir)?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    let quote = |value: &Path| serde_json::to_string(&value.to_string_lossy());
    let config = format!(
        "shared:\n  pueue_directory: {}\n  runtime_directory: {}\n  unix_socket_path: {}\nclient: {{}}\ndaemon:\n  shell_command: {}\n",
        quote(&state)?,
        quote(&runtime)?,
        quote(&runtime.join("socket"))?,
        serde_json::to_string(&[shell.as_str(), "-c", "{{ pueue_command_string }}"])?
    );
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    file.write_all(config.as_bytes())?;
    if callbacks {
        install_callback(&path)?;
    }
    println!(
        "Created {}. Start its Pueue daemon explicitly; no server was started.",
        path.display()
    );
    Ok(0)
}

fn run(parser: &mut Parser) -> Result<i32, Error> {
    let mut detach = false;
    let mut timeout = 100.0;
    let mut dir = env::current_dir()?;
    let mut name = String::new();
    let mut interval = None;
    while let Some(arg) = parser.next()? {
        match arg {
            Long("detach") => detach = true,
            Long("timeout") => timeout = parser.value()?.parse()?,
            Short('C') => dir = fs::canonicalize(parser.value()?)?,
            Long("name") => name = parser.value()?.string()?,
            Long("check-in") => interval = Some(parser.value()?.parse()?),
            _ => return Err(arg.unexpected().into()),
        }
    }
    validate_timeout(timeout)?;
    validate_interval(interval)?;
    if name.len() > 120 || name.chars().any(char::is_control) {
        return Err("Name must be at most 120 bytes without control characters".into());
    }
    let owner = owner()?;
    let mut command = String::new();
    io::stdin()
        .take(1024 * 1024 + 1)
        .read_to_string(&mut command)?;
    if command.len() > 1024 * 1024 || command.trim().is_empty() {
        return Err("Command must be nonempty and at most 1 MiB".into());
    }
    let mut daemon = Daemon::connect()?;
    let nonce = nonce()?;
    let metadata = Label {
        owner: owner.clone(),
        nonce: nonce.clone(),
        name,
    };
    let mut envs: HashMap<String, String> = env::vars().collect();
    // Attachments are ephemeral capabilities, not an environment for queued work.
    envs.remove("PI_JOBS_TOKEN");
    envs.remove("PI_JOBS_SOCKET");
    let control = daemon.control_lock()?;
    let response = daemon.request(Request::Add(AddRequest {
        command,
        path: dir,
        envs,
        start_immediately: false,
        stashed: false,
        group: "default".into(),
        enqueue_at: None,
        dependencies: Vec::new(),
        priority: None,
        label: Some(format!("pi-jobs:{}", serde_json::to_string(&metadata)?)),
    }))?;
    drop(control);
    let id = match response {
        Response::AddedTask(task) => task.task_id,
        Response::Failure(error) => return Err(error.into()),
        other => return Err(format!("Unexpected submit response: {other:?}").into()),
    };
    let handle = format!("{id}:{nonce}");
    // The handle is printed before waiting, including if a later client operation fails.
    eprintln!("job={handle}");
    if detach {
        attach_watch(&handle, interval);
        println!("job={handle} submitted; execution continues independently of Pi");
        return Ok(0);
    }
    let result = follow(&mut daemon, &handle, &owner, timeout)?;
    if result.is_none() {
        attach_watch(&handle, interval);
    }
    Ok(result.unwrap_or(0))
}

fn validate_timeout(seconds: f64) -> Result<(), Error> {
    if !seconds.is_finite() || !(0.0..=604800.0).contains(&seconds) {
        return Err("Wait timeout must be 0-604800 seconds; it never kills execution".into());
    }
    Ok(())
}
fn validate_interval(interval: Option<u64>) -> Result<(), Error> {
    if interval.is_some_and(|seconds| !(10..=604800).contains(&seconds)) {
        return Err("Check-in interval must be 10-604800 seconds".into());
    }
    Ok(())
}

fn status(parser: &mut Parser) -> Result<i32, Error> {
    let mut json = false;
    let mut lines = None;
    let mut handles = Vec::new();
    while let Some(arg) = parser.next()? {
        match arg {
            Long("json") => json = true,
            Long("tail") => lines = Some(parser.value()?.parse::<usize>()?.min(2000)),
            Value(handle) => {
                let handle = handle.string()?;
                handle_parts(&handle)?;
                handles.push(handle);
            }
            _ => return Err(arg.unexpected().into()),
        }
    }
    let owner = owner()?;
    let mut daemon = Daemon::connect()?;
    let control = daemon.control_lock()?;
    let state = daemon.state()?;
    let mut jobs = Vec::new();
    if handles.is_empty() {
        for task in state.tasks.values() {
            if let Some(metadata) = label(task).filter(|label| label.owner == owner) {
                jobs.push(snapshot(task, metadata, &daemon, lines)?);
            }
        }
    } else {
        for handle in handles {
            match daemon.checked(&state, &handle, &owner) {
                Ok(task) => jobs.push(snapshot(
                    task,
                    label(task).ok_or("Invalid label")?,
                    &daemon,
                    lines,
                )?),
                Err(error) => jobs.push(Snapshot {
                    handle,
                    owner: owner.clone(),
                    name: String::new(),
                    state: "unavailable".into(),
                    exit_code: None,
                    elapsed_seconds: 0,
                    tail: None,
                    error: Some(error.to_string()),
                }),
            }
        }
    }
    drop(control);
    if json {
        println!("{}", serde_json::to_string(&jobs)?);
    } else {
        for job in &jobs {
            print_snapshot(job);
        }
    }
    Ok(0)
}

fn logs(parser: &mut Parser) -> Result<i32, Error> {
    let mut handle = None;
    let mut lines = None;
    while let Some(arg) = parser.next()? {
        match arg {
            Value(value) if handle.is_none() => handle = Some(value.string()?),
            Long("lines") => lines = Some(parser.value()?.parse::<usize>()?.min(2000)),
            _ => return Err(arg.unexpected().into()),
        }
    }
    let handle = handle.ok_or("log requires a job handle")?;
    let mut daemon = Daemon::connect()?;
    let control = daemon.control_lock()?;
    let state = daemon.state()?;
    let task = daemon.checked(&state, &handle, &owner()?)?;
    let path = daemon.log_path(task.id);
    if let Some(lines) = lines {
        let text = tail(&path, lines)?;
        drop(control);
        println!("{text}");
    } else {
        let file = match fs::File::open(path) {
            Ok(file) => Some(file),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        drop(control);
        if let Some(mut file) = file {
            io::copy(&mut file, &mut io::stdout().lock())?;
        }
    }
    Ok(0)
}

fn follow(
    daemon: &mut Daemon,
    handle: &str,
    owner: &str,
    timeout: f64,
) -> Result<Option<i32>, Error> {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    let (id, _) = handle_parts(handle)?;
    let mut offset = 0;
    loop {
        let control = daemon.control_lock()?;
        let state = daemon.state()?;
        let task = daemon.checked(&state, handle, owner)?;
        let file = fs::File::open(daemon.log_path(id));
        let job = snapshot(task, label(task).ok_or("Invalid label")?, daemon, None)?;
        drop(control);
        if let Ok(mut file) = file {
            file.seek(SeekFrom::Start(offset))?;
            offset += io::copy(&mut file, &mut io::stdout().lock())?;
            io::stdout().flush()?;
        }
        if let Some(code) = job.exit_code {
            eprintln!("job={handle} {} exit={code}", job.state);
            return Ok(Some(code));
        }
        if Instant::now() >= deadline {
            println!(
                "job={handle} {}; still running/queued. Continue with `pi-jobs wait {handle}`.",
                job.state
            );
            return Ok(None);
        }
        thread::sleep(
            Duration::from_millis(100).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

fn wait(parser: &mut Parser) -> Result<i32, Error> {
    let mut handle = None;
    let mut timeout = 100.0;
    while let Some(arg) = parser.next()? {
        match arg {
            Value(value) if handle.is_none() => handle = Some(value.string()?),
            Long("timeout") => timeout = parser.value()?.parse()?,
            _ => return Err(arg.unexpected().into()),
        }
    }
    validate_timeout(timeout)?;
    let mut daemon = Daemon::connect()?;
    Ok(follow(
        &mut daemon,
        &handle.ok_or("wait requires a job handle")?,
        &owner()?,
        timeout,
    )?
    .unwrap_or(0))
}

fn stop(parser: &mut Parser) -> Result<i32, Error> {
    let handle = match parser.next()? {
        Some(Value(handle)) => handle.string()?,
        _ => return Err("stop requires a job handle".into()),
    };
    if parser.next()?.is_some() {
        return Err("stop takes one handle".into());
    }
    let mut daemon = Daemon::connect()?;
    let control = daemon.control_lock()?;
    let state = daemon.state()?;
    let session = owner()?;
    let task = daemon.checked(&state, &handle, &session)?;
    if task.is_done() {
        drop(control);
        println!("job={handle} already finished");
        return Ok(0);
    }
    // Pueue Kill only accepts running/paused tasks. Remove an unstarted task
    // instead; the daemon refuses removal if it raced into execution.
    let running = matches!(
        task.status,
        TaskStatus::Running { .. } | TaskStatus::Paused { .. }
    );
    let request = if running {
        Request::Kill(KillRequest {
            tasks: TaskSelection::TaskIds(vec![task.id]),
            signal: None,
        })
    } else {
        Request::Remove(vec![task.id])
    };
    let response = daemon.request(request)?;
    drop(control);
    match response {
        Response::Success(message) => {
            println!("job={handle} stop requested: {message}");
            // Pueue calls its hook for running tasks, but not queued removals.
            if !running && let Err(error) = publish_change(&handle, &session) {
                eprintln!("job={handle}: stop succeeded, but notification failed: {error}");
            }
            Ok(0)
        }
        Response::Failure(error) => Err(error.into()),
        other => Err(format!("Unexpected stop response: {other:?}").into()),
    }
}

fn watch(parser: &mut Parser, action: &str) -> Result<i32, Error> {
    let mut handle = None;
    let mut interval = None;
    while let Some(arg) = parser.next()? {
        match arg {
            Value(value) if handle.is_none() => handle = Some(value.string()?),
            Long("check-in") if action == "watch" => interval = Some(parser.value()?.parse()?),
            _ => return Err(arg.unexpected().into()),
        }
    }
    let handle = handle.ok_or("watch/unwatch requires a job handle")?;
    handle_parts(&handle)?;
    validate_interval(interval)?;
    send_attachment(action, &handle, interval)?;
    println!("job={handle} {action} accepted; execution unchanged");
    Ok(0)
}

fn attach_watch(handle: &str, interval: Option<u64>) {
    if env::var_os("PI_EVENTS_SESSION").is_some() {
        if let Err(error) = send_attachment("watch", handle, interval) {
            eprintln!(
                "job={handle} submitted, but completion watch could not attach: {error}. Execution is still running; inspect with pi-jobs status."
            );
        }
    } else if interval.is_some() {
        eprintln!(
            "job={handle}: no live Pi attachment; requested check-ins unavailable. Execution continues."
        );
    }
}

fn callback_readiness() -> Result<(), Error> {
    let path = config_path()?;
    let (settings, _) = Settings::read(&Some(path))?;
    let ready: CallbackReady = fs::read(readiness_path(&settings))
            .ok().and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .ok_or("Running callback is unverified. Run `pi-jobs doctor` after daemon startup; do not resubmit the job or restart active work.")?;
    if ready.socket != socket_identity(&settings)? {
        return Err("Daemon changed since the callback check. Run `pi-jobs doctor`; do not resubmit the job.".into());
    }
    if !ready.publisher.is_some_and(|path| path.is_file()) {
        return Err("No verified publisher in the daemon deployment. Install pi-events / fix its PATH, then run `pi-jobs doctor`. Job execution is unaffected.".into());
    }
    Ok(())
}

fn send_attachment(action: &str, handle: &str, interval: Option<u64>) -> Result<(), Error> {
    let session = owner()?;
    if action == "watch" {
        callback_readiness()?;
    }
    let binary = env::var_os("PI_EVENTS_BIN").unwrap_or_else(|| "pi-events".into());
    let request = serde_json::json!({"handle":handle,"interval":interval});
    let mut child = process::Command::new(binary)
        .args([
            "publish",
            "--topic",
            &format!("job.{action}"),
            "--source",
            "pi-jobs",
            "--to",
            &session,
        ])
        .stdin(process::Stdio::piped())
        .stdout(process::Stdio::piped())
        .stderr(process::Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or("Could not open event input")?
        .write_all(serde_json::to_string(&request)?.as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(format!(
            "No accepting live jobs subscriber: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_ids_are_not_handles() {
        assert!(handle_parts("2").is_err());
        assert!(handle_parts("2:wrong").is_err());
    }
    #[test]
    fn wait_deadlines_are_not_execution_deadlines() {
        assert!(validate_timeout(0.0).is_ok());
        assert!(validate_timeout(f64::NAN).is_err());
        assert!(validate_timeout(-1.0).is_err());
    }
}
