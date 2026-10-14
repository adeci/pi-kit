import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import {
  agentLabel,
  callTargets,
  resultAgents,
  rememberAgents,
  type AgentLabel,
} from "./tool-labels";
import { clean } from "./types";

const id = Type.String({ minLength: 1, maxLength: 128 });
const task = Type.String({ minLength: 1, maxLength: 65536 });
const context = Type.Optional(Type.String({ maxLength: 65536 }));
export const spawnSchema = Type.Object({
  task,
  context,
  role: Type.Optional(Type.String({ maxLength: 64 })),
  name: Type.Optional(Type.String({ maxLength: 128 })),
  lifetime: Type.Optional(
    Type.Union([Type.Literal("task"), Type.Literal("reusable")]),
  ),
  cwd: Type.Optional(Type.String({ maxLength: 4096 })),
  model: Type.Optional(Type.String({ maxLength: 256 })),
  thinking: Type.Optional(Type.String({ maxLength: 16 })),
  tools: Type.Optional(
    Type.Array(Type.String(), { maxItems: 64, uniqueItems: true }),
  ),
  skills: Type.Optional(
    Type.Array(Type.String(), { maxItems: 64, uniqueItems: true }),
  ),
  isolated: Type.Optional(Type.Boolean()),
});
export const reportSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal("completed"),
    Type.Literal("blocked"),
    Type.Literal("failed"),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 32768 }),
  artifacts: Type.Array(Type.String(), { maxItems: 64 }),
  validation: Type.Array(Type.String(), { maxItems: 64 }),
  unresolved: Type.Array(Type.String(), { maxItems: 64 }),
  data: Type.Optional(Type.Unknown()),
});
export type Dispatch = (
  operation: string,
  args: any,
  signal?: AbortSignal,
) => Promise<any>;
export const controlTools = [
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
];
export function registerTools(
  pi: ExtensionAPI,
  dispatch: Dispatch,
  agents: () => AgentLabel[] = () => [],
) {
  const definitions = [
    [
      "agent_roles",
      "Discover configured agent roles, exact model routing, capabilities and execution limits. Use this tool rather than reading user configuration or inspecting provider credentials. Built-in roles: scout (investigation), task (implementation), reviewer (independent review), sonic (mechanical work). Models have no silent fallback.",
      Type.Object({}),
    ],
    [
      "agent_spawn",
      "Delegate independent work to a configured role: scout for investigation, task for implementation, reviewer for independent review, sonic for mechanical work. Discover routing with agent_roles, not shell commands. Supply task, relevant context, cwd, constraints and expected output explicitly; children do not inherit your conversation. Start independent assignments concurrently, then continue useful work. Returns a handle immediately; unread results notify the parent after the report and descendants settle. In the main session, reading the same completed report with agent_status suppresses its pending notification. Inspect results with agent_status; completed does not mean correct. Default lifetime is task; reusable keeps its own history/workspace. Writers use isolated workspaces unless explicitly overridden. Parent shutdown stops model execution; durable command jobs are separate.",
      spawnSchema,
    ],
    [
      "agent_assign",
      "Give an idle or parked reusable agent a new assignment, retaining its own conversation and workspace. Starts a new per-assignment budget.",
      Type.Object({
        id,
        task,
        context,
        model: spawnSchema.properties.model,
        thinking: spawnSchema.properties.thinking,
      }),
    ],
    [
      "agent_resume",
      "Explicitly resume a parked/interrupted agent. Optional task replaces the prior objective. Never runs automatically after reopening Pi.",
      Type.Object({
        id,
        task: Type.Optional(task),
        context,
        model: spawnSchema.properties.model,
        thinking: spawnSchema.properties.thinking,
      }),
    ],
    [
      "agent_send",
      "Send addressed guidance to a running agent or a question/reply to your parent. Sending to idle/parked children starts a new assignment. Acknowledgment is receipt, not completion. Siblings communicate through their parent.",
      Type.Object({ id, message: task }),
    ],
    [
      "agent_list",
      "List the accessible delegation tree with current assignment state, actual model, activity and usage.",
      Type.Object({ includeCompleted: Type.Optional(Type.Boolean()) }),
    ],
    [
      "agent_status",
      "Inspect authoritative state or a bounded result, conversation, diff or effective prompt. Full artifact paths are retained. Settlement does not prove correctness.",
      Type.Object({
        id,
        view: Type.Optional(
          Type.Union([
            Type.Literal("status"),
            Type.Literal("result"),
            Type.Literal("conversation"),
            Type.Literal("diff"),
            Type.Literal("prompt"),
          ]),
        ),
      }),
    ],
    [
      "agent_wait",
      "Wait for a fixed snapshot of selected direct children (or all unsettled direct children). Finite timeout/cancellation stops only the wait. Unread completion also arrives automatically; a wait alone does not acknowledge the report.",
      Type.Object({
        ids: Type.Optional(
          Type.Array(id, { minItems: 1, maxItems: 256, uniqueItems: true }),
        ),
        timeoutSeconds: Type.Number({ minimum: 1, maximum: 3600 }),
      }),
    ],
    [
      "agent_stop",
      "Explicitly stop an agent and, by default, its whole delegation branch. Written conversation, results and diffs remain. Stopped agents are not silently restarted.",
      Type.Object({ id, branch: Type.Optional(Type.Boolean()) }),
    ],
    [
      "agent_forget",
      "Explicitly delete a settled leaf agent's retained conversation, artifacts and isolated workspace. Forget descendants first. Never automatic cleanup.",
      Type.Object({ id }),
    ],
    [
      "agent_integrate",
      "Apply a settled isolated assignment's diff to its caller workspace without committing or changing the index. Conflicts fail without partial application. Inspect the diff and validation first; parent agents may integrate autonomously.",
      Type.Object({ id, assignment: Type.Optional(id) }),
    ],
  ] as const;
  for (const [name, description, parameters] of definitions) {
    pi.registerTool({
      name,
      label: name.replace("agent_", "Agent "),
      description,
      parameters,
      renderCall(args, theme, context) {
        const saved: AgentLabel[] = context.state?.agents ?? [];
        const targets = callTargets(args as { id?: string; ids?: string[] }, [
          ...saved,
          ...agents(),
        ]);
        const values = args as Record<string, unknown>;
        const title =
          name === "agent_wait"
            ? "Wait for subagents"
            : name.replace("agent_", "Agent ");
        const brief = targets.length
          ? targets.slice(0, 3).join(", ") +
            (targets.length > 3 ? ` +${targets.length - 3} more` : "")
          : name === "agent_wait"
            ? "active children"
            : typeof values.name === "string"
              ? clean(values.name)
              : typeof values.role === "string"
                ? clean(values.role)
                : "";
        const timeout =
          name === "agent_wait" && typeof values.timeoutSeconds === "number"
            ? ` · up to ${values.timeoutSeconds}s`
            : "";
        return new Text(
          theme.fg("toolTitle", theme.bold(title)) +
            (brief
              ? " · " + theme.fg("accent", brief.replace(/[\r\n\t]/g, " "))
              : "") +
            theme.fg("muted", timeout),
          0,
          0,
        );
      },
      renderResult(result, options, theme, context) {
        const labels = resultAgents(result.details);
        // A synchronous invalidate re-enters Pi's updateDisplay and duplicates
        // the result component. Refresh the call label after this render finishes.
        if (rememberAgents(context.state, labels))
          queueMicrotask(context.invalidate);
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (options.expanded)
          return new Text(theme.fg("toolOutput", text), 0, 0);
        const details = result.details as Record<string, unknown> | undefined;
        const outcome =
          typeof details?.outcome === "string"
            ? details.outcome
            : context.isError
              ? "failed"
              : "returned";
        const rows = labels
          .slice(0, 3)
          .map(
            (agent) =>
              `${agentLabel(agent)}${agent.state ? ` · ${agent.state}` : ""}`,
          );
        if (labels.length > 3)
          rows.push(`… ${labels.length - 3} more subagents`);
        if (!rows.length)
          rows.push(
            clean(text)
              .replace(/[\r\n\t]+/g, " ")
              .slice(0, 200),
          );
        const color = context.isError
          ? "error"
          : outcome === "elapsed"
            ? "warning"
            : "muted";
        return new Text(
          theme.fg(
            color,
            `${name === "agent_wait" ? (outcome === "elapsed" ? "Wait interval elapsed" : outcome === "settled" ? "Wait finished" : `Wait ${outcome}`) : "Result"}${options.isPartial ? " · running" : ""}`,
          ) +
            "\n" +
            rows.map((row) => theme.fg("toolOutput", row)).join("\n") +
            theme.fg("dim", "\nCtrl+O expands details"),
          0,
          0,
        );
      },
      async execute(_toolCallId, args, signal) {
        const details = await dispatch(name.slice(6), args, signal);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(details, null, 2).slice(0, 65536),
            },
          ],
          details,
        };
      },
    });
  }
}
