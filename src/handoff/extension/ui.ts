import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { choose } from "../../ui/menu";
import {
  loadSettings,
  saveSettings,
  thresholdInput,
  type Settings,
} from "./settings";

export async function openSettings(
  ctx: ExtensionContext,
  apply: (settings: Settings) => void,
) {
  let settings = await loadSettings();
  apply(settings);
  let current = "enabled";
  for (;;) {
    const field = await choose(
      ctx,
      "Handoff settings",
      [
        {
          value: "enabled",
          label: `Automatic handoff: ${settings.enabled ? "On" : "Off"}`,
          description:
            "Off restores stock Pi compaction. Summaries are lossy; original history remains stored.",
        },
        {
          value: "threshold",
          label: `Context threshold: ${settings.threshold}%`,
          description:
            "Checked between turns. Pi's native safety limits can compact sooner.",
        },
        {
          value: "model",
          label: "Summarizer",
          description: `${settings.model ? `${settings.model.provider}/${settings.model.id}` : "Current working model"} · Must fit the context being summarized.`,
        },
      ],
      current,
    );
    if (!field) return;
    current = field;
    let edit: Partial<Settings> | undefined;
    if (field === "enabled") edit = { enabled: !settings.enabled };
    if (field === "threshold") {
      const value = await ctx.ui.input(
        "Handoff context threshold (1–99%)",
        String(settings.threshold),
      );
      const threshold = thresholdInput(value);
      if (threshold !== undefined && threshold !== settings.threshold)
        edit = { threshold };
      else if (value?.trim() && threshold === undefined)
        ctx.ui.notify(
          "Enter a whole percentage from 1 to 99. Threshold unchanged.",
          "warning",
        );
    }
    if (field === "model") {
      const available = ctx.modelRegistry.getAvailable();
      const value = await choose(
        ctx,
        "Handoff summarizer model",
        [
          { value: "current", label: "Current working model" },
          ...available.map((model) => ({
            value: `${model.provider}/${model.id}`,
            label: `${model.provider}/${model.id} · ${model.contextWindow.toLocaleString()} context tokens`,
          })),
        ],
        settings.model
          ? `${settings.model.provider}/${settings.model.id}`
          : "current",
      );
      if (value === "current") edit = { model: null };
      else if (value) {
        const model = available.find(
          (model) => `${model.provider}/${model.id}` === value,
        );
        if (model) edit = { model: { provider: model.provider, id: model.id } };
      }
    }
    if (edit) {
      try {
        settings = await saveSettings(edit);
        apply(settings);
      } catch {
        ctx.ui.notify(
          "Could not save handoff settings. Check file permissions or concurrent edits, then reopen /handoff.",
          "error",
        );
        return;
      }
    }
  }
}
