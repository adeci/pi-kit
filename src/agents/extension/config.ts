import { readFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Role, SpawnInput } from "./types";
import { text } from "./types";

const resourceDirectory = dirname(realpathSync(fileURLToPath(import.meta.url)));
const readonly = ["read", "grep", "find", "ls"];
const writable = [...readonly, "bash", "edit", "write"];
const thinking = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const configPath = () =>
  process.env.PI_AGENTS_CONFIG ||
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "pi-kit",
    "agents.json",
  );
export const stateDirectory = () =>
  process.env.PI_AGENTS_STATE_DIR ||
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
    "pi-kit",
    "agents",
  );

function integer(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`Invalid ${label}: expected integer ${min}..${max}`);
  return value as number;
}
function names(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((v) => typeof v !== "string" || !v || v.length > 256) ||
    new Set(value).size !== value.length
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
function resource(path: string, base: string): string {
  const expanded = path.startsWith("~/")
    ? join(homedir(), path.slice(2))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}
export async function loadConfig(path = configPath()): Promise<Config> {
  let raw: any = {};
  try {
    if ((await stat(path)).size > 262144)
      throw new Error("Agent configuration exceeds 256 KiB");
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Agent configuration must be an object");
  if (raw.version !== undefined && raw.version !== 1)
    throw new Error("Unsupported agent configuration version");
  const defaults: Record<string, Partial<Role>> = {
    task: {
      description: "Implement a delegated task",
      writable: true,
      tools: writable,
      requestBudget: 200,
    },
    scout: {
      description: "Investigate and report findings",
      writable: false,
      tools: readonly,
      requestBudget: 100,
    },
    reviewer: {
      description: "Review changes and run scoped validation",
      writable: false,
      tools: [...readonly, "bash"],
      requestBudget: 200,
    },
    sonic: {
      description: "Make tightly specified mechanical changes",
      writable: true,
      tools: writable,
      requestBudget: 100,
    },
  };
  const configured = raw.roles ?? {};
  if (
    !configured ||
    typeof configured !== "object" ||
    Array.isArray(configured) ||
    Object.keys(configured).length > 32
  )
    throw new Error("Invalid agent roles");
  const roles: Record<string, Role> = {};
  for (const name of new Set([
    ...Object.keys(defaults),
    ...Object.keys(configured),
  ])) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name))
      throw new Error(`Invalid role name ${name}`);
    const supplied = configured[name] ?? {};
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
      throw new Error(`Invalid role ${name}`);
    const base = defaults[name] ?? {};
    const prompt = supplied.promptFile
      ? await readFile(
          resource(
            text(supplied.promptFile, "prompt path", 4096),
            dirname(path),
          ),
          "utf8",
        )
      : (supplied.prompt ??
        (defaults[name]
          ? await readFile(
              join(resourceDirectory, "..", "roles", `${name}.md`),
              "utf8",
            )
          : undefined));
    const role = {
      description: name,
      model: null,
      thinking: "medium",
      tools: readonly,
      skills: [],
      extensions: [],
      writable: false,
      requestBudget: 200,
      maxRuntimeMs: 0,
      maxConcurrency: raw.maxConcurrency ?? 32,
      ...base,
      ...supplied,
      prompt,
    } as Role;
    text(role.description, "role description", 4096);
    text(role.prompt, "role prompt", 65536);
    if (
      role.model !== null &&
      !text(role.model, "role model", 256).includes("/")
    )
      throw new Error("Role model must be an exact provider/model identity");
    if (!thinking.has(role.thinking) || typeof role.writable !== "boolean")
      throw new Error(`Invalid settings for role ${name}`);
    role.tools = names(role.tools, "tools");
    role.skills = names(role.skills, "skills").map((p) =>
      resource(p, dirname(path)),
    );
    role.extensions = names(role.extensions, "extensions").map((p) =>
      p.startsWith("builtin:") ? p : resource(p, dirname(path)),
    );
    role.requestBudget = integer(
      role.requestBudget,
      "requestBudget",
      0,
      100000,
    );
    role.maxRuntimeMs = integer(
      role.maxRuntimeMs,
      "maxRuntimeMs",
      0,
      604800000,
    );
    role.maxConcurrency = integer(
      role.maxConcurrency,
      "maxConcurrency",
      0,
      256,
    );
    roles[name] = role;
  }
  return {
    version: 1,
    roles,
    maxConcurrency: integer(raw.maxConcurrency ?? 32, "maxConcurrency", 0, 256),
    maxDepth: integer(raw.maxDepth ?? 2, "maxDepth", 0, 8),
    idleTtlMs: integer(raw.idleTtlMs ?? 420000, "idleTtlMs", 0, 604800000),
    maxAgents: integer(raw.maxAgents ?? 256, "maxAgents", 1, 4096),
    snapshotBytes: integer(
      raw.snapshotBytes ?? 16777216,
      "snapshotBytes",
      1024,
      1073741824,
    ),
  };
}
export function resolveModel(
  input: SpawnInput,
  role: Role,
  available: { provider: string; id: string }[],
): string {
  const exact = input.model ?? role.model;
  if (!exact)
    throw new Error(
      "Role model is not configured. Select its Model in /agents Settings or pass an exact model override.",
    );
  if (!available.some((m) => `${m.provider}/${m.id}` === exact))
    throw new Error(
      `Model ${exact} is not available/authenticated in this Pi session; no fallback was selected.`,
    );
  return exact;
}
export function narrow(
  requested: string[] | undefined,
  maximum: string[],
  label: string,
): string[] {
  const selected = requested ?? maximum;
  names(selected, label);
  if (selected.some((v) => !maximum.includes(v)))
    throw new Error(`${label} exceeds the configured role maximum`);
  return [...selected];
}
