import { expect, mock, test } from "bun:test";
// Pi provides its TUI package at runtime; the widget is tested separately.
mock.module("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string) => text,
  visibleWidth: (text: string) => text.length,
}));
const { default: jobs, interval, jobGuidance } = await import("./index");
import { formatJob, jobEvent } from "./watcher";

test("loaded jobs extension supplies guidance even when skills are disabled", async () => {
  const handlers = new Map<string, Function>();
  await jobs({
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand() {},
  } as any);
  const sections: Record<string, string> = { original: "Original guidelines" };
  handlers.get("before_agent_start")!({ systemPromptOptions: { sections } });
  expect(sections.original).toBe("Original guidelines");
  expect(sections.pi_jobs).toBe(jobGuidance);
  expect(sections.pi_jobs).toContain("10-604800");
  // The guidance defines long-running work concretely instead of opting in.
  expect(jobGuidance).toContain("builds");
  expect(jobGuidance).toContain("never fall back to a long foreground command");
});

test("foreground bash is guarded through tool_call", async () => {
  const handlers = new Map<string, Function>();
  await jobs({
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand() {},
  } as any);
  const toolCall = handlers.get("tool_call")!;
  const quick = { toolName: "bash", input: { command: "ls" } as any };
  expect(await toolCall(quick)).toBeUndefined();
  expect(quick.input.timeout).toBe(120);
  const long = await toolCall({
    toolName: "bash",
    input: { command: "nix build .#x" },
  });
  expect(long.block).toBe(true);
  expect(
    await toolCall({ toolName: "read", input: { path: "x" } }),
  ).toBeUndefined();
});

test("check-ins are explicitly bounded", () => {
  expect(interval(null)).toBeNull();
  expect(interval(10)).toBe(10);
  for (const value of [9, 604801, NaN, "10", 10.5])
    expect(() => interval(value)).toThrow();
});
test("job events fit the wire limit even with escaped or Unicode log tails", () => {
  for (const tail of [
    "x".repeat(8192),
    "\u0000".repeat(8192),
    "界".repeat(8192),
  ]) {
    const event = jobEvent({
      handle: "1:" + "a".repeat(32),
      owner: "test",
      name: "build",
      state: "success",
      exit_code: 0,
      elapsed_seconds: 1,
      tail,
    });
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(12288);
    expect(event.text).toContain("Full output: pi-jobs log 1:");
    expect(event).not.toHaveProperty("tail");
  }
});
test("job summaries bound output and preserve the handle", () => {
  const text = formatJob({
    handle: "1:" + "a".repeat(32),
    owner: "test",
    name: "build",
    state: "failed",
    exit_code: 7,
    elapsed_seconds: 3,
    tail: "x".repeat(20000),
  });
  expect(text).toContain("failed exit=7");
  expect(text).toContain("Full output: pi-jobs log 1:");
  expect(text.length).toBeLessThan(4600);
});
