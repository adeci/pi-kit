import { isDeepStrictEqual } from "node:util";
import { object, text, toolMessages } from "../../shared/completions";

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
export function agentResultDescription(details: unknown, content: string) {
  const result = object(details);
  return {
    title: result
      ? `Subagent ${result.name || result.role || "agent"} (${result.id || result.from || "unknown"}) · ${result.outcome || result.state || "message"}`
      : "Subagent result",
    summary: String(
      result?.report?.summary ??
        result?.message ??
        result?.partial ??
        content.split("\n")[0],
    ),
  };
}
