import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { accountId, UsageService, type Auth } from "./service";
import type { Card, Provider } from "./state";
import { usageFrame } from "./view";

const providers: Provider[] = ["openai-codex", "anthropic"];

export async function credentials(
  ctx: ExtensionContext,
  provider: Provider,
): Promise<Auth> {
  const model = ctx.modelRegistry.getAll().find((m) => m.provider === provider);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model))
    return { notice: "Not logged in. Use /login.", hidden: true };
  if (!ctx.modelRegistry.isUsingOAuth(model))
    return {
      notice:
        "Subscription usage requires an OAuth login; API-key billing is separate.",
      hidden: true,
    };
  const origin =
    provider === "anthropic"
      ? "https://api.anthropic.com"
      : "https://chatgpt.com";
  const trusted = (url: string | undefined) =>
    !url || new URL(url).origin === origin;
  try {
    if (!trusted(model.baseUrl))
      return {
        notice: "Custom endpoints are not queried for subscription usage.",
      };
    const resolved = await ctx.modelRegistry.getProviderAuth(provider);
    if (!resolved || !trusted(resolved.auth.baseUrl))
      return {
        notice: "Subscription authentication unavailable. Check /login.",
      };
    const token = resolved.auth.apiKey;
    if (!token)
      return {
        notice: "Subscription authentication unavailable. Check /login.",
      };
    return {
      token,
      ...(provider === "openai-codex" ? { accountId: accountId(token) } : {}),
    };
  } catch {
    return { notice: "Subscription authentication unavailable. Check /login." };
  }
}

export default function usage(pi: ExtensionAPI) {
  const service = new UsageService();
  let active: AbortController | undefined;
  pi.on("session_shutdown", () => {
    active?.abort();
    active = undefined;
    service.clear();
  });
  pi.registerCommand("usage", {
    description: "Show OpenAI and Anthropic subscription quotas together",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/usage requires interactive Pi.", "warning");
        return;
      }
      if (active) return;
      const controller = new AbortController();
      active = controller;
      try {
        await ctx.ui.custom<void>(
          (tui, _theme, _keys, done) => {
            let cards: Card[] = [];
            let feedback = "",
              feedbackUntil = 0;
            let loading = false,
              closed = false,
              offset = 0,
              capacity = 1,
              length = 1;
            const timer = setInterval(() => {
              if (!closed) tui.requestRender();
            }, 1000);
            timer.unref();
            const stop = () => {
              closed = true;
              clearInterval(timer);
            };
            controller.signal.addEventListener("abort", stop, { once: true });
            const load = async (manual = false) => {
              if (loading || closed) return;
              loading = true;
              tui.requestRender();
              const results = await Promise.all(
                providers.map((provider) =>
                  service.get(
                    provider,
                    (p) => credentials(ctx, p),
                    controller.signal,
                  ),
                ),
              );
              if (closed || controller.signal.aborted) return;
              cards = results.filter((card) => !card.hidden);
              if (manual) {
                feedback = cards.some((card) => card.cached)
                  ? "Using cached results"
                  : "Refresh complete";
                feedbackUntil = Date.now() + 4000;
              }
              loading = false;
              tui.requestRender();
            };
            void load();
            return {
              dispose() {
                stop();
                controller.signal.removeEventListener("abort", stop);
                controller.abort();
              },
              invalidate() {},
              render(width: number) {
                const now = Date.now();
                const frame = usageFrame(
                  ctx.ui.theme,
                  width,
                  tui.terminal.rows,
                  cards,
                  loading,
                  offset,
                  now,
                  now < feedbackUntil ? feedback : undefined,
                );
                capacity = frame.capacity;
                length = frame.length;
                offset = frame.offset;
                return frame.lines;
              },
              handleInput(data: string) {
                if (matchesKey(data, "escape")) {
                  closed = true;
                  controller.abort();
                  done();
                  return;
                }
                if (data === "r") void load(true);
                else if (matchesKey(data, "up"))
                  offset = Math.max(0, offset - 1);
                else if (matchesKey(data, "down"))
                  offset = Math.min(Math.max(0, length - capacity), offset + 1);
                else if (matchesKey(data, "pageUp"))
                  offset = Math.max(0, offset - capacity);
                else if (matchesKey(data, "pageDown"))
                  offset = Math.min(
                    Math.max(0, length - capacity),
                    offset + capacity,
                  );
                tui.requestRender();
              },
            };
          },
          {
            overlay: true,
            overlayOptions: { width: "90%", anchor: "center", margin: 1 },
          },
        );
      } finally {
        controller.abort();
        if (active === controller) active = undefined;
      }
    },
  });
}
