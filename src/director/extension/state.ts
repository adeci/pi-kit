export interface DirectorState {
  enabled: boolean;
  fast: string;
  strong: string;
}
export const entryType = "pi-kit:director:v1";
export const defaults: DirectorState = {
  enabled: false,
  fast: "sonic",
  strong: "task",
};
export const allowedTools = new Set([
  "read",
  "todo",
  "goal",
  "ask",
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
]);
export function validState(value: unknown): value is DirectorState {
  const state = value as DirectorState | undefined;
  return Boolean(
    state &&
    typeof state.enabled === "boolean" &&
    [state.fast, state.strong].every(
      (role) => typeof role === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(role),
    ),
  );
}
export function blockTool(name: string, input: any): string | undefined {
  if (!allowedTools.has(name))
    return "Director mode: delegate execution to an agent. The parent may read, ask the user, manage the goal/todos, direct agents and integrate reviewed worker changes only.";
  if (name === "agent_spawn" && (input.lifetime !== "reusable" || !input.role))
    return "Director workers must have lifetime=reusable and an explicit role. Discover roles with agent_roles, then reuse the same worker for follow-ups.";
  return undefined;
}

// Adapted from OMP 18.4.10 vibe-mode-active.md; see ../OMP-LICENSE.
export function activePrompt(state: DirectorState) {
  return `<director-mode>
Director mode ON. Drive existing pi-kit agents. NEVER edit, run commands, grep or build yourself. Verify work by reading files and authoritative worker artifacts.

Workers:
- Fast role ${JSON.stringify(state.fast)}: low-latency, mechanical, well-specified work; renames, small fixes, boilerplate, data collection, tests and output reports.
- Strong role ${JSON.stringify(state.strong)}: design, tricky debugging, multi-file refactors and judgment-heavy work.
Use agent_roles to inspect actual model routing. Role model settings live in /agents; do not inspect credentials or invent model names.

Persistent workstreams:
1. Split work into independent assignments with complete self-contained briefs: files, constraints, acceptance criteria, verification and expected output. Workers do not inherit this conversation.
2. agent_spawn with lifetime=reusable and an explicit role. Spawn once per workstream; agent_assign or agent_send follow-ups to the SAME worker. Do not respawn a worker merely to send another instruction.
3. Work concurrently when assignments are independent. Results arrive through existing agent delivery. agent_wait only when unable to proceed without a result; cancellation stops the wait, not the worker.
4. Inspect agent_status result/diff and read touched files or saved evidence. A worker's completed report is not proof. Direct corrections or independent review before acceptance.
5. Delegate verification commands. Match evidence to every claimed result. Manage parent todos only after reviewing results.
6. Preserve agents' isolation defaults. The sole local-write exception is agent_integrate: apply a reviewed, settled worker diff through the existing conflict-safe integration tool. Never commit or discard user changes implicitly.
7. agent_stop stuck or finished workstreams explicitly. agent_list recovers the roster. Never silently restart interrupted workers.

Final outcome remains your responsibility. Goal mode, if active, controls pursuit and completion; director mode controls who executes.
</director-mode>`;
}
