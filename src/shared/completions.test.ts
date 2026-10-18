import { expect, test } from "bun:test";
import { ARM, CONSUME, QUIET, completionDelivery } from "./completions";

function fixture() {
  const hooks = new Map<string, Function>();
  const bus = new Map<string, Set<Function>>();
  const sent: { content: string; options?: any }[] = [];
  const quiet: string[] = [];
  let idle = false;
  const ctx: any = { isIdle: () => idle, signal: undefined };
  const pi: any = {
    on: (name: string, handler: Function) => hooks.set(name, handler),
    sendMessage: (message: any, options?: any) =>
      sent.push({ content: message.content, options }),
    events: {
      on: (channel: string, handler: Function) => {
        if (!bus.has(channel)) bus.set(channel, new Set());
        bus.get(channel)!.add(handler);
        return () => bus.get(channel)!.delete(handler);
      },
      emit: (channel: string, data: unknown) => {
        for (const handler of bus.get(channel) ?? []) handler(data);
      },
    },
  };
  pi.events.on(QUIET, (key: string) => quiet.push(key));
  const delivery = completionDelivery(pi);
  const emit = (name: string, event: any = {}) => hooks.get(name)?.(event, ctx);
  emit("session_start");
  const withdrawn: string[] = [];
  const add = (key: string, wake = false) =>
    delivery.add(key, {
      message: { customType: "test", content: key, display: true },
      wake,
      withdrawn: () => withdrawn.push(key),
    });
  const contents = (result: any) =>
    result?.entries?.map((entry: any) => entry.content);
  const toolTurn = () =>
    emit("turn_end", { outcome: "completed", toolResults: [{}] });
  const finalTurn = () =>
    emit("turn_end", { outcome: "completed", toolResults: [] });
  return {
    add,
    delivery,
    sent,
    quiet,
    withdrawn,
    emit,
    ctx,
    pi,
    contents,
    toolTurn,
    finalTurn,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

test("mid-turn arrivals land at the next tool boundary, before the final answer, without a turn of their own", () => {
  const f = fixture();
  f.add("job:1");
  f.add("agent:1", true);
  const boundary = f.toolTurn();
  expect(f.contents(boundary)).toEqual(["job:1", "agent:1"]);
  // The loop continues after tool results anyway; continue adds no request.
  expect(boundary.continue).toBe(true);
  expect(f.finalTurn()).toBeUndefined();
  expect(
    f.emit("agent_before_settle", { outcome: "completed" }),
  ).toBeUndefined();
  f.emit("agent_settled", { aborted: false });
  expect(f.sent).toEqual([]);
  expect(f.quiet).toEqual(["job:1"]);
});

test("a quiet job pending at the final answer is appended with no extra turn", () => {
  const f = fixture();
  f.add("job:1");
  const boundary = f.finalTurn();
  expect(f.contents(boundary)).toEqual(["job:1"]);
  expect(boundary.continue).toBeUndefined();
  // Arrival between the final turn and settlement: still no continuation.
  f.add("job:2");
  const settle = f.emit("agent_before_settle", { outcome: "completed" });
  expect(f.contents(settle)).toEqual(["job:2"]);
  expect(settle.continue).toBeUndefined();
  // Arrival after the settle boundary: appended without triggering a turn.
  f.add("job:3");
  f.emit("agent_settled", { aborted: false });
  expect(f.sent).toEqual([{ content: "job:3", options: undefined }]);
  expect(f.quiet).toEqual(["job:1", "job:2", "job:3"]);
});

test("an agent result pending at the final answer continues the run once", () => {
  const f = fixture();
  f.add("agent:1", true);
  f.add("job:1");
  // The final turn_end takes only the quiet job; the result waits for settle.
  expect(f.contents(f.finalTurn())).toEqual(["job:1"]);
  f.add("agent:2", true);
  const settle = f.emit("agent_before_settle", { outcome: "completed" });
  expect(f.contents(settle)).toEqual(["agent:1", "agent:2"]);
  expect(settle.continue).toBe(true);
  expect(
    f.emit("agent_before_settle", { outcome: "completed" }),
  ).toBeUndefined();
  // Arrival after the settle boundary wakes exactly once.
  f.add("agent:3", true);
  f.emit("agent_settled", { aborted: false });
  expect(f.sent).toEqual([
    {
      content: "agent:3",
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
  f.emit("agent_settled", { aborted: false });
  expect(f.sent).toHaveLength(1);
});

test("idle: jobs are appended without a turn, agent results wake, quiet first", () => {
  const f = fixture();
  f.setIdle(true);
  f.add("job:1");
  expect(f.sent).toEqual([{ content: "job:1", options: undefined }]);
  f.add("agent:1", true);
  expect(f.sent[1]).toEqual({
    content: "agent:1",
    options: { deliverAs: "followUp", triggerTurn: true },
  });
  expect(f.quiet).toEqual(["job:1"]);
});

test("consumed before arrival delivers nothing; an explicit rewatch re-arms", () => {
  const f = fixture();
  f.setIdle(true);
  f.pi.events.emit(CONSUME, "job:1");
  f.delivery.consume("agent:1");
  f.add("job:1");
  f.add("agent:1", true);
  expect(f.sent).toEqual([]);
  f.pi.events.emit(ARM, "job:1");
  f.add("job:1");
  expect(f.sent.map((message) => message.content)).toEqual(["job:1"]);
});

test("a newer completion for a held key replaces it once and releases the old one", () => {
  const f = fixture();
  f.add("job:1");
  f.add("job:1");
  expect(f.withdrawn).toEqual(["job:1"]);
  expect(f.contents(f.toolTurn())).toEqual(["job:1"]);
});

test("consumed after it was queued but before delivery is withdrawn", () => {
  const f = fixture();
  f.add("job:1");
  f.add("agent:1", true);
  f.add("job:2");
  f.pi.events.emit(CONSUME, "job:1");
  f.delivery.consume("agent:1");
  expect(f.withdrawn).toEqual(["job:1", "agent:1"]);
  expect(f.contents(f.toolTurn())).toEqual(["job:2"]);
  f.emit("agent_before_settle", { outcome: "completed" });
  f.emit("agent_settled", { aborted: false });
  expect(f.sent).toEqual([]);
});

test("abort and errors never restart work; held completions are appended quietly", () => {
  const f = fixture();
  f.add("job:1");
  f.add("agent:1", true);
  expect(
    f.emit("turn_end", { outcome: "aborted", toolResults: [{}] }),
  ).toBeUndefined();
  expect(f.emit("agent_before_settle", { outcome: "aborted" })).toBeUndefined();
  f.emit("agent_settled", { aborted: true });
  expect(f.sent).toEqual([
    { content: "job:1", options: undefined },
    { content: "agent:1", options: undefined },
  ]);
  f.add("agent:2", true);
  expect(f.emit("agent_before_settle", { outcome: "error" })).toBeUndefined();
  f.emit("agent_settled", { aborted: false });
  expect(f.sent[2]).toEqual({ content: "agent:2", options: undefined });
  // An aborted signal at a completed boundary also delivers nothing there.
  f.add("agent:3", true);
  f.ctx.signal = { aborted: true };
  expect(f.toolTurn()).toBeUndefined();
  expect(
    f.emit("agent_before_settle", { outcome: "completed" }),
  ).toBeUndefined();
});

test("reload never replays pending completions or keeps stale receipts", () => {
  const f = fixture();
  f.add("job:1");
  f.delivery.consume("job:2");
  f.emit("session_shutdown", { reason: "reload" });
  f.emit("session_start");
  expect(f.toolTurn()).toBeUndefined();
  expect(
    f.emit("agent_before_settle", { outcome: "completed" }),
  ).toBeUndefined();
  f.emit("agent_settled", { aborted: false });
  expect(f.sent).toEqual([]);
  // Without a session there is nowhere to deliver.
  f.emit("session_shutdown", { reason: "quit" });
  f.setIdle(true);
  f.add("job:3");
  expect(f.sent).toEqual([]);
});

test("two deliveries at one boundary keep each other's entries (Pi replaces, not appends)", () => {
  const hooks = new Map<string, Function[]>();
  const pi: any = {
    on: (name: string, handler: Function) =>
      hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    sendMessage() {},
    events: { on: () => () => {}, emit() {} },
  };
  const ctx: any = { isIdle: () => false };
  const events = completionDelivery(pi);
  const agents = completionDelivery(pi);
  // Mirrors ExtensionRunner.emitBoundary: each result's entries replace the
  // accumulated list; continue persists unless a handler sets it.
  const boundary = (type: string, base: any) => {
    let entries: any[] = [];
    let shouldContinue = false;
    for (const handler of hooks.get(type) ?? []) {
      const result = handler(
        { ...base, entries, continue: shouldContinue },
        ctx,
      );
      if (result?.entries !== undefined) entries = result.entries;
      if (result?.continue !== undefined) shouldContinue = result.continue;
    }
    return { entries: entries.map((entry) => entry.content), shouldContinue };
  };
  for (const handler of hooks.get("session_start")!) handler({}, ctx);
  const message = (content: string) => ({
    customType: "test",
    content,
    display: true,
  });
  events.add("job:1", { message: message("job:1") });
  agents.add("agent:1", { message: message("agent:1"), wake: true });
  expect(
    boundary("turn_end", { outcome: "completed", toolResults: [{}] }),
  ).toEqual({ entries: ["job:1", "agent:1"], shouldContinue: true });
  agents.add("agent:2", { message: message("agent:2"), wake: true });
  events.add("job:2", { message: message("job:2") });
  expect(boundary("agent_before_settle", { outcome: "completed" })).toEqual({
    entries: ["job:2", "agent:2"],
    shouldContinue: true,
  });
});
