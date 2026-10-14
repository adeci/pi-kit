// Isolated offline UI fixture. Never load in a real profile.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerTools } from "../../agents/extension/tools";
import { agentWidgetLines } from "../../agents/extension/widget";
import { widgetStyle } from "../../ui/style";
const trace = (value: unknown) =>
  appendFileSync(process.env.PI_UI_TRACE!, JSON.stringify(value) + "\n");
const agent = {
  id: "29844f553aa83c01",
  depth: 1,
  name: "memory-research",
  role: "reviewer",
  state: "running",
  model: "openai-codex/gpt-6-astra",
  thinking: "high",
  requests: 15,
  cost: 1.067,
  activity: "thinking",
};
export default function fixture(pi: any) {
  let step = 0;
  registerTools(
    pi,
    async (operation) => {
      if (operation !== "wait") throw new Error("fixture only supports wait");
      return {
        outcome: "elapsed",
        agents: [agent],
        evidence: "EXPANDED_EVIDENCE_" + "x".repeat(4000),
      };
    },
    () => [agent],
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const address = String(url);
    if (!address.includes("/usage"))
      throw new Error("Unexpected network request in offline fixture");
    trace({
      event: "quota",
      provider: address.includes("anthropic") ? "anthropic" : "openai-codex",
    });
    if (process.env.PI_UI_DELAY)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10000);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            trace({ event: "quota_aborted" });
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    return Response.json(
      address.includes("anthropic")
        ? {
            five_hour: {
              utilization: 35,
              resets_at: new Date(Date.now() + 3600000).toISOString(),
            },
            seven_day: { utilization: 72 },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 80,
                scope: { model: { display_name: "Opus" } },
              },
            ],
          }
        : {
            plan_type: "plus",
            credits: { balance: "61283.9178000000" },
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18000,
                reset_after_seconds: 3600,
              },
              secondary_window: {
                used_percent: 50,
                limit_window_seconds: 604800,
              },
            },
          },
    );
  }) as typeof fetch;
  pi.on("session_shutdown", () => {
    globalThis.fetch = originalFetch;
  });
  pi.on("session_start", (_event: any, ctx: any) => {
    const registry = ctx.modelRegistry;
    const originalAll = registry.getAll.bind(registry);
    registry.getAll = () => [
      ...originalAll(),
      ...["openai-codex", "anthropic"].map((provider) => ({
        provider,
        id: "fixture",
        baseUrl:
          provider === "anthropic"
            ? "https://api.anthropic.com"
            : "https://chatgpt.com",
      })),
    ];
    registry.hasConfiguredAuth = (model: any) =>
      model.provider === "ui-fixture" ||
      (process.env.PI_UI_AUTH !== "none" &&
        !(
          process.env.PI_UI_AUTH === "codex" && model.provider === "anthropic"
        ));
    registry.isUsingOAuth = () => true;
    registry.getProviderAuth = async () => ({
      auth: { apiKey: "fixture-not-a-real-credential" },
    });
    const custom = ctx.ui.custom.bind(ctx.ui);
    ctx.ui.custom = (factory: any, options: any) =>
      custom((tui: any, ...args: any[]) => {
        const component = factory(tui, ...args);
        const render = component.render.bind(component);
        component.render = (width: number) => {
          const lines = render(width);
          queueMicrotask(() =>
            trace({
              event: "frame",
              width,
              rows: tui.terminal.rows,
              columns: tui.terminal.columns,
              lines: lines.map((line: string) =>
                line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
              ),
              layout: tui.renderedOverlayLayouts?.map(
                ({ row, col, width, height }: any) => ({
                  row,
                  col,
                  width,
                  height,
                }),
              ),
            }),
          );
          return lines;
        };
        return component;
      }, options);
    ctx.ui.setStatus("fixture", "Other extension status");
    ctx.ui.setWidget("fixture-agent", (tui: any, theme: any) => ({
      render: (width: number) =>
        agentWidgetLines([agent], width, tui.terminal.rows, widgetStyle(theme)),
      invalidate() {},
    }));
    trace({ event: "start", theme: ctx.ui.theme.name });
  });
  pi.on("ui_prompt_end", () => trace({ event: "ui_end" }));
  pi.on("agent_settled", () => trace({ event: "settled" }));
  pi.on("tool_result", (event: any) =>
    trace({ event: "result", name: event.toolName }),
  );
  pi.registerCommand("fixture-theme", {
    description: "Test only",
    handler: (_args: string, ctx: any) => {
      ctx.ui.setTheme("light");
      trace({ event: "theme" });
    },
  });
  pi.registerProvider("ui-fixture", {
    api: "ui-fixture",
    apiKey: "offline",
    baseUrl: "https://fixture.invalid",
    models: [
      {
        id: "scripted",
        name: "UI fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 200000,
        maxTokens: 4096,
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      },
    ],
    streamSimple(model: any, context: any) {
      if (JSON.stringify(context.messages).includes("NAMED_EVENT_DELIVERY"))
        trace({ event: "named_input" });
      const stream = createAssistantMessageEventStream();
      const index = step++;
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
                  id: "named-wait",
                  name: "agent_wait",
                  arguments: { ids: [agent.id], timeoutSeconds: 60 },
                },
              ]
            : [{ type: "text", text: "STATUS_USAGE_COMPLETE" }],
        usage: {
          input: 1000,
          output: 100,
          cacheRead: 2000,
          cacheWrite: 50,
          totalTokens: 3150,
          cost: {
            input: 0.1,
            output: 0.1,
            cacheRead: 0.1,
            cacheWrite: 0.1,
            total: 0.4,
          },
        },
      };
      setTimeout(
        () => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
        },
        process.env.PI_UI_SLOW ? 1200 : 0,
      );
      return stream;
    },
  });
}
