// Offline fixture; never load into a real profile.
import { appendFileSync, readFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
const log = (value: unknown) =>
  appendFileSync(process.env.PI_HANDOFF_TRACE!, JSON.stringify(value) + "\n");
const text = (message: any) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n");
export default function (pi: any) {
  pi.registerTool({
    name: "fixture_step",
    label: "Fixture step",
    description: "Offline fixture step",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        { type: "text", text: "TOOL_EVIDENCE " + "recent result ".repeat(60) },
      ],
      details: undefined,
    }),
  });
  pi.registerProvider("handoff-fixture", {
    api: "handoff-fixture",
    baseUrl: "https://fixture.invalid",
    apiKey: "offline",
    models: ["working", "summary"].map((id) => ({
      id,
      name: `Offline ${id}`,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    })),
    streamSimple(model: any, context: any, options: any) {
      const stream = new AssistantMessageEventStream();
      const last = context.messages.at(-1);
      const handoff = text(last).startsWith("Write a continuity handoff");
      const step =
        !handoff && last.role === "user" && text(last).startsWith("RUN");
      const mode = readFileSync(process.env.PI_HANDOFF_MODE!, "utf8").trim();
      log({ event: "request", handoff, model: model.id, context });
      const finish = (aborted = false) => {
        const response = handoff
          ? mode === "empty"
            ? ""
            : [
                "Goal",
                "Constraints & Preferences",
                "Progress",
                "Key Decisions",
                "Critical Context",
                "Next Steps",
              ]
                .map((title) => `## ${title}\nHANDOFF_EVIDENCE`)
                .join("\n")
          : last.role === "toolResult"
            ? "CONTINUED_AFTER_TOOL"
            : "FIXTURE_ACK";
        const reason = aborted
          ? "aborted"
          : mode === "error" && handoff
            ? "error"
            : step
              ? "toolUse"
              : "stop";
        const input = handoff
          ? 5
          : step
            ? 160000
            : text(last) === "BELOW"
              ? 140000
              : 100;
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          content: step
            ? [
                {
                  type: "toolCall",
                  id: `step-${Date.now()}`,
                  name: "fixture_step",
                  arguments: {},
                },
              ]
            : [{ type: "text", text: response }],
          stopReason: reason,
          usage: {
            input,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: input + 5,
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
        if (reason === "error" || reason === "aborted")
          stream.push({ type: "error", reason, error: message });
        else stream.push({ type: "done", reason, message });
        stream.end();
      };
      if (handoff && mode === "wait") {
        if (options.signal.aborted) queueMicrotask(() => finish(true));
        else
          options.signal.addEventListener("abort", () => finish(true), {
            once: true,
          });
      } else queueMicrotask(() => finish());
      return stream;
    },
  });
  pi.on("session_start", (_event: any, ctx: any) =>
    log({
      event: "start",
      file: ctx.sessionManager.getSessionFile(),
      commands: pi.getCommands().map((command: any) => command.name),
    }),
  );
  pi.on("turn_end", (event: any, ctx: any) =>
    log({
      event: "boundary",
      signal: Boolean(ctx.signal),
      usage: ctx.getContextUsage(),
      outcome: event.outcome,
      drafts: event.entries.length,
    }),
  );
  pi.on("agent_settled", () => log({ event: "settled" }));
  pi.on("ui_prompt_end", () => log({ event: "ui_end" }));
  pi.on("session_compact", () => log({ event: "compact" }));
  pi.on("session_compact_failed", () => log({ event: "failed" }));
  pi.registerCommand("handoff-audit", {
    description: "Fixture only",
    handler: async (_args: string, ctx: any) =>
      log({
        event: "context",
        context: buildSessionContext(ctx.sessionManager.getBranch()),
        entries: ctx.sessionManager.getBranch(),
      }),
  });
}
