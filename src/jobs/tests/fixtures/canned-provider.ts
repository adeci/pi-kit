// Offline test fixture only. Never install this provider into a real profile.
import { writeFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi: any) {
  pi.registerProvider("pi-jobs-fixture", {
    api: "pi-jobs-fixture",
    baseUrl: "https://pi-jobs-fixture.invalid",
    apiKey: "fixture",
    models: [
      {
        id: "canned",
        name: "Offline test response",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 1000,
      },
    ],
    streamSimple: (model: any) => {
      const stream = new AssistantMessageEventStream();
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        message.content.push({
          type: "text",
          text: "fixture acknowledged completion",
        });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: message.content[0].text,
          partial: message,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: message.content[0].text,
          partial: message,
        });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("session_start", (_event: any, ctx: any) => {
    writeFileSync(
      process.env.PI_JOBS_FIXTURE_READY!,
      JSON.stringify({
        owner: ctx.sessionManager.getSessionId(),
        subscription: process.env.PI_EVENTS_SUBSCRIPTION,
        eventsSession: process.env.PI_EVENTS_SESSION,
        session: ctx.sessionManager.getSessionFile(),
      }),
      { mode: 0o600 },
    );
  });
}
