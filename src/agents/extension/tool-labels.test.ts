import { expect, test } from "bun:test";
import {
  agentLabel,
  callTargets,
  resultAgents,
  rememberAgents,
} from "./tool-labels";
test("render state survives fresh contexts without an invalidation loop", () => {
  const state = {};
  const first = { state },
    second = { state };
  expect(rememberAgents(first.state, [{ id: "one", name: "Scout" }])).toBe(
    true,
  );
  expect(rememberAgents(second.state, [{ id: "one", name: "Scout" }])).toBe(
    false,
  );
  expect(state).toEqual({ agents: [{ id: "one", name: "Scout" }] });
});
test("call history names the subagent and retains its full handle", () => {
  expect(
    callTargets({ ids: ["29844f553aa83c01"] }, [
      { id: "29844f553aa83c01", name: "memory-research", role: "reviewer" },
    ]),
  ).toEqual(["memory-research ⟨reviewer⟩ [29844f553aa83c01]"]);
  expect(callTargets({ id: "missing" }, [])).toEqual(["subagent [missing]"]);
});
test("restored wait results carry the original names without a live agent", () => {
  expect(
    resultAgents({
      outcome: "elapsed",
      agents: [{ id: "one", name: "Scout", role: "scout", state: "running" }],
    }).map(agentLabel),
  ).toEqual(["Scout [one]"]);
  expect(resultAgents(null)).toEqual([]);
});
test("names cannot inject terminal control sequences", () => {
  expect(agentLabel({ id: "id", name: "\x1b[2Jbad\nname" })).toBe(
    "bad name [id]",
  );
});
