import { expect, test } from "bun:test";
import { clean, sessionCost } from "./state";

test("cost counts active branch messages, nested tool usage and compaction once", () => {
  const usage = { cost: { total: 0.25 } };
  expect(
    sessionCost([
      { type: "message", message: { role: "assistant", usage } },
      {
        type: "message",
        message: { role: "toolResult", usage, details: { usage } },
      },
      { type: "compaction", usage },
    ]),
  ).toBe(0.75);
  expect(
    sessionCost([
      null,
      { usage: { cost: { total: Infinity } } },
      { usage: { cost: { total: -1 } } },
    ]),
  ).toBe(0);
});
test("footer text cannot inject terminal controls or rows", () => {
  expect(clean("hello\x1b[2J\n\tworld")).toBe("hello world");
});
