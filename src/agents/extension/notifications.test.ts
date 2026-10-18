import { expect, test } from "bun:test";
import { agentResultDescription } from "./notifications";
const result = {
  id: "agent",
  assignment: "agent:1",
  outcome: "completed",
  report: { summary: "reviewed", outcome: "completed" },
  partial: "",
  persistenceFailed: false,
};
test("result card: outcome glyph, agent name as title, summary preview", () => {
  const card = agentResultDescription(
    { ...result, name: "reviewer-1", role: "reviewer" },
    `[Agent message/result]\n${JSON.stringify(result)}`,
  );
  expect(card).toMatchObject({
    tone: "success",
    glyph: "✓",
    title: "reviewer-1",
    preview: ["reviewed"],
  });
  expect(card.meta).toEqual(["completed", "reviewer", "agent"]);
  expect(card.body).toBe(JSON.stringify(result));
  expect(
    agentResultDescription(
      { ...result, report: { ...result.report, outcome: "blocked" } },
      "",
    ),
  ).toMatchObject({ tone: "warning", glyph: "■" });
  expect(
    agentResultDescription({ from: "child", message: "question?" }, ""),
  ).toMatchObject({ tone: "accent", preview: ["question?"] });
});
