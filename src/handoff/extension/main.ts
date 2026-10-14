import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadSettings, defaults, type Settings } from "./settings";
import { retainedBoundary, summarize } from "./summary";
import { openSettings } from "./ui";

export default function install(pi: ExtensionAPI) {
  let claimed = false;
  pi.events.emit("pi-kit:claim:handoff", () => {
    claimed = true;
  });
  if (claimed) return;
  const unclaim = pi.events.on("pi-kit:claim:handoff", (callback: unknown) => {
    if (typeof callback === "function") callback();
  });
  let settings: Settings = { ...defaults };
  let blocked = false;
  let pending: AbortController | undefined;
  let menuOpen = false;
  let epoch = 0;

  async function generate(
    ctx: ExtensionContext,
    messages: Parameters<typeof summarize>[1],
    signal: AbortSignal,
  ) {
    if (pending || signal.aborted)
      throw new Error("Handoff is busy or cancelled.");
    const controller = new AbortController();
    pending = controller;
    const session = ctx.sessionManager.getSessionId();
    const combined = AbortSignal.any([signal, controller.signal]);
    ctx.ui.setStatus("pi-kit-handoff", "Generating handoff · Esc cancels");
    try {
      const result = await summarize(ctx, messages, settings, combined);
      if (
        combined.aborted ||
        pending !== controller ||
        ctx.sessionManager.getSessionId() !== session
      )
        throw new Error("Stale handoff.");
      return result;
    } finally {
      if (pending === controller) {
        pending = undefined;
        ctx.ui.setStatus("pi-kit-handoff", undefined);
      }
    }
  }
  const failed = (ctx: ExtensionContext, aborted: boolean) => {
    blocked = true;
    ctx.ui.notify(
      aborted
        ? "Handoff cancelled. No handoff was saved."
        : "Handoff failed. No handoff was saved; check the model in /handoff before retrying. Work has been stopped.",
      aborted ? "info" : "error",
    );
  };
  pi.on("session_start", async (_event, ctx) => {
    blocked = false;
    try {
      settings = await loadSettings();
    } catch {
      settings = { ...defaults, enabled: false };
      ctx.ui.notify(
        "Invalid handoff settings. Automatic handoff is disabled; fix the handoff config and reload.",
        "error",
      );
    }
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") blocked = false;
  });
  // A failed native pre-prompt compaction can return before a run exists to
  // abort. Fence the ensuing turn too, rather than sending oversized context.
  pi.on("turn_start", (_event, ctx) => {
    if (settings.enabled && blocked) ctx.abort();
  });
  pi.registerCommand("handoff", {
    description:
      "Automatic handoff settings: enabled, context threshold and summarizer model",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Handoff settings require the terminal UI.", "warning");
        return;
      }
      if (pending || menuOpen) {
        ctx.ui.notify(
          "A handoff or its settings menu is already open.",
          "warning",
        );
        return;
      }
      menuOpen = true;
      try {
        await openSettings(ctx, (value) => {
          settings = value;
          blocked = false;
        });
      } catch {
        ctx.ui.notify(
          "Could not read or save handoff settings. Check the config file and reopen /handoff.",
          "error",
        );
      } finally {
        menuOpen = false;
      }
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    if (
      !settings.enabled ||
      blocked ||
      pending ||
      event.outcome !== "completed" ||
      event.entries.some((entry) => entry.type !== "custom") ||
      !ctx.model ||
      !ctx.signal ||
      ctx.signal.aborted
    )
      return;
    const percent = ctx.getContextUsage()?.percent;
    if (percent == null || percent < settings.threshold) return;
    const compaction = pi.getSettings().compaction;
    const keep =
      compaction?.modelOverrides?.[`${ctx.model.provider}/${ctx.model.id}`]
        ?.keepRecentTokens ??
      compaction?.keepRecentTokens ??
      20000;
    if (!Number.isSafeInteger(keep) || keep < 0) {
      failed(ctx, false);
      ctx.abort();
      return;
    }
    const firstKeptEntryId = retainedBoundary(
      event.context.contextEntries,
      keep,
    );
    if (!firstKeptEntryId) return;
    const generation = epoch;
    try {
      const result = await generate(
        ctx,
        event.context.contextMessages,
        ctx.signal,
      );
      // Pi persists this at its existing turn boundary and resumes its ordinary
      // tool/steering scheduler. Never manufacture a continuation or a new prompt.
      return {
        entries: [{ type: "compaction" as const, firstKeptEntryId, ...result }],
      };
    } catch {
      if (generation !== epoch) return;
      failed(ctx, ctx.signal.aborted);
      ctx.abort();
      return;
    }
  });

  // Also use the chosen summarizer for native threshold/overflow recovery and
  // explicit /compact. Native compaction owns its loader, Escape and retries.
  pi.on("session_before_compact", async (event, ctx) => {
    if (!settings.enabled) return;
    if ((blocked && event.reason !== "manual") || pending)
      return { cancel: true };
    const generation = epoch;
    try {
      const result = await generate(
        ctx,
        buildSessionContext(event.branchEntries).messages,
        event.signal,
      );
      return {
        compaction: {
          ...result,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    } catch {
      if (generation !== epoch) return { cancel: true };
      failed(ctx, event.signal.aborted);
      ctx.abort();
      return { cancel: true };
    }
  });
  pi.on("session_shutdown", (event, ctx) => {
    epoch++;
    pending?.abort();
    pending = undefined;
    ctx.ui.setStatus("pi-kit-handoff", undefined);
    if (event.reason === "quit" || event.reason === "reload") unclaim();
  });
}
