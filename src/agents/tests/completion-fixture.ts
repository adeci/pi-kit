// Offline completion delivery and rendering fixture; isolated profiles only.
import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
const text = (message: any) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n");
export default function fixture(pi: any) {
  const child = process.argv.includes("--pi-agents-child");
  const trace = (value: any) => {
    if (!child)
      appendFileSync(
        process.env.PI_COMPLETION_TRACE!,
        JSON.stringify(value) + "\n",
      );
  };
  pi.on("message_end", (event: any) => {
    if (event.message.role === "custom")
      trace({ type: "custom", customType: event.message.customType });
  });
  pi.on("session_start", () => trace({ type: "start" }));
  pi.on("agent_settled", () => trace({ type: "settled" }));
  pi.registerCommand("fixture-job", {
    description: "Test-only retained job message",
    handler: () => {
      const handle = `12:${"a".repeat(32)}`;
      const payload = {
        handle,
        name: "render-job",
        state: "failed",
        exit_code: 1,
        elapsed_seconds: 44,
        text: `job=${handle} (render-job) failed exit=1 elapsed=44s\n   Compiling JOB_EXPAND_ONLY_DETAIL v0.1.0\n${"build output ".repeat(50)}\nerror: JOB_PREVIEW_ERROR\nFull output: pi-jobs log ${handle}`,
      };
      pi.sendMessage(
        {
          customType: "pi-events",
          display: true,
          content: `[external event: job.completed; source: pi-jobs]\n${payload.text}`,
          details: { topic: "job.completed", source: "pi-jobs", payload },
        },
        { triggerTurn: false },
      );
    },
  });
  pi.registerProvider("pi-agents-fixture", {
    api: "pi-completion-fixture",
    baseUrl: "https://fixture.invalid",
    apiKey: "offline-fixture",
    models: [
      {
        id: "scripted",
        name: "Completion fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 4096,
      },
    ],
    streamSimple: (model: any, context: any) => {
      const stream = new AssistantMessageEventStream();
      let name: string | undefined, args: any;
      let response = "PRIMARY_DONE";
      const messages = context.messages;
      const prompt = [...messages]
        .reverse()
        .find(
          (m: any) => m.role === "user" && text(m).startsWith("COMPLETION "),
        );
      const mode = text(prompt).slice(11).trim();
      const results = messages.filter((m: any) => m.role === "toolResult");
      const spawns = results
        .filter((m: any) => m.toolName === "agent_spawn")
        .map((m: any) => JSON.parse(text(m)));
      if (child) {
        name = "agent_yield";
        args = {
          outcome: "completed",
          summary: "Fixture completion",
          artifacts: [],
          validation: ["EXPAND_ONLY_REPORT_DETAIL"],
          unresolved: [],
        };
      } else if (mode === "job") {
        if (!results.length) {
          name = "bash";
          args = { command: process.env.PI_COMPLETION_JOB_COMMAND };
        } else if (text(messages.at(-1)).includes("external event"))
          response = "FOLLOW_UP_DONE";
      } else if (spawns.length < (["two", "mixed"].includes(mode) ? 2 : 1)) {
        name = "agent_spawn";
        args = {
          role: "scout",
          name: `completion-worker-${spawns.length}`,
          task: "Return a fixture report",
          lifetime: "task",
          tools: ["read"],
        };
      } else if (!results.some((m: any) => m.toolName === "agent_wait")) {
        name = "agent_wait";
        args = { ids: spawns.map((s: any) => s.id), timeoutSeconds: 30 };
      } else if (
        ["read", "mixed"].includes(mode) &&
        !results.some((m: any) => m.toolName === "agent_status")
      ) {
        name = "agent_status";
        args = { id: spawns[0].id, view: "result" };
      } else if (text(messages.at(-1)).includes("Agent message/result"))
        response = "FOLLOW_UP_DONE";
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: name
          ? [
              {
                type: "toolCall",
                id: `fixture-${messages.length}`,
                name,
                arguments: args,
              },
            ]
          : [{ type: "text", text: response }],
        stopReason: name ? "toolUse" : "stop",
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
