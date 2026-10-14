import { expect, test } from "bun:test";
import { activeAgents, agentWidgetLines, type WidgetStyle } from "./widget";
const style: WidgetStyle = {
  accent: (text) => text,
  muted: (text) => text,
  width: (text) => Array.from(text).length,
  fit: (text, width) => Array.from(text).slice(0, Math.max(0, width)).join(""),
};
const agent = (name = "Scout", extra = {}) => ({
  id: "0123456789abcdef",
  depth: 1,
  name,
  role: name.toLowerCase(),
  state: "running",
  model: "provider/model",
  thinking: "high",
  requests: 12,
  cost: 0.32,
  activity: "read README.md",
  ...extra,
});
test("HUD keeps names, short models and separate activity; no raw handle/provider", () => {
  const lines = agentWidgetLines([agent(), agent("Reviewer")], 100, 40, style);
  expect(lines).toHaveLength(5);
  expect(lines[0]).toContain("2 active");
  expect(lines[1]).toContain("Scout");
  expect(lines[1]).toContain("model · high · 12 turns · $0.320");
  expect(lines[2]).toStartWith("│  ↳ read README.md");
  expect(lines[4]).toStartWith("   ↳ read README.md");
  expect(lines[1].indexOf("model")).toBe(lines[3].indexOf("model"));
  expect(lines.join("\n")).not.toContain("0123456789abcdef");
  expect(lines.join("\n")).not.toContain("provider/");
});
test("expanding the terminal reveals the full name and role", () => {
  const workers = [
    agent("memory-research", {
      role: "reviewer",
      model: "openai-codex/gpt-6-astra",
    }),
  ];
  const narrow = agentWidgetLines(workers, 55, 40, style);
  const wide = agentWidgetLines(workers, 180, 40, style);
  expect(narrow[1]).not.toContain("memory-research ⟨reviewer⟩");
  expect(wide[1]).toContain("memory-research ⟨reviewer⟩");
  expect(wide[1]).toContain("gpt-6-astra · high · 12 turns · $0.320");
});
test("no active agents means no HUD", () => {
  expect(activeAgents([agent("Scout", { state: "parked" })])).toEqual([]);
  expect(agentWidgetLines([], 80, 30, style)).toEqual([]);
});
test("large lists stay viewport-bounded and report overflow truthfully", () => {
  const lines = agentWidgetLines(
    Array.from({ length: 32 }, (_, i) => agent(`Worker${i}`)),
    80,
    30,
    style,
  );
  expect(lines.length).toBeLessThanOrEqual(10);
  expect(lines[0]).toContain("32 active");
  expect(lines.at(-1)).toContain("24 more active");
});
test("narrow layout prioritizes names; all rows fit", () => {
  for (const width of [1, 10, 24, 42, 80]) {
    const lines = agentWidgetLines([agent()], width, 20, style);
    expect(lines.every((line) => style.width(line) <= width)).toBe(true);
    if (width === 24) expect(lines[1]).toContain("Scout");
  }
});
test("untrusted activity cannot inject control bytes or extra rows", () => {
  const lines = agentWidgetLines(
    [agent("Scout\nInjected", { activity: "\x1b[2J\r\nread\tREADME" })],
    100,
    40,
    style,
  );
  expect(lines).toHaveLength(3);
  expect(lines.every((line) => !/[\r\n\t\x1b]/.test(line))).toBe(true);
});
