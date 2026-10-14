import { test, expect } from "bun:test";
import { apply, restore, entryType, describe } from "./state";
test("explicit phase transitions support parallel work without auto-completion", () => {
  let state = apply([], {
    op: "init",
    list: [{ phase: "Build", items: ["Implement", "Review"] }],
  });
  expect(state[0].tasks.every((task) => task.status === "pending")).toBe(true);
  state = apply(state, { op: "start", task: "Implement" });
  state = apply(state, { op: "start", task: "Review" });
  expect(state[0].tasks.every((task) => task.status === "in_progress")).toBe(
    true,
  );
  state = apply(state, {
    op: "block",
    task: "Review",
    reason: "Await implementation",
  });
  expect(describe(state)).toContain("Await implementation");
  state = apply(state, { op: "done", task: "Implement" });
  expect(state[0].tasks[1].status).toBe("blocked");
  state = apply(state, { op: "unblock", task: "Review" });
  expect(state[0].tasks[1].blocker).toBeUndefined();
});
test("invalid operations leave original state unchanged", () => {
  const state = apply([], { op: "init", items: ["One"] });
  expect(() => apply(state, { op: "append", items: ["Two", "One"] })).toThrow(
    "Duplicate",
  );
  expect(state[0].tasks).toHaveLength(1);
  expect(() => apply(state, { op: "done", task: "Missing" })).toThrow();
  expect(() => apply(state, { op: "append", items: ["bad\ntext"] })).toThrow();
  expect(() => apply(state, { op: "unblock", task: "One" })).toThrow();
  expect(apply(state, { op: "view" })).toEqual(state);
});
test("restore reads only canonical branch entries, not failed tool output", () => {
  const first = apply([], { op: "init", items: ["One"] });
  const second = apply(first, { op: "done", task: "One" });
  const entry = (phases: unknown) => ({
    type: "custom",
    customType: entryType,
    data: { phases },
  });
  expect(restore([entry(first), entry(second)])[0].tasks[0].status).toBe(
    "completed",
  );
  expect(restore([entry(first)])[0].tasks[0].status).toBe("pending");
  expect(restore([entry(first), entry(null)])).toEqual(first);
  expect(restore([])).toEqual([]);
});
test("bounded state and closed-task protection", () => {
  expect(() =>
    apply([], {
      op: "init",
      items: Array.from({ length: 201 }, (_, i) => `Task ${i}`),
    }),
  ).toThrow();
  const done = apply(apply([], { op: "init", items: ["One"] }), {
    op: "done",
    task: "One",
  });
  expect(() => apply(done, { op: "block", task: "One" })).toThrow();
  expect(apply(done, { op: "rm", task: "One" })[0].tasks).toEqual([]);
});
