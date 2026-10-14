import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { request } from "./control";
import { registerTools, controlTools, reportSchema } from "./tools";
import { report, type ChildConfig } from "./types";

export default function child(pi: ExtensionAPI) {
  pi.registerFlag("pi-agents-child", {
    type: "string",
    description: "Private supervised agent configuration",
  });
  let config: ChildConfig;
  let requests = 0,
    reminders = 0,
    submitted = false,
    forced = false;
  const load = async () => {
    const path = pi.getFlag("pi-agents-child");
    if (typeof path !== "string")
      throw new Error("Missing child configuration");
    const bytes = await readFile(path);
    if (bytes.length > 262144) throw new Error("Child configuration too large");
    const value = JSON.parse(bytes.toString("utf8"));
    if (
      value.version !== 1 ||
      !value.id ||
      !value.token ||
      !value.socket ||
      !Array.isArray(value.tools)
    )
      throw new Error("Invalid child configuration");
    config = value;
    process.env.PI_EVENTS_SESSION = config.rootSession;
    // Child job ownership is separate from its parent's jobs. Jobs may be durable;
    // model execution itself never is.
    process.env.PI_JOBS_SESSION = `${config.rootSession}:${config.id}`;
  };
  const dispatch = async (
    operation: string,
    args: any,
    signal?: AbortSignal,
  ) => {
    if (!config) throw new Error("Child not initialized");
    return request(
      config,
      operation,
      args,
      signal,
      operation === "wait" ? (args.timeoutSeconds ?? 30) * 1000 + 5000 : 30000,
    );
  };
  registerTools(pi, dispatch);
  pi.registerTool({
    name: "agent_yield",
    label: "Agent result",
    parameters: reportSchema,
    description:
      "Submit your assignment's definitive report. All delegates must have settled first. Preserve actual validation, artifacts and unresolved issues; completed does not mean verified correct. This ends the assignment, not necessarily your reusable agent identity.",
    async execute(_id, args, signal) {
      const validated = report(args);
      const details = await dispatch(
        "yield",
        { report: validated, requests, budget: forced },
        signal,
      );
      submitted = true;
      return {
        content: [
          {
            type: "text",
            text: "Report accepted; assignment will settle after all artifacts are saved.",
          },
        ],
        details,
        terminate: true,
      };
    },
  });
  pi.registerCommand("pi-agents-begin", {
    description: "Supervisor-only assignment boundary",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle())
        throw new Error("Cannot begin another assignment while agent is busy");
      await load();
      requests = 0;
      reminders = 0;
      submitted = false;
      forced = false;
      await dispatch("ready", {
        assignment: config.assignment,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      });
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    await load();
    const loaded = pi
      .getCommands()
      .filter((command) => command.source === "skill");
    const expectedPaths = await Promise.all(
      config.skills.map((path) => realpath(path)),
    );
    const loadedPaths = await Promise.all(
      loaded.map((command) => realpath(command.sourceInfo.path)),
    );
    if (
      loadedPaths.length !== expectedPaths.length ||
      expectedPaths.some((path) => !loadedPaths.includes(path))
    )
      throw new Error("Child loaded skills outside the selected role snapshot");
    const selected = [...config.tools, ...controlTools, "agent_yield"];
    const all = new Set(pi.getAllTools().map((tool) => tool.name));
    const missing = selected.filter((name) => !all.has(name));
    if (missing.length)
      throw new Error(
        `Configured child tools are unavailable: ${missing.join(", ")}`,
      );
    pi.setActiveTools(selected);
    if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== config.model)
      throw new Error("Child model did not resolve exactly");
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (
      !config ||
      !ctx.model ||
      `${ctx.model.provider}/${ctx.model.id}` !== config.model
    )
      throw new Error("Agent model/configuration mismatch; refusing execution");
    const systemPrompt = `${event.systemPrompt}\n\nAgent role:\n${config.prompt}\n\nSupervised execution:\n- Your id is ${config.id}; your parent is ${config.parent}.\n- Work autonomously on the explicit assignment. You do not inherit your parent's conversation.\n- Stay inside this workspace. Capability restrictions and worktrees are not OS sandboxes.\n- Delegate with agent_spawn when useful. Inspect results and integrate accepted changes; do not mistake settlement for success.\n- Address questions to your parent with agent_send. Siblings communicate through their parent.\n- Progress is display-only. Your final report reaches your parent automatically; do not send it a second time.\n- All descendants for this assignment must settle before agent_yield can succeed.\n- Finish with agent_yield, including outcome, summary, artifacts, validation and unresolved issues. Plain assistant text is not a completed report.\n- Parent Pi shutdown stops your execution and preserves resumable state. Never launch an independent model worker.\n- Closing/cancelling a wait does not stop your agents. Stop explicitly with agent_stop.`;
    await writeFile(
      join(config.directory, "effective-prompt.txt"),
      systemPrompt,
      { mode: 0o600 },
    );
    return { systemPrompt };
  });
  pi.on("tool_call", (event) => {
    const allowed =
      config &&
      [...config.tools, ...controlTools, "agent_yield"].includes(
        event.toolName,
      );
    if (
      !allowed ||
      submitted ||
      (forced &&
        event.toolName !== "agent_yield" &&
        event.toolName !== "agent_wait" &&
        event.toolName !== "agent_status" &&
        event.toolName !== "agent_stop")
    )
      return {
        block: true,
        reason: forced
          ? "Request budget reached; settle delegates and submit a partial report with agent_yield."
          : "Tool is outside the role loadout or assignment already yielded.",
      };
  });
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    requests++;
    await dispatch("usage", { requests });
    if (
      config.requestBudget &&
      requests > Math.ceil(config.requestBudget * 1.5) + 5
    )
      ctx.abort();
  });
  pi.on("turn_end", () => {
    if (submitted || !config.requestBudget) return;
    if (requests >= Math.ceil(config.requestBudget * 1.5)) forced = true;
    if (requests === config.requestBudget || forced) {
      return {
        entries: [
          {
            type: "custom_message" as const,
            customType: "pi-agents-budget",
            content: forced
              ? "Request budget stop: no more implementation work. Settle your delegates and yield partial findings now."
              : `You have used ${requests} assistant requests. Wrap up; at ${Math.ceil(config.requestBudget * 1.5)} requests only final reporting is allowed.`,
            display: true,
          },
        ],
        continue: true,
      };
    }
  });
  pi.on("agent_before_settle", (event) => {
    if (
      submitted ||
      event.outcome !== "completed" ||
      ++reminders > 3 ||
      (forced && requests >= Math.ceil(config.requestBudget * 1.5) + 5)
    )
      return;
    return {
      entries: [
        {
          type: "custom_message" as const,
          customType: "pi-agents-yield-required",
          content:
            "Submit your report through agent_yield. If delegates are still running, wait for them and inspect their results first.",
          display: true,
        },
      ],
      continue: true,
    };
  });
}
