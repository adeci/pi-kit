// Offline scripted provider; no authenticated model requests.
import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
const log = (value: unknown) =>
  appendFileSync(process.env.PI_ASK_TRACE!, JSON.stringify(value) + "\n");
export default function fixture(pi: any) {
  let step = 0;
  pi.events.on("pi-kit:agents:query", (reply: any) =>
    reply({ ready: true, active: 0, roles: ["sonic", "task"] }),
  );
  pi.on("session_start", (_event: any, ctx: any) =>
    log({ event: "start", theme: ctx.ui.theme.name }),
  );
  pi.on("ui_prompt_end", () => log({ event: "ui_end" }));
  pi.on("tool_result", (event: any) =>
    log({
      event: "result",
      name: event.toolName,
      details: event.details,
      error: event.isError,
    }),
  );
  pi.on("agent_settled", () => log({ event: "settled" }));
  pi.registerCommand("ask-reload", {
    description: "Fixture only",
    handler: async (_args: string, ctx: any) => {
      await ctx.reload();
    },
  });
  pi.registerCommand("ask-audit", {
    description: "Fixture only",
    handler: (_args: string, ctx: any) =>
      log({
        event: "audit",
        tools: pi.getActiveTools(),
        entries: ctx.sessionManager.getBranch(),
      }),
  });
  pi.registerProvider("ask-fixture", {
    api: "ask-fixture",
    apiKey: "offline",
    baseUrl: "https://fixture.invalid",
    models: [
      {
        id: "scripted",
        name: "Ask fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model: any) {
      const stream = new AssistantMessageEventStream();
      const index = step++;
      log({ event: "request", index });
      const questions = [
        {
          id: "scope",
          question: "Which scope should we use?",
          recommended: "small",
          options: [
            {
              id: "small",
              label: "Small change",
              description: "Keep this focused",
            },
            { id: "large", label: "Large change" },
          ],
        },
        {
          id: "checks",
          question: "Which checks should run?",
          multi: true,
          options: [
            { id: "unit", label: "Unit tests" },
            { id: "integration", label: "Integration tests" },
          ],
        },
        { id: "notes", question: "Any additional constraints?" },
      ];
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: index === 0 ? "toolUse" : "stop",
        content:
          index === 0
            ? [
                {
                  type: "toolCall",
                  id: "ask-fixture-call",
                  name: "ask",
                  arguments: { questions },
                },
              ]
            : [{ type: "text", text: "ASK_COMPLETE" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
