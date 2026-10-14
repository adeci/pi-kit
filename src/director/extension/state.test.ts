import { test, expect } from "bun:test";
import { activePrompt, blockTool, defaults, validState } from "./state";
test("director permits review, existing agent control and reviewed integration", () => {
  for (const name of [
    "read",
    "todo",
    "goal",
    "ask",
    "agent_roles",
    "agent_assign",
    "agent_status",
    "agent_integrate",
    "agent_wait",
    "agent_stop",
  ])
    expect(blockTool(name, {})).toBeUndefined();
  expect(
    blockTool("agent_spawn", { lifetime: "reusable", role: "sonic" }),
  ).toBeUndefined();
});
test("director blocks local execution and wrapper escape routes", () => {
  for (const name of [
    "bash",
    "write",
    "edit",
    "grep",
    "find",
    "codemode",
    "execute_code",
    "agent_forget",
    "unknown_tool",
  ])
    expect(blockTool(name, {})).toBeString();
  expect(blockTool("agent_spawn", {})).toContain("reusable");
  expect(
    blockTool("agent_spawn", { lifetime: "task", role: "task" }),
  ).toContain("reusable");
});
test("roles are explicit, persistent and routed through existing agents", () => {
  expect(validState(defaults)).toBe(true);
  expect(validState({ ...defaults, fast: "../../other" })).toBe(false);
  const prompt = activePrompt({
    enabled: true,
    fast: "sonic",
    strong: "reviewer",
  });
  expect(prompt).toContain('"sonic"');
  expect(prompt).toContain('"reviewer"');
  expect(prompt).toContain("agent_assign");
  expect(prompt).toContain("agent_integrate");
  expect(prompt).toContain("Goal mode, if active");
});
