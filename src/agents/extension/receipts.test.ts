import { expect, test } from "bun:test";
import { Supervisor } from "./supervisor";

// Receipts are taken with the returned snapshot, for the root caller only,
// and only once finish() has completed (persistence can still change it).
function supervisor(state: string, finishing = false) {
  const consumed: string[] = [];
  const s: any = Object.create(Supervisor.prototype);
  const done: any = {};
  done.promise = new Promise<void>((resolve) => (done.resolve = resolve));
  if (["completed", "failed", "blocked", "cancelled"].includes(state))
    done.resolve();
  Object.assign(s, {
    closing: false,
    hooks: { consumed: (id: string) => consumed.push(id) },
    agents: new Map([
      [
        "child",
        {
          id: "child",
          parent: "main",
          depth: 1,
          name: "child",
          roleName: "scout",
          role: {},
          lifetime: "task",
          state: "stopped",
          activity: "",
          assignments: [{ id: "child:1", state, requests: 0, tokens: 0 }],
        },
      ],
    ]),
    runtime: new Map([["child", { finishing, done }]]),
  });
  return { s, consumed };
}

test("status and wait of a settled assignment are receipts, whatever the outcome", async () => {
  for (const outcome of ["completed", "failed", "blocked", "cancelled"]) {
    for (const [operation, args] of [
      ["status", { id: "child" }],
      ["status", { id: "child", view: "result" }],
      ["wait", { ids: ["child"], timeoutSeconds: 1 }],
    ] as const) {
      const { s, consumed } = supervisor(outcome);
      await s.dispatch("main", operation, args);
      expect(consumed).toEqual(["child:1"]);
    }
  }
});

test("running, still finishing, other views and non-root callers are not receipts", async () => {
  for (const [state, finishing] of [
    ["running", false],
    ["completed", true],
  ] as const) {
    const { s, consumed } = supervisor(state, finishing);
    await s.dispatch("main", "status", { id: "child" });
    expect(consumed).toEqual([]);
  }
  const { s, consumed } = supervisor("completed");
  s.dispatch("other", "status", { id: "child" }).catch(() => {});
  await s
    .dispatch("main", "status", { id: "child", view: "nope" })
    .catch(() => {});
  expect(consumed).toEqual([]);
});

test("a wait that returned a running snapshot is not a receipt if finish lands later", async () => {
  const { s, consumed } = supervisor("running");
  const snapshot = s.public;
  s.public = function (agent: any) {
    const value = snapshot.call(this, agent);
    // finish() lands between the snapshot and the dispatch continuation.
    queueMicrotask(() => (agent.assignments[0].state = "completed"));
    return value;
  };
  const result = await s.dispatch("main", "wait", {
    ids: ["child"],
    timeoutSeconds: 1,
  });
  expect(result.outcome).toBe("elapsed");
  expect(result.agents[0].outcome).toBe("running");
  expect(result).not.toHaveProperty("receipts");
  expect(consumed).toEqual([]);
});
