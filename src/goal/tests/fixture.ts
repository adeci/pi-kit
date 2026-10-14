// Offline mode-policy fixture. Worker tools below are stubs, not model workers.
import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
const log = (value: unknown) =>
  appendFileSync(process.env.PI_MODES_TRACE!, JSON.stringify(value) + "\n");
export default function (pi: any) {
  let step = 0,
    active = process.env.PI_MODES_SCENARIO?.startsWith("workers") ? 1 : 0;
  pi.events.on("pi-kit:agents:query", (reply: any) =>
    reply({ ready: true, active, roles: ["sonic", "task", "reviewer"] }),
  );
  for (const name of [
    "agent_spawn",
    "agent_assign",
    "agent_roles",
    "agent_status",
    "agent_integrate",
    "agent_wait",
  ])
    pi.registerTool({
      name,
      label: name,
      description: "Offline worker stub",
      parameters: Type.Object({
        role: Type.Optional(Type.String()),
        lifetime: Type.Optional(Type.String()),
        task: Type.Optional(Type.String()),
        id: Type.Optional(Type.String()),
      }),
      execute: async (_id: string, args: any) => {
        log({ event: "worker_tool", name, args });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: "worker-1",
                state: "idle",
                report: "Fixture evidence",
              }),
            },
          ],
          details: undefined,
        };
      },
    });
  pi.registerProvider("modes-fixture", {
    api: "modes-fixture",
    apiKey: "offline",
    baseUrl: "https://fixture.invalid",
    models: [
      {
        id: "scripted",
        name: "Mode fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model: any, context: any, options: any) {
      const stream = new AssistantMessageEventStream();
      const scenario = process.env.PI_MODES_SCENARIO;
      const last = context.messages.at(-1)?.content;
      const lastText =
        typeof last === "string"
          ? last
          : (last ?? [])
              .filter((part: any) => part.type === "text")
              .map((part: any) => part.text)
              .join("\n");
      const handoff = lastText.startsWith("Write a continuity handoff");
      if (handoff) {
        log({ event: "handoff_request" });
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: [
                "Goal",
                "Constraints & Preferences",
                "Progress",
                "Key Decisions",
                "Critical Context",
                "Next Steps",
              ]
                .map((title) => `## ${title}\nHANDOFF_EVIDENCE`)
                .join("\n"),
            },
          ],
          usage: {
            input: 5,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 10,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });
        return stream;
      }
      const index = step++;
      log({ event: "request", index, context });
      let tool: string | undefined,
        args: any = {};
      if (
        ["complete", "workers", "handoff"].includes(scenario!) &&
        index === 1
      ) {
        tool = "goal";
        args = { op: "complete", evidence: ["Fixture verification passed"] };
      }
      if (["director", "combined"].includes(scenario!)) {
        if (index === 0) {
          tool = "write";
          args = { path: "forbidden.txt", content: "must not be written" };
        }
        if (index === 1) {
          tool = "agent_spawn";
          args = {
            task: "Complete workstream",
            role: "sonic",
            lifetime: "reusable",
          };
        }
        if (index === 2) {
          tool = "agent_assign";
          args = {
            id: "worker-1",
            task: "Verify and refine the same workstream",
          };
        }
        if (index === 3 && scenario === "combined") {
          tool = "goal";
          args = {
            op: "complete",
            evidence: ["Reviewed fixture worker evidence"],
          };
        }
      }
      if (scenario === "guided") {
        if (index === 0) {
          tool = "bash";
          args = { command: "touch interview-executed" };
        }
        if (index === 2) {
          tool = "goal";
          args = {
            op: "create",
            objective:
              "Objective: fixture. Success criteria: scripted check. Verification: inspect the test trace. Boundaries: no external work. Stop conditions: one attempt.",
            token_budget: 1000,
          };
        }
        if (index === 3) {
          tool = "goal";
          args = {
            op: "complete",
            evidence: ["Scripted fixture check observed"],
          };
        }
      }
      const finish = (aborted = false) => {
        const input = aborted
          ? scenario === "wait-menu"
            ? 20
            : 0
          : scenario === "handoff" && index === 0
            ? 160000
            : 50;
        const output = aborted ? (scenario === "wait-menu" ? 10 : 0) : 10;
        const cacheRead = aborted ? 0 : 1000;
        const reason = aborted
          ? "aborted"
          : index > 10
            ? "error"
            : tool
              ? "toolUse"
              : "stop";
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: reason,
          content: tool
            ? [
                {
                  type: "toolCall",
                  id: `call-${index}`,
                  name: tool,
                  arguments: args,
                },
              ]
            : [{ type: "text", text: "FIXTURE_RESPONSE" }],
          usage: {
            input,
            output,
            cacheRead,
            cacheWrite: 0,
            totalTokens: input + output + cacheRead,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        stream.push({ type: "start", partial: message });
        if (reason === "aborted" || reason === "error")
          stream.push({ type: "error", reason, error: message });
        else stream.push({ type: "done", reason, message });
        stream.end();
      };
      if (scenario?.startsWith("wait")) {
        if (options.signal.aborted) queueMicrotask(() => finish(true));
        else
          options.signal.addEventListener("abort", () => finish(true), {
            once: true,
          });
      } else queueMicrotask(() => finish());
      return stream;
    },
  });
  pi.on("session_start", (_event: any, ctx: any) => {
    const setStatus = ctx.ui.setStatus.bind(ctx.ui);
    ctx.ui.setStatus = (key: string, value: string | undefined) => {
      log({ event: "status", key, value });
      setStatus(key, value);
    };
    log({ event: "start" });
  });
  pi.on("agent_settled", () => log({ event: "settled" }));
  pi.on("ui_prompt_end", () => log({ event: "ui_end" }));
  pi.registerCommand("mode-audit", {
    description: "Fixture only",
    handler: async (_args: string, ctx: any) =>
      log({
        event: "audit",
        tools: pi.getActiveTools(),
        entries: ctx.sessionManager.getBranch(),
      }),
  });
  pi.registerCommand("release-workers", {
    description: "Fixture only",
    handler: async () => {
      active = 0;
      pi.events.emit("pi-kit:agents:changed", undefined);
      pi.sendMessage(
        {
          customType: "fixture-agent-result",
          content: "Worker finished; inspect its report.",
          display: false,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });
}
