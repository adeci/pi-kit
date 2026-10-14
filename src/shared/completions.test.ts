import { expect, test } from "bun:test";
import { completionDelivery } from "./completions";

function fixture() {
  const hooks = new Map<string, Function>();
  const sent: any[] = [];
  const entries: any[] = [];
  let idle = false;
  const ctx: any = {
    isIdle: () => idle,
    sessionManager: { getBranch: () => entries },
  };
  const pi: any = {
    on: (name: string, handler: Function) => hooks.set(name, handler),
    sendMessage: (message: any) => sent.push(message),
  };
  const queue = completionDelivery(pi);
  const emit = (name: string, event: any = {}) => hooks.get(name)?.(event, ctx);
  emit("session_start");
  const add = (
    key: string,
    observed?: (entries: readonly unknown[]) => boolean,
  ) =>
    queue.add(key, {
      message: { customType: "test", content: key, display: true },
      observed,
    });
  return {
    add,
    sent,
    entries,
    emit,
    idle: () => {
      idle = true;
    },
  };
}
test("busy completions remain retractable until final boundary; unread batch needs one continuation", () => {
  const f = fixture();
  f.add("read", (entries) => entries.includes("receipt"));
  f.add("unread-a");
  f.add("unread-b");
  expect(f.sent).toEqual([]);
  f.entries.push("receipt");
  const result = f.emit("agent_before_settle", { outcome: "completed" });
  expect(result.continue).toBe(true);
  expect(result.entries.map((entry: any) => entry.content)).toEqual([
    "unread-a",
    "unread-b",
  ]);
  expect(
    f.emit("agent_before_settle", { outcome: "completed" }),
  ).toBeUndefined();
});
test("idle notifications check receipts before waking, including a late callback", () => {
  const f = fixture();
  f.idle();
  f.entries.push("receipt");
  f.add("read", (entries) => entries.includes("receipt"));
  f.add("new");
  expect(f.sent.map((message) => message.content)).toEqual(["new"]);
});
test("abort and errors do not restart work; reload never replays pending notifications", () => {
  const f = fixture();
  f.add("pending");
  expect(f.emit("agent_before_settle", { outcome: "aborted" })).toBeUndefined();
  f.emit("agent_settled", { aborted: true });
  expect(f.sent).toEqual([]);
  expect(f.emit("agent_before_settle", { outcome: "error" })).toBeUndefined();
  f.emit("agent_settled", { aborted: false });
  expect(f.sent).toEqual([]);
  f.emit("session_shutdown");
  f.emit("session_start");
  expect(
    f.emit("agent_before_settle", { outcome: "completed" }),
  ).toBeUndefined();
});
test("arrival after boundary but before settlement still wakes once", () => {
  const f = fixture();
  f.emit("agent_before_settle", { outcome: "completed" });
  f.add("race");
  f.emit("agent_settled", { aborted: false });
  expect(f.sent.map((message) => message.content)).toEqual(["race"]);
  f.emit("agent_settled", { aborted: false });
  expect(f.sent).toHaveLength(1);
});
