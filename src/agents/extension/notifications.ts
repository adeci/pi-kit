import { object } from "../../shared/completions";
import type { CompletionCard } from "../../shared/completion-renderer";

export function agentResultDescription(
  details: unknown,
  content: string,
): CompletionCard {
  const result = object(details);
  const outcome = String(
    result?.report?.outcome ?? result?.outcome ?? result?.state ?? "",
  );
  const message = result?.kind === "agent-message" || result?.message;
  const tone: Pick<CompletionCard, "tone" | "glyph"> = message
    ? { tone: "accent", glyph: "✉" }
    : outcome === "completed"
      ? { tone: "success", glyph: "✓" }
      : ["blocked", "cancelled", "interrupted"].includes(outcome)
        ? { tone: "warning", glyph: "■" }
        : { tone: "error", glyph: "✗" };
  const summary = String(
    result?.report?.summary ??
      result?.message ??
      result?.partial ??
      content.split("\n")[0],
  );
  return {
    ...tone,
    title: result
      ? `${result.name || result.role || "agent"}`
      : "Subagent result",
    meta: [
      message ? "message" : outcome,
      result?.role && result.role !== result.name ? result.role : undefined,
      String(result?.id || result?.from || ""),
    ],
    preview: summary
      .split("\n")
      .filter((line) => line.trim())
      .slice(0, 3),
    body: content.split("\n").slice(1).join("\n") || content,
  };
}
