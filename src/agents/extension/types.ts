export type Lifetime = "task" | "reusable";
export type AgentState =
  | "queued"
  | "starting"
  | "running"
  | "settling"
  | "idle"
  | "parked"
  | "stopped";
export type AssignmentState =
  | "queued"
  | "running"
  | "settling"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "budget"
  | "timeout";
export interface Report {
  outcome: "completed" | "blocked" | "failed";
  summary: string;
  artifacts: string[];
  validation: string[];
  unresolved: string[];
  data?: unknown;
}
export interface Role {
  description: string;
  prompt: string;
  model: string | null;
  thinking: string;
  tools: string[];
  skills: string[];
  extensions: string[];
  writable: boolean;
  requestBudget: number;
  maxRuntimeMs: number;
  maxConcurrency: number;
}
export interface Config {
  version: 1;
  roles: Record<string, Role>;
  maxDepth: number;
  maxConcurrency: number;
  idleTtlMs: number;
  maxAgents: number;
  snapshotBytes: number;
}
export interface SpawnInput {
  role?: string;
  task: string;
  context?: string;
  name?: string;
  lifetime?: Lifetime;
  cwd?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
  isolated?: boolean;
}
export interface Assignment {
  id: string;
  task: string;
  context: string;
  state: AssignmentState;
  created: number;
  started?: number;
  finished?: number;
  report?: Report;
  error?: string;
  partial: string;
  requests: number;
  tokens: number;
  cost: number;
  directory: string;
  baseline?: string;
  resumedFrom?: string;
  patch?: string;
  integrated?: number;
}
export interface Workspace {
  source: string;
  directory: string;
  head: string;
  initialTree: string;
}
export interface Agent {
  id: string;
  parent: string;
  parentAssignment?: string;
  depth: number;
  name: string;
  roleName: string;
  role: Role;
  lifetime: Lifetime;
  state: AgentState;
  model: string;
  thinking: string;
  tools: string[];
  skills: string[];
  skillSnapshots: string[];
  sourceCwd: string;
  cwd: string;
  workspace?: Workspace;
  directory: string;
  sessionFile?: string;
  assignments: Assignment[];
  activity: string;
  created: number;
}
export interface ChildConfig {
  version: 1;
  id: string;
  parent: string;
  rootSession: string;
  assignment: string;
  model: string;
  socket: string;
  token: string;
  tools: string[];
  skills: string[];
  prompt: string;
  requestBudget: number;
  maxRuntimeMs: number;
  directory: string;
}
export const TERMINAL = new Set<AssignmentState>([
  "completed",
  "blocked",
  "failed",
  "cancelled",
  "interrupted",
  "budget",
  "timeout",
]);
export const currentAssignment = (agent: Agent) => agent.assignments.at(-1)!;
export const settled = (agent: Agent) =>
  TERMINAL.has(currentAssignment(agent).state);
export function text(value: unknown, label: string, max = 65536): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
export function clean(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function report(value: unknown): Report {
  const r = value as Report;
  if (!r || !["completed", "blocked", "failed"].includes(r.outcome))
    throw new Error("Invalid report outcome");
  text(r.summary, "summary", 32768);
  for (const key of ["artifacts", "validation", "unresolved"] as const) {
    if (
      !Array.isArray(r[key]) ||
      r[key].length > 64 ||
      r[key].some((v) => typeof v !== "string" || Buffer.byteLength(v) > 4096)
    )
      throw new Error(`Invalid report ${key}`);
  }
  if (Buffer.byteLength(JSON.stringify(r)) > 131072)
    throw new Error("Report too large");
  return r;
}
