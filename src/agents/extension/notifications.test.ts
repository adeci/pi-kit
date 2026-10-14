import { expect, test } from "bun:test";
import { agentResultObserved } from "./notifications";
const result = {
  id: "agent",
  assignment: "agent:1",
  outcome: "completed",
  report: { summary: "reviewed", outcome: "completed" },
  partial: "",
  persistenceFailed: false,
};
const entry = (value: unknown, toolName = "agent_status") => ({
  type: "message",
  message: {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text: JSON.stringify(value) }],
  },
});
test("exact model-visible report suppresses only its own assignment", () => {
  expect(
    agentResultObserved(result, [entry({ ...result, id: "agent:1" })]),
  ).toBe(true);
  expect(
    agentResultObserved({ ...result, assignment: "agent:2" }, [entry(result)]),
  ).toBe(false);
  expect(
    agentResultObserved({ ...result, report: { summary: "changed" } }, [
      entry(result),
    ]),
  ).toBe(false);
});
test("wait, live status, errors, truncated content and rendering-only details do not acknowledge", () => {
  for (const row of [
    entry(result, "agent_wait"),
    entry({ ...result, outcome: "running" }),
    entry({ ...result, report: undefined }),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "agent_status",
        details: result,
        content: [],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "agent_status",
        content: [{ type: "text", text: '{"report":' }],
      },
    },
  ])
    expect(agentResultObserved(result, [row])).toBe(false);
  const failed = entry(result);
  (failed.message as any).isError = true;
  expect(agentResultObserved(result, [failed])).toBe(false);
  expect(
    agentResultObserved({ ...result, persistenceFailed: true }, [
      entry(result),
    ]),
  ).toBe(false);
  expect(
    agentResultObserved({ ...result, partial: "new partial output" }, [
      entry(result),
    ]),
  ).toBe(false);
});
