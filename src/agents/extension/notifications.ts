import { isDeepStrictEqual } from "node:util";
import { object, text, toolMessages } from "../../shared/completions";
import type { CompletionCard } from "../../shared/completion-renderer";

export function agentResultObserved(
  result: unknown,
  entries: readonly unknown[],
): boolean {
  const expected = object(result);
  // Questions/replies, live state, and persistence errors must not be swallowed.
  if (!expected?.assignment || !expected.report || expected.persistenceFailed)
    return false;
  return toolMessages(entries, "agent_status").some((message) => {
    if (message.isError) return false;
    try {
      // Read model-visible content, not rendering-only details or a nested call
      // whose outer tool might have discarded the result.
      const actual = JSON.parse(text(message.content));
      return (
        actual.assignment === expected.assignment &&
        actual.outcome === expected.outcome &&
        isDeepStrictEqual(actual.report, expected.report) &&
        (!expected.partial || actual.partial === expected.partial) &&
        (!expected.patch || actual.patch === expected.patch) &&
        actual.error === expected.error
      );
    } catch {
      return false;
    }
  });
}
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
