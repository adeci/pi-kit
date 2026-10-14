import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, narrow, resolveModel, stateDirectory } from "./config";
import { listen } from "./control";
import { RpcTransport } from "./rpc";
import { ProcessGroupOwner } from "./process-owner";
import { snapshotSkills } from "./skills";
import {
  capturePatch,
  createWorkspace,
  integrate,
  removeWorkspace,
  snapshotTree,
} from "./workspace";
import {
  clean,
  currentAssignment,
  deferred,
  report,
  settled,
  text,
  TERMINAL,
  type Agent,
  type Assignment,
  type AssignmentState,
  type ChildConfig,
  type Config,
  type SpawnInput,
} from "./types";

const root = "main";
const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
interface Runtime {
  token: string;
  rpc?: RpcTransport;
  process?: ChildProcessWithoutNullStreams;
  owner?: ProcessGroupOwner;
  ending: boolean;
  finishing: boolean;
  slot: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  parking?: Promise<void>;
  deadline?: ReturnType<typeof setTimeout>;
  done: ReturnType<typeof deferred<void>>;
  transcriptBytes: number;
  liveText?: string;
  liveThinking?: string;
  stderrBytes: number;
  writes: Promise<void>;
}
export interface SupervisorHooks {
  changed(): void;
  notify(parent: string, result: unknown): void;
  observe(topic: string, payload: unknown): void;
}
export class Supervisor {
  readonly agents = new Map<string, Agent>();
  readonly runtime = new Map<string, Runtime>();
  readonly directory: string;
  readonly socket: string;
  config!: Config;
  private server?: Awaited<ReturnType<typeof listen>>;
  private closing = false;
  private closeCall?: Promise<void>;
  private pumping = false;
  private admitting = 0;
  private admissions = new Map<string, number>();
  private lease = false;
  private persistence: Promise<void> = Promise.resolve();
  private integrations = new Map<string, Promise<unknown>>();
  private lifecycle = new Set<Promise<unknown>>();

  constructor(
    readonly ctx: ExtensionContext,
    private hooks: SupervisorHooks,
  ) {
    const session = ctx.sessionManager.getSessionId();
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(session))
      throw new Error("Invalid parent session id");
    this.directory = join(stateDirectory(), session);
    const base = process.env.XDG_RUNTIME_DIR;
    if (!base) throw new Error("XDG_RUNTIME_DIR is required for pi-agents");
    this.socket = join(base, `pa-${randomBytes(8).toString("hex")}.sock`);
    if (Buffer.byteLength(this.socket) > 100)
      throw new Error(
        "Agent control socket path too long; shorten XDG_RUNTIME_DIR",
      );
  }
  async start() {
    this.config = await loadConfig();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const leasePath = join(this.directory, "owner.json");
    try {
      const old = JSON.parse(await readFile(leasePath, "utf8"));
      let alive = false;
      try {
        process.kill(old.pid, 0);
        alive = true;
      } catch (error: any) {
        if (error.code !== "ESRCH") throw error;
      }
      if (alive)
        throw new Error(
          `This agent tree is already owned by live Pi process ${old.pid}.`,
        );
      await unlink(leasePath);
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    const lease = await open(leasePath, "wx", 0o600);
    await lease.writeFile(
      JSON.stringify({ pid: process.pid, socket: this.socket }),
    );
    await lease.close();
    this.lease = true;
    try {
      const path = join(this.directory, "agents.json");
      if ((await stat(path)).size > 32 * 1024 * 1024)
        throw new Error("Agent state too large");
      const saved = JSON.parse(await readFile(path, "utf8"));
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.agents) ||
        saved.agents.length > this.config.maxAgents
      )
        throw new Error("Invalid saved agent state");
      for (const agent of saved.agents as Agent[]) {
        if (
          !/^[a-f0-9]{16}$/.test(agent.id) ||
          this.agents.has(agent.id) ||
          !agent.assignments?.length
        )
          throw new Error("Invalid saved agent handle");
        if (!settled(agent)) {
          currentAssignment(agent).state = "interrupted";
          currentAssignment(agent).error =
            "Owning Pi process ended; resume explicitly.";
          currentAssignment(agent).finished = Date.now();
        }
        if (agent.state !== "stopped") agent.state = "parked";
        agent.activity = "preserved; not executing";
        this.agents.set(agent.id, agent);
        const runtime = this.makeRuntime();
        runtime.done.resolve();
        this.runtime.set(agent.id, runtime);
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        await this.releaseLease();
        throw error;
      }
    }
    try {
      this.server = await listen(
        this.socket,
        (id, token, assignment) => {
          if (
            this.closing ||
            this.runtime.get(id)?.token !== token ||
            !this.runtime.get(id)?.rpc ||
            currentAssignment(this.agents.get(id)!).id !== assignment
          )
            throw new Error("Agent attachment is no longer active");
        },
        (id, operation, args, signal) =>
          this.dispatch(id, operation, args, signal),
      );
      await this.save();
    } catch (error) {
      await this.releaseLease();
      throw error;
    }
  }
  private makeRuntime(): Runtime {
    return {
      token: randomBytes(24).toString("hex"),
      ending: false,
      finishing: false,
      slot: false,
      done: deferred<void>(),
      transcriptBytes: 0,
      stderrBytes: 0,
      writes: Promise.resolve(),
    };
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.lifecycle.add(promise);
    void promise.then(
      () => this.lifecycle.delete(promise),
      () => this.lifecycle.delete(promise),
    );
    return promise;
  }
  private save() {
    const snapshot = JSON.stringify(
      { version: 1, agents: [...this.agents.values()] },
      null,
      2,
    );
    if (Buffer.byteLength(snapshot) > 32 * 1024 * 1024)
      return Promise.reject(
        new Error(
          "Agent metadata exceeds 32 MiB; explicitly forget retained leaf agents.",
        ),
      );
    this.persistence = this.persistence
      .catch(() => {})
      .then(async () => {
        const temporary = join(this.directory, "agents.json.tmp");
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, join(this.directory, "agents.json"));
      });
    return this.persistence;
  }
  private changed() {
    this.hooks.changed();
  }
  private visible(caller: string, agent: Agent): boolean {
    if (caller === root || agent.id === caller) return true;
    let parent = agent.parent;
    while (parent !== root) {
      if (parent === caller) return true;
      parent = this.agents.get(parent)?.parent ?? root;
    }
    return false;
  }
  private get(caller: string, id: unknown): Agent {
    const agent = this.agents.get(text(id, "agent id", 128));
    if (!agent || !this.visible(caller, agent))
      throw new Error("Unknown or inaccessible agent handle");
    return agent;
  }
  private public(agent: Agent) {
    const assignment = currentAssignment(agent);
    return {
      id: agent.id,
      parent: agent.parent,
      depth: agent.depth,
      name: agent.name,
      role: agent.roleName,
      lifetime: agent.lifetime,
      state: agent.state,
      assignment: assignment.id,
      outcome: assignment.state,
      model: agent.model,
      thinking: agent.thinking,
      activity: clean(agent.activity),
      requests: assignment.requests,
      tokens: assignment.tokens,
      cost: assignment.cost,
      cwd: agent.cwd,
      isolated: !!agent.workspace,
      session: agent.sessionFile,
      artifacts: assignment.directory,
      error: assignment.error,
    };
  }
  list(caller = root, includeCompleted = true) {
    const ordered: Agent[] = [],
      seen = new Set<string>();
    const visit = (parent: string) => {
      for (const agent of this.agents.values())
        if (agent.parent === parent && !seen.has(agent.id)) {
          seen.add(agent.id);
          ordered.push(agent);
          visit(agent.id);
        }
    };
    if (caller !== root && this.agents.has(caller)) {
      ordered.push(this.agents.get(caller)!);
      seen.add(caller);
    }
    visit(caller);
    return ordered
      .filter((agent) => includeCompleted || !settled(agent))
      .map((agent) => this.public(agent));
  }
  async dispatch(
    caller: string,
    operation: string,
    args: any = {},
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.closing) throw new Error("Owning Pi session is shutting down");
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("Invalid agent arguments");
    switch (operation) {
      case "roles":
        return {
          limits: {
            maxDepth: this.config.maxDepth,
            idleTtlMs: this.config.idleTtlMs,
            maxAgents: this.config.maxAgents,
          },
          roles: Object.fromEntries(
            Object.entries(this.config.roles).map(([name, role]) => [
              name,
              {
                ...role,
                prompt: undefined,
              },
            ]),
          ),
        };
      case "spawn":
        return this.spawn(caller, args);
      case "list":
        return this.list(caller, args.includeCompleted !== false);
      case "status":
        return this.status(caller, args.id, args.view ?? "status");
      case "assign":
        return this.assign(
          caller,
          args.id,
          text(args.task, "task"),
          args.context ?? "",
          false,
          args,
        );
      case "resume": {
        const agent = this.get(caller, args.id);
        if (
          !args.task &&
          ["completed", "blocked"].includes(currentAssignment(agent).state)
        )
          throw new Error(
            "Finished assignments require an explicit new task; use agent_assign.",
          );
        return this.assign(
          caller,
          agent.id,
          args.task ?? currentAssignment(agent).task,
          args.context ?? currentAssignment(agent).context,
          true,
          args,
        );
      }
      case "send":
        return this.send(caller, args.id, text(args.message, "message"));
      case "wait":
        return this.wait(caller, args.ids, args.timeoutSeconds, signal);
      case "stop": {
        const agent = this.get(caller, args.id);
        if (caller === agent.id)
          throw new Error("Use agent_yield rather than stopping yourself");
        await this.stopBranch(agent.id, args.branch !== false, "cancelled");
        return this.public(agent);
      }
      case "integrate":
        return this.apply(caller, args.id, args.assignment);
      case "forget": {
        const agent = this.get(caller, args.id);
        if (agent.id === caller) throw new Error("Cannot forget yourself");
        await this.forget(agent.id);
        return { forgotten: agent.id };
      }
      case "ready": {
        const agent = this.get(caller, caller);
        if (
          args.assignment !== currentAssignment(agent).id ||
          args.model !== agent.model
        )
          throw new Error("Child assignment/model handshake mismatch");
        return { accepted: true };
      }
      case "usage": {
        const agent = this.get(caller, caller);
        if (
          !Number.isSafeInteger(args.requests) ||
          args.requests < currentAssignment(agent).requests ||
          args.requests > 1000000
        )
          throw new Error("Invalid request count");
        currentAssignment(agent).requests = args.requests;
        this.changed();
        return { accepted: true };
      }
      case "yield": {
        const agent = this.get(caller, caller),
          assignment = currentAssignment(agent);
        if (agent.state !== "running" || assignment.report)
          throw new Error("Assignment cannot yield in its current state");
        const pending = [...this.agents.values()].filter(
          (a) => a.parentAssignment === assignment.id && !settled(a),
        );
        if (pending.length || this.admissions.get(caller))
          throw new Error(
            `Delegates are still active: ${pending.map((a) => a.id).join(", ")}. Wait and inspect results before yielding.`,
          );
        assignment.report = report(args.report);
        if (args.budget)
          assignment.error = "Request budget forced final reporting";
        await this.save();
        return { accepted: true, assignment: assignment.id };
      }
      default:
        throw new Error(`Unknown agent operation ${operation}`);
    }
  }
  private spawn(caller: string, input: SpawnInput) {
    if (this.agents.size + this.admitting >= this.config.maxAgents)
      throw new Error(
        "Retained agent limit reached; explicitly forget old leaf agents with agent_forget.",
      );
    this.admitting++;
    this.admissions.set(caller, (this.admissions.get(caller) ?? 0) + 1);
    return this.track(this.prepareSpawn(caller, input)).finally(() => {
      this.admitting--;
      const remaining = this.admissions.get(caller)! - 1;
      if (remaining) this.admissions.set(caller, remaining);
      else this.admissions.delete(caller);
    });
  }
  private async prepareSpawn(caller: string, input: SpawnInput) {
    text(input.task, "task");
    if (input.context !== undefined) text(input.context || " ", "context");
    const parent = caller === root ? undefined : this.get(caller, caller);
    if (
      parent &&
      (parent.state !== "running" || currentAssignment(parent).report)
    )
      throw new Error("Delegating assignment is not active");
    const parentAssignment = parent && currentAssignment(parent).id;
    const depth = parent ? parent.depth + 1 : 1;
    if (depth > this.config.maxDepth)
      throw new Error(
        `Delegation depth ${depth} exceeds configured maximum ${this.config.maxDepth}`,
      );
    const roleName = input.role ?? "task",
      role = this.config.roles[roleName];
    if (!role) throw new Error(`Unknown agent role ${roleName}`);
    const model = resolveModel(
      input,
      role,
      this.ctx.modelRegistry.getAvailable(),
    );
    const tools = narrow(input.tools, role.tools, "tools"),
      skills = narrow(input.skills, role.skills, "skills");
    const thinking = input.thinking ?? role.thinking;
    if (
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        thinking,
      )
    )
      throw new Error("Invalid thinking level");
    if (
      input.lifetime !== undefined &&
      input.lifetime !== "task" &&
      input.lifetime !== "reusable"
    )
      throw new Error("Invalid agent lifetime");
    const id = randomBytes(8).toString("hex"),
      directory = join(this.directory, id);
    const sourceCwd = resolve(parent?.cwd ?? this.ctx.cwd, input.cwd ?? ".");
    if (!(await stat(sourceCwd)).isDirectory())
      throw new Error("Agent cwd must be a directory");
    const agent: Agent = {
      id,
      parent: caller,
      parentAssignment,
      depth,
      name: input.name ? text(input.name, "name", 128) : roleName,
      roleName,
      role: { ...role },
      lifetime: input.lifetime ?? "task",
      state: "queued",
      model,
      thinking,
      tools,
      skills,
      skillSnapshots: [],
      sourceCwd,
      cwd: sourceCwd,
      directory,
      assignments: [],
      activity: "queued",
      created: Date.now(),
    };
    // Record the isolation choice independently from workspace preparation.
    if (input.isolated ?? role.writable)
      agent.workspace = {
        source: "",
        directory: join(directory, "workspace"),
        head: "",
        initialTree: "",
      };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    agent.skillSnapshots = await snapshotSkills(
      skills,
      join(directory, "skills"),
    );
    agent.assignments.push(
      this.newAssignment(agent, input.task, input.context ?? ""),
    );
    if (this.closing) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("Owning Pi ended before assignment admission");
    }
    if (
      parent &&
      (parent.state !== "running" ||
        currentAssignment(parent).id !== parentAssignment ||
        currentAssignment(parent).report)
    ) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("Delegating assignment ended before child admission");
    }
    this.agents.set(id, agent);
    this.runtime.set(id, this.makeRuntime());
    await this.save();
    this.changed();
    this.pump();
    return this.public(agent);
  }
  private newAssignment(
    agent: Agent,
    task: string,
    context: string,
  ): Assignment {
    text(task, "task");
    if (context && Buffer.byteLength(context) > 65536)
      throw new Error("Assignment context too large");
    const id = `${agent.id}:${agent.assignments.length + 1}`;
    return {
      id,
      task,
      context,
      state: "queued",
      created: Date.now(),
      partial: "",
      requests: 0,
      tokens: 0,
      cost: 0,
      directory: join(
        agent.directory,
        `assignment-${agent.assignments.length + 1}`,
      ),
    };
  }
  private async assign(
    caller: string,
    id: unknown,
    task: string,
    context: string,
    resume: boolean,
    overrides: Pick<SpawnInput, "model" | "thinking"> = {},
  ) {
    const agent = this.get(caller, id),
      runtime = this.runtime.get(agent.id)!;
    await runtime.parking;
    if (agent.id === caller)
      throw new Error("An agent cannot assign work to itself");
    if (!settled(agent) || !["idle", "parked"].includes(agent.state))
      throw new Error("Agent is active or explicitly stopped");
    if (!resume && agent.lifetime !== "reusable")
      throw new Error("Use agent_resume for an interrupted task-scoped agent");
    const role = this.config.roles[agent.roleName];
    if (!role) throw new Error("Agent role is no longer configured");
    narrow(agent.tools, role.tools, "tools");
    narrow(agent.skills, role.skills, "skills");
    const model = resolveModel(
      { task, model: overrides.model ?? agent.model },
      role,
      this.ctx.modelRegistry.getAvailable(),
    );
    const thinking = overrides.thinking ?? agent.thinking;
    if (
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        thinking,
      )
    )
      throw new Error("Invalid thinking level");
    agent.role = { ...role };
    clearTimeout(runtime.idleTimer);
    if (
      agent.parent !== root &&
      this.agents.get(agent.parent)?.state !== "running"
    )
      throw new Error(
        "Resume the delegating parent before assigning its children.",
      );
    agent.parentAssignment =
      agent.parent === root
        ? undefined
        : currentAssignment(this.get(caller, agent.parent)).id;
    const previous = currentAssignment(agent);
    const assignment = this.newAssignment(agent, task, context);
    if (model !== agent.model || thinking !== agent.thinking)
      await this.closeProcess(agent);
    agent.model = model;
    agent.thinking = thinking;
    if (resume && !["completed", "blocked"].includes(previous.state)) {
      assignment.baseline = previous.baseline;
      assignment.resumedFrom = previous.id;
    }
    // Full older reports remain in assignment/result sidecars and Pi sessions.
    // Keep their integration metadata without duplicating prose in live memory.
    if (previous.finished) {
      previous.task = "";
      previous.context = "";
      previous.partial = "";
      previous.report = undefined;
    }
    agent.assignments.push(assignment);
    agent.state = "queued";
    agent.activity = "queued";
    runtime.done = deferred();
    runtime.finishing = false;
    await this.save();
    this.changed();
    this.pump();
    return this.public(agent);
  }
  private pump() {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      for (const agent of this.agents.values()) {
        if (agent.state !== "queued") continue;
        const effective =
          agent.parent === root
            ? this.config.maxConcurrency
            : this.agents.get(agent.parent)!.role.maxConcurrency;
        const active = [...this.agents.values()].filter(
          (a) => a.parent === agent.parent && this.runtime.get(a.id)?.slot,
        ).length;
        if (effective && active >= effective) continue;
        const runtime = this.runtime.get(agent.id)!;
        runtime.slot = true;
        agent.state = "starting";
        agent.activity = "starting";
        void this.track(this.run(agent)).catch((error) =>
          this.track(this.finish(agent, "failed", String(error))),
        );
      }
    } finally {
      this.pumping = false;
      this.changed();
    }
  }
  private async childConfiguration(agent: Agent) {
    const runtime = this.runtime.get(agent.id)!,
      assignment = currentAssignment(agent);
    const config: ChildConfig = {
      version: 1,
      id: agent.id,
      parent: agent.parent,
      rootSession: this.ctx.sessionManager.getSessionId(),
      assignment: assignment.id,
      model: agent.model,
      socket: this.socket,
      token: runtime.token,
      tools: agent.tools,
      skills: agent.skillSnapshots,
      prompt: agent.role.prompt,
      requestBudget: agent.role.requestBudget,
      maxRuntimeMs: agent.role.maxRuntimeMs,
      directory: agent.directory,
    };
    const path = join(agent.directory, "child.json");
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    return path;
  }
  private async run(agent: Agent) {
    const runtime = this.runtime.get(agent.id)!,
      assignment = currentAssignment(agent);
    await mkdir(assignment.directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(assignment.directory, "assignment.json"),
      JSON.stringify(
        {
          task: assignment.task,
          context: assignment.context,
          model: agent.model,
          tools: agent.tools,
          skills: agent.skills,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (agent.workspace && !agent.workspace.head) {
      const prepared = await createWorkspace(
        agent.sourceCwd,
        agent.workspace.directory,
        this.config.snapshotBytes,
      );
      agent.workspace = prepared.workspace;
      agent.cwd = prepared.cwd;
    }
    if (this.closing || agent.state !== "starting") return;
    if (agent.workspace && !assignment.baseline)
      assignment.baseline = await snapshotTree(
        agent.workspace.directory,
        this.config.snapshotBytes,
      );
    if (!runtime.rpc) runtime.token = randomBytes(24).toString("hex");
    const path = await this.childConfiguration(agent);
    if (!runtime.rpc) {
      const args = [
        "--mode",
        "rpc",
        "--no-extensions",
        "--extension",
        join(here, "child.ts"),
        ...agent.role.extensions.flatMap((p) => ["--extension", p]),
        "--no-skills",
        ...agent.skillSnapshots.flatMap((p) => ["--skill", p]),
        "--no-prompt-templates",
        "--no-themes",
        "--no-approve",
        "--session-dir",
        join(agent.directory, "sessions"),
        "--name",
        `agent:${agent.name}`,
        "--model",
        agent.model,
        "--thinking",
        agent.thinking,
        "--tools",
        [
          ...agent.tools,
          "agent_yield",
          "agent_roles",
          "agent_spawn",
          "agent_assign",
          "agent_resume",
          "agent_send",
          "agent_list",
          "agent_status",
          "agent_wait",
          "agent_stop",
          "agent_integrate",
          "agent_forget",
        ].join(","),
        "--pi-agents-child",
        path,
      ];
      if (agent.sessionFile) args.push("--session", agent.sessionFile);
      let command = process.env.PI_AGENTS_PI_BIN;
      if (!command)
        command = /^(node|bun)$/.test(basename(process.execPath))
          ? "pi"
          : process.execPath;
      const installedGuard = join(here, "..", "guard");
      const invocation = existsSync(installedGuard)
        ? { command: installedGuard, args: [command, ...args] }
        : {
            command: "python3",
            args: [join(here, "..", "guard.py"), command, ...args],
          };
      const child = spawn(invocation.command, invocation.args, {
        cwd: agent.cwd,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_EVENTS_SUBSCRIPTION: undefined,
          PI_JOBS_SESSION: `${this.ctx.sessionManager.getSessionId()}:${agent.id}`,
        },
      }) as ChildProcessWithoutNullStreams;
      runtime.process = child;
      runtime.ending = false;
      const owner = new ProcessGroupOwner(child, {
        onDiagnostic: (message) => {
          if (runtime.process === child) {
            agent.activity = message;
            this.changed();
          }
        },
      });
      runtime.owner = owner;
      runtime.rpc = new RpcTransport(child, {
        idPrefix: agent.id,
        onEvent: (event) => {
          if (runtime.process === child) this.event(agent, event);
        },
        onRecord: (_record, line) => {
          if (runtime.transcriptBytes < 16 * 1024 * 1024) {
            runtime.transcriptBytes += Buffer.byteLength(line);
            runtime.writes = runtime.writes.then(() =>
              appendFile(join(agent.directory, "rpc.jsonl"), line + "\n", {
                mode: 0o600,
              }),
            );
            void runtime.writes.catch(() => {});
          }
        },
        onDiagnostic: (message) => {
          agent.activity = message;
          this.changed();
        },
        onStderr: (value) => {
          if (runtime.stderrBytes < 1024 * 1024) {
            const chunk = clean(value).slice(0, 8192);
            runtime.stderrBytes += Buffer.byteLength(chunk);
            runtime.writes = runtime.writes.then(() =>
              appendFile(join(agent.directory, "stderr.log"), chunk, {
                mode: 0o600,
              }),
            );
            void runtime.writes.catch(() => {});
          }
        },
        onProtocolFailure: (error) => {
          if (runtime.process === child && !runtime.ending)
            void this.track(this.finish(agent, "failed", error.message));
        },
        onClose: (exit) => {
          owner.markLeaderClosed();
          if (runtime.process === child && !runtime.ending && !settled(agent))
            void this.track(
              this.finish(
                agent,
                "failed",
                `Agent process exited: ${exit.code}/${exit.signal}`,
              ),
            );
        },
      });
      const rpc = runtime.rpc;
      await rpc.request("get_state");
      if (!agent.sessionFile) {
        const parentSession =
          agent.parent === root
            ? this.ctx.sessionManager.getSessionFile()
            : this.agents.get(agent.parent)?.sessionFile;
        await rpc.request(
          "new_session",
          parentSession ? { parentSession } : {},
        );
      }
      const state = (await rpc.request("get_state")) as any;
      if (
        !state?.model ||
        `${state.model.provider}/${state.model.id}` !== agent.model ||
        !state.sessionFile
      )
        throw new Error("Child session/model handshake failed");
      agent.sessionFile = state.sessionFile;
      agent.thinking = state.thinkingLevel ?? agent.thinking;
    }
    if (this.closing || agent.state !== "starting") return;
    await runtime.rpc.request("prompt", { message: "/pi-agents-begin" });
    agent.state = "running";
    agent.activity = "working";
    assignment.state = "running";
    assignment.started = Date.now();
    await this.save();
    this.changed();
    if (agent.role.maxRuntimeMs)
      runtime.deadline = setTimeout(
        () => void this.track(this.stopBranch(agent.id, true, "timeout")),
        agent.role.maxRuntimeMs,
      );
    await runtime.rpc.request("prompt", {
      message: `Assignment ${assignment.id}:\n${assignment.task}${assignment.context ? `\n\nSelected context:\n${assignment.context}` : ""}`,
    });
  }
  private event(agent: Agent, event: Record<string, any>) {
    const assignment = currentAssignment(agent),
      runtime = this.runtime.get(agent.id)!;
    if (runtime.ending) return;
    if (event.type === "message_start" && event.message?.role === "assistant") {
      runtime.liveText = "";
      runtime.liveThinking = "";
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "thinking_delta"
    ) {
      runtime.liveThinking = (
        (runtime.liveThinking ?? "") +
        clean(event.assistantMessageEvent.delta ?? "")
      ).slice(-8192);
      agent.activity = "thinking";
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      const delta = clean(event.assistantMessageEvent.delta ?? "");
      assignment.partial = (assignment.partial + delta).slice(-65536);
      runtime.liveText = ((runtime.liveText ?? "") + delta).slice(-8192);
      agent.activity = "responding";
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      runtime.liveText = "";
      runtime.liveThinking = "";
      const message = event.message;
      assignment.tokens += message.usage?.totalTokens ?? 0;
      assignment.cost += message.usage?.cost?.total ?? 0;
      if (message.stopReason === "error")
        assignment.error = String(
          message.errorMessage ?? "Provider failed",
        ).slice(0, 4096);
    }
    if (event.type === "tool_execution_start")
      agent.activity = `tool: ${event.toolName}`;
    if (event.type === "tool_execution_end") agent.activity = "working";
    if (event.type === "auto_retry_start")
      agent.activity = `retry ${event.attempt}`;
    if (event.type === "extension_ui_request" && event.id) {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        runtime.process?.stdin.write(
          JSON.stringify({
            type: "extension_ui_response",
            id: event.id,
            cancelled: true,
          }) + "\n",
        );
        agent.activity =
          "Extension requested interactive input; dialog cancelled. Report the blocker to the parent.";
      } else if (event.method === "notify")
        agent.activity = clean(String(event.message)).slice(0, 256);
    }
    if (event.type === "agent_settled" && !runtime.finishing) {
      const state =
        assignment.error === "Request budget forced final reporting" ||
        (agent.role.requestBudget &&
          assignment.requests >= Math.ceil(agent.role.requestBudget * 1.5) &&
          !assignment.report)
          ? "budget"
          : assignment.report
            ? assignment.report.outcome
            : "failed";
      void this.track(
        this.finish(
          agent,
          state,
          assignment.report
            ? assignment.error
            : (assignment.error ??
                "Agent settled without an explicit result report; partial output retained."),
        ),
      );
    }
    this.changed();
  }
  private async closeProcess(agent: Agent) {
    const runtime = this.runtime.get(agent.id)!;
    clearTimeout(runtime.idleTimer);
    clearTimeout(runtime.deadline);
    if (!runtime.rpc) return;
    runtime.ending = true;
    // EOF on fd 3 is the kernel-backed parent lifetime signal, independent of RPC.
    (
      runtime.process?.stdio[3] as import("node:stream").Writable | undefined
    )?.end();
    runtime.process?.stdin.end();
    await runtime.owner?.requestTermination({
      termAfterMs: 1000,
      killAfterMs: 8000,
    });
    runtime.rpc = undefined;
    runtime.process = undefined;
    runtime.owner = undefined;
    runtime.ending = false;
  }
  private async finish(agent: Agent, state: AssignmentState, error?: string) {
    const runtime = this.runtime.get(agent.id)!,
      assignment = currentAssignment(agent);
    if (runtime.finishing || settled(agent)) return;
    runtime.finishing = true;
    clearTimeout(runtime.deadline);
    assignment.state = "settling";
    agent.state = "settling";
    agent.activity = "saving result";
    const descendants = [...this.agents.values()].filter(
      (a) => a.parentAssignment === assignment.id && !settled(a),
    );
    if (descendants.length)
      await Promise.all(
        descendants.map((a) =>
          this.stopBranch(
            a.id,
            true,
            state === "interrupted" ? "interrupted" : "cancelled",
          ),
        ),
      );
    if (
      (state !== "completed" && state !== "blocked" && state !== "failed") ||
      !assignment.report
    )
      await this.closeProcess(agent);
    if (agent.workspace?.head && assignment.baseline) {
      try {
        assignment.patch = join(assignment.directory, "changes.patch");
        await capturePatch(
          agent.workspace,
          assignment.baseline,
          assignment.patch,
          this.config.snapshotBytes,
        );
      } catch (failure) {
        state = "failed";
        error = `Patch capture failed: ${String(failure)}`;
        assignment.patch = undefined;
      }
    }
    assignment.state = state;
    assignment.error = error;
    assignment.finished = Date.now();
    if (agent.lifetime === "task") {
      await this.closeProcess(agent);
      agent.state = ["completed", "blocked", "cancelled"].includes(state)
        ? "stopped"
        : "parked";
    } else agent.state = runtime.rpc && !this.closing ? "idle" : "parked";
    agent.activity = `${state}; result retained`;
    try {
      await runtime.writes;
      await mkdir(assignment.directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(assignment.directory, "result.json"),
        JSON.stringify(
          {
            ...assignment,
            model: agent.model,
            thinking: agent.thinking,
            session: agent.sessionFile,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await this.save();
    } catch (failure) {
      assignment.state = "failed";
      assignment.error = `Result persistence failed: ${String(failure)}`;
    }
    runtime.slot = false;
    runtime.finishing = false;
    runtime.done.resolve();
    this.changed();
    this.pump();
    const result = {
      ...this.public(agent),
      report: assignment.report,
      partial: assignment.partial.slice(-4096),
      patch: assignment.patch,
      persistenceFailed:
        assignment.error?.startsWith("Result persistence failed:") ?? false,
    };
    if (!this.closing) {
      if (agent.parent === root) this.hooks.notify(root, result);
      else {
        const parent = this.agents.get(agent.parent),
          owner = this.runtime.get(agent.parent);
        if (
          parent &&
          owner?.rpc &&
          !settled(parent) &&
          !currentAssignment(parent).report
        ) {
          await owner.rpc
            .request("prompt", {
              message: `Delegate result (inspect with agent_status; settlement is not proof of correctness):\n${JSON.stringify(result)}`,
              streamingBehavior: "followUp",
            })
            .catch((failure) => {
              parent.activity = `Result delivery failed; inspect ${agent.id}: ${String(failure)}`;
              this.changed();
            });
        }
      }
      this.hooks.observe("agents.assignment.completed", result);
      if (agent.state === "idle" && this.config.idleTtlMs)
        runtime.idleTimer = setTimeout(
          () => void this.track(this.park(agent)),
          this.config.idleTtlMs,
        );
    }
  }
  private park(agent: Agent): Promise<void> {
    const runtime = this.runtime.get(agent.id)!;
    return (runtime.parking ??= this.parkIdle(agent).finally(() => {
      runtime.parking = undefined;
    }));
  }
  private async parkIdle(agent: Agent) {
    if (agent.state !== "idle") return;
    agent.state = "settling";
    agent.activity = "parking; conversation retained";
    this.changed();
    await this.closeProcess(agent);
    agent.state = "parked";
    agent.activity = "parked; conversation retained";
    await this.save();
    this.changed();
  }
  private async stopBranch(
    id: string,
    branch: boolean,
    reason: AssignmentState,
  ) {
    const agent = this.agents.get(id)!;
    await this.runtime.get(id)?.parking;
    if (branch)
      for (const child of this.agents.values())
        if (child.parent === id) await this.stopBranch(child.id, true, reason);
    if (!settled(agent))
      await this.finish(
        agent,
        reason,
        reason === "interrupted"
          ? "Owning Pi ended; resume explicitly."
          : `Agent ${reason}`,
      );
    await this.closeProcess(agent);
    agent.state = reason === "cancelled" ? "stopped" : "parked";
    await this.save();
    this.changed();
  }
  private async send(caller: string, id: unknown, message: string) {
    const origin = {
      from: caller,
      assignment:
        caller === root
          ? undefined
          : currentAssignment(this.agents.get(caller)!).id,
      session: this.ctx.sessionManager.getSessionId(),
    };
    if (id === root && caller !== root) {
      this.hooks.notify(root, {
        ...origin,
        to: root,
        message,
        kind: "agent-message",
      });
      return { accepted: true, completion: false };
    }
    let ancestor = this.agents.get(caller)?.parent;
    while (ancestor && ancestor !== root && ancestor !== id)
      ancestor = this.agents.get(ancestor)?.parent;
    const agent =
      ancestor === id ? this.agents.get(String(id))! : this.get(caller, id);
    if (agent.id === caller)
      throw new Error("An agent cannot send work to itself");
    const runtime = this.runtime.get(agent.id)!;
    await runtime.parking;
    if (
      (agent.state === "running" && currentAssignment(agent).report) ||
      agent.state === "settling"
    )
      throw new Error(
        "Agent has yielded or is settling; wait for settlement before assigning new work.",
      );
    if (agent.state === "running" && runtime.rpc) {
      await runtime.rpc.request("steer", {
        message: `Addressed guidance ${JSON.stringify({ ...origin, to: agent.id, targetAssignment: currentAssignment(agent).id })}:\n${message}`,
      });
      return { accepted: true, completion: false };
    }
    if (ancestor === id) throw new Error("Parent is not accepting guidance");
    return this.assign(
      caller,
      agent.id,
      `Addressed guidance ${JSON.stringify({ ...origin, to: agent.id })}:\n${message}`,
      "",
      false,
    );
  }
  private async wait(
    caller: string,
    ids: unknown,
    seconds: unknown,
    signal?: AbortSignal,
  ) {
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 1 ||
      seconds > 3600
    )
      throw new Error("Wait timeout must be 1..3600 seconds");
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.length > 256)
    )
      throw new Error("Invalid wait snapshot");
    const selected =
      ids === undefined
        ? [...this.agents.values()].filter(
            (a) => a.parent === caller && !settled(a),
          )
        : (ids as string[]).map((id) => this.get(caller, id));
    if (selected.some((a) => a.parent !== caller))
      throw new Error("Wait targets must be direct children");
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined,
      abort: (() => void) | undefined;
    try {
      const outcome = await Promise.race([
        Promise.all(
          selected.map((a) => this.runtime.get(a.id)!.done.promise),
        ).then(() => "settled"),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("elapsed"), seconds * 1000);
        }),
        new Promise<string>((resolve) => {
          abort = () => resolve("cancelled");
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
      return { outcome, agents: selected.map((a) => this.public(a)) };
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  async status(caller: string, id: unknown, view: string) {
    const agent = this.get(caller, id),
      assignment = currentAssignment(agent);
    if (view === "status")
      return {
        ...this.public(agent),
        roleLimits: {
          requestBudget: agent.role.requestBudget,
          maxConcurrency: agent.role.maxConcurrency,
          maxRuntimeMs: agent.role.maxRuntimeMs,
        },
        assignments: agent.assignments.map((a) => ({
          id: a.id,
          state: a.state,
          created: a.created,
          finished: a.finished,
          directory: a.directory,
          patch: a.patch,
          integrated: a.integrated,
        })),
        report: assignment.report,
        task: assignment.task,
        selectedContext: assignment.context,
      };
    if (view === "result") return { ...this.public(agent), ...assignment };
    const path =
      view === "diff"
        ? assignment.patch
        : view === "conversation"
          ? agent.sessionFile
          : view === "prompt"
            ? join(agent.directory, "effective-prompt.txt")
            : undefined;
    if (!path) throw new Error("Requested artifact is unavailable");
    const file = await open(path, "r");
    try {
      const bytes = Buffer.alloc(65536);
      const size = await file.stat();
      const { bytesRead } = await file.read(
        bytes,
        0,
        bytes.length,
        view === "conversation" ? Math.max(0, size.size - bytes.length) : 0,
      );
      return {
        path,
        truncated: size.size > bytes.length,
        text: clean(bytes.subarray(0, bytesRead).toString("utf8")),
      };
    } finally {
      await file.close();
    }
  }
  private async apply(caller: string, id: unknown, assignmentId?: string) {
    const agent = this.get(caller, id);
    const assignment = assignmentId
      ? agent.assignments.find((a) => a.id === assignmentId)
      : currentAssignment(agent);
    if (
      !assignment ||
      !TERMINAL.has(assignment.state) ||
      !agent.workspace?.head ||
      !assignment.patch
    )
      throw new Error("No settled isolated diff is available");
    if (assignment.integrated)
      return { applied: false, alreadyIntegrated: true };
    const source = agent.workspace.source;
    const prior = this.integrations.get(source) ?? Promise.resolve();
    const operation = prior
      .catch(() => {})
      .then(async () => {
        if (assignment.integrated)
          return { applied: false, alreadyIntegrated: true };
        await integrate(agent.workspace!, assignment.patch!);
        assignment.integrated = Date.now();
        await this.save();
        this.changed();
        return {
          applied: true,
          source,
          patch: assignment.patch,
          committed: false,
        };
      });
    this.integrations.set(source, operation);
    try {
      return await operation;
    } finally {
      if (this.integrations.get(source) === operation)
        this.integrations.delete(source);
    }
  }
  async forget(id: string) {
    const agent = this.get(root, id);
    if (
      !settled(agent) ||
      [...this.agents.values()].some((a) => a.parent === id)
    )
      throw new Error(
        "Forget requires a settled leaf agent; forget descendants first.",
      );
    await this.closeProcess(agent);
    if (agent.workspace?.head) await removeWorkspace(agent.workspace);
    this.agents.delete(id);
    this.runtime.delete(id);
    await this.save();
    await rm(agent.directory, { recursive: true, force: true });
    this.changed();
  }
  private async releaseLease() {
    if (this.lease) {
      await unlink(join(this.directory, "owner.json")).catch(() => {});
      this.lease = false;
    }
  }
  close(): Promise<void> {
    return (this.closeCall ??= this.doClose());
  }
  private async doClose() {
    this.closing = true;
    if (!this.lease) return;
    await this.server?.close();
    for (const runtime of this.runtime.values()) {
      runtime.ending = true;
      (
        runtime.process?.stdio[3] as import("node:stream").Writable | undefined
      )?.end();
      runtime.process?.stdin.end();
    }
    await Promise.all(
      [...this.agents.values()]
        .filter((agent) => agent.parent === root)
        .map((agent) => this.stopBranch(agent.id, true, "interrupted")),
    );
    await Promise.allSettled([...this.lifecycle]);
    try {
      await this.save();
    } finally {
      await this.releaseLease();
    }
  }
}
