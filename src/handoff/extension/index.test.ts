import { beforeEach, afterEach, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const document = [
  "Goal",
  "Constraints & Preferences",
  "Progress",
  "Key Decisions",
  "Critical Context",
  "Next Steps",
]
  .map((title) => `## ${title}\nPreserved evidence`)
  .join("\n");
let cutInput: any[];
mock.module("@earendil-works/pi-coding-agent", () => ({
  convertToLlm: (messages: any[]) => messages,
  buildSessionContext: (entries: any[]) => ({
    messages: entries.map((entry) => entry.message),
  }),
  findCutPoint: (entries: any[]) => {
    cutInput = entries;
    return { firstKeptEntryIndex: entries.length > 1 ? 1 : 0 };
  },
}));
mock.module("./ui", () => ({ openSettings: async () => {} }));
const { default: install } = await import("./main");
const { retainedBoundary } = await import("./summary");
let directory: string;
let previous: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "handoff-unit-"));
  previous = process.env.PI_HANDOFF_CONFIG;
  process.env.PI_HANDOFF_CONFIG = join(directory, "settings.json");
});
afterEach(() => {
  if (previous === undefined) delete process.env.PI_HANDOFF_CONFIG;
  else process.env.PI_HANDOFF_CONFIG = previous;
  rmSync(directory, { recursive: true, force: true });
});

async function setup(settings: object = {}) {
  writeFileSync(process.env.PI_HANDOFF_CONFIG!, JSON.stringify(settings));
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const calls: any[] = [],
    notices: any[] = [];
  const controller = new AbortController();
  const working = {
    provider: "fixture",
    id: "working",
    maxTokens: 8192,
    contextWindow: 200000,
  };
  const summarizer = { ...working, id: "summary" };
  const response = {
    content: [{ type: "text", text: document }],
    stopReason: "stop",
    usage: { totalTokens: 77 },
  };
  let aborts = 0;
  const ctx: any = {
    mode: "tui",
    model: working,
    signal: controller.signal,
    sessionManager: { getSessionId: () => "one" },
    getContextUsage: () => ({ percent: 80 }),
    abort: () => {
      aborts++;
      controller.abort();
    },
    ui: { setStatus: () => {}, notify: (...args: any[]) => notices.push(args) },
    modelRegistry: {
      find: (provider: string, id: string) =>
        [working, summarizer].find(
          (model) => model.provider === provider && model.id === id,
        ),
      getAvailable: () => [working, summarizer],
      complete: async (...args: any[]) => {
        calls.push(args);
        return response;
      },
    },
  };
  const pi: any = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    getSettings: () => ({ compaction: { keepRecentTokens: 64 } }),
    events: {
      emit: (name: string, callback: any) => events.get(name)?.(callback),
      on: (name: string, handler: any) => {
        events.set(name, handler);
        return () => events.delete(name);
      },
    },
  };
  install(pi);
  await handlers.get("session_start")({}, ctx);
  const projected = ["old", "recent"].map((id) => ({
    sourceEntry: {
      id,
      type: "message",
      message: { role: "user", content: id },
    },
    messages: [{ role: "user", content: id }],
  }));
  const native: any = {
    reason: "threshold",
    signal: controller.signal,
    branchEntries: projected.map((entry) => entry.sourceEntry),
    preparation: { firstKeptEntryId: "recent", tokensBefore: 50000 },
  };
  const boundary: any = {
    outcome: "completed",
    entries: [],
    context: {
      contextEntries: projected,
      contextMessages: projected.flatMap((entry) => entry.messages),
    },
  };
  return {
    pi,
    ctx,
    handlers,
    commands,
    calls,
    notices,
    response,
    controller,
    native,
    boundary,
    aborts: () => aborts,
  };
}

test("native compaction uses the configured model without changing the working model", async () => {
  const s = await setup({ model: { provider: "fixture", id: "summary" } });
  const result = await s.handlers.get("session_before_compact")(
    s.native,
    s.ctx,
  );
  expect(result.compaction.firstKeptEntryId).toBe("recent");
  expect(result.compaction.tokensBefore).toBe(50000);
  expect(result.compaction.usage.totalTokens).toBe(77);
  expect(s.calls[0][0].id).toBe("summary");
  expect(s.ctx.model.id).toBe("working");
});
test("percentage trigger returns a native compaction draft and never forces continuation", async () => {
  const s = await setup();
  s.ctx.getContextUsage = () => ({ percent: 79.9 });
  expect(await s.handlers.get("turn_end")(s.boundary, s.ctx)).toBeUndefined();
  s.ctx.getContextUsage = () => ({ percent: 80 });
  const result = await s.handlers.get("turn_end")(s.boundary, s.ctx);
  expect(result.entries[0].type).toBe("compaction");
  expect(result.entries[0].firstKeptEntryId).toBe("recent");
  expect(result.continue).toBeUndefined();
  expect(s.calls).toHaveLength(1);
});
test("disabled hands all native compaction back to Pi", async () => {
  const s = await setup({ enabled: false });
  expect(await s.handlers.get("turn_end")(s.boundary, s.ctx)).toBeUndefined();
  expect(
    await s.handlers.get("session_before_compact")(s.native, s.ctx),
  ).toBeUndefined();
  expect(s.calls).toHaveLength(0);
});
test("unknown usage, aborted turns and other extensions' pending entries are not compacted", async () => {
  const s = await setup();
  for (const outcome of ["aborted", "error"])
    expect(
      await s.handlers.get("turn_end")({ ...s.boundary, outcome }, s.ctx),
    ).toBeUndefined();
  expect(
    await s.handlers.get("turn_end")({ ...s.boundary, entries: [{}] }, s.ctx),
  ).toBeUndefined();
  s.ctx.getContextUsage = () => ({ percent: null });
  expect(await s.handlers.get("turn_end")(s.boundary, s.ctx)).toBeUndefined();
  expect(s.calls).toHaveLength(0);
});
test("cut selection uses edited visible messages and never resurrects an old summary", () => {
  const projected: any = [
    { sourceEntry: { id: "omitted" }, messages: [] },
    {
      sourceEntry: { id: "summary" },
      messages: [{ role: "compactionSummary", summary: "old" }],
    },
    {
      sourceEntry: { id: "first", message: { content: "obsolete" } },
      messages: [{ role: "user", content: "edited" }],
    },
    {
      sourceEntry: { id: "second" },
      messages: [{ role: "assistant", content: [] }],
    },
  ];
  expect(retainedBoundary(projected, 64)).toBe("second");
  expect(cutInput.map((entry) => entry.id)).toEqual(["first", "second"]);
  expect(cutInput[0].message.content).toBe("edited");
});
for (const reason of ["length", "toolUse", "error", "aborted"])
  test(`rejects ${reason} responses`, async () => {
    const s = await setup();
    s.response.stopReason = reason;
    expect(
      await s.handlers.get("session_before_compact")(s.native, s.ctx),
    ).toEqual({ cancel: true });
  });
for (const text of [
  "",
  "partial",
  document.replaceAll("Preserved evidence", ""),
])
  test(`rejects incomplete sections: ${text.slice(0, 20)}`, async () => {
    const s = await setup();
    s.response.content[0].text = text;
    expect(
      await s.handlers.get("session_before_compact")(s.native, s.ctx),
    ).toEqual({ cancel: true });
  });
test("failed boundary stops work and does not automatically retry or expose provider errors", async () => {
  const s = await setup();
  s.ctx.modelRegistry.complete = async () => {
    s.calls.push("failed");
    throw new Error("PRIVATE_PROVIDER_BODY");
  };
  expect(await s.handlers.get("turn_end")(s.boundary, s.ctx)).toBeUndefined();
  expect(s.aborts()).toBe(1);
  await s.handlers.get("turn_end")(s.boundary, s.ctx);
  expect(s.calls).toHaveLength(1);
  expect(JSON.stringify(s.notices)).not.toContain("PRIVATE_PROVIDER_BODY");
});
test("an unavailable selected model never silently falls back", async () => {
  const s = await setup({ model: { provider: "missing", id: "model" } });
  expect(
    await s.handlers.get("session_before_compact")(s.native, s.ctx),
  ).toEqual({ cancel: true });
  expect(s.calls).toHaveLength(0);
});
test("abort signal reaches generation and prevents committing a returned summary", async () => {
  const s = await setup();
  s.ctx.modelRegistry.complete = async (
    _model: any,
    _context: any,
    options: any,
  ) => {
    s.controller.abort();
    expect(options.signal.aborted).toBe(true);
    return s.response;
  };
  expect(
    await s.handlers.get("session_before_compact")(s.native, s.ctx),
  ).toEqual({ cancel: true });
});
test("duplicate discovery registers once and reload releases the claim", async () => {
  const s = await setup();
  const command = s.commands.get("handoff");
  install(s.pi);
  expect(s.commands.get("handoff")).toBe(command);
  s.handlers.get("session_shutdown")({ reason: "reload" }, s.ctx);
  install(s.pi);
  expect(s.commands.get("handoff")).not.toBe(command);
});

test("shutdown aborts in-flight work and fences its old callbacks", async () => {
  const s = await setup();
  let resolve!: (value: any) => void;
  s.ctx.modelRegistry.complete = () =>
    new Promise((done) => {
      resolve = done;
    });
  const running = s.handlers.get("session_before_compact")(s.native, s.ctx);
  s.handlers.get("session_shutdown")({ reason: "new" }, s.ctx);
  resolve(s.response);
  expect(await running).toEqual({ cancel: true });
  expect(s.notices).toHaveLength(0);
  expect(s.aborts()).toBe(0);
});
test("cancel before generation does not call a provider", async () => {
  const s = await setup();
  s.controller.abort();
  expect(
    await s.handlers.get("session_before_compact")(s.native, s.ctx),
  ).toEqual({ cancel: true });
  expect(s.calls).toHaveLength(0);
});
test("native failure fences a pre-prompt turn until explicit user input", async () => {
  const s = await setup();
  s.response.stopReason = "error";
  await s.handlers.get("session_before_compact")(s.native, s.ctx);
  const before = s.aborts();
  s.handlers.get("turn_start")({}, s.ctx);
  expect(s.aborts()).toBe(before + 1);
  s.handlers.get("input")({ source: "extension" });
  s.handlers.get("turn_start")({}, s.ctx);
  expect(s.aborts()).toBe(before + 2);
  s.handlers.get("input")({ source: "interactive" });
  s.handlers.get("turn_start")({}, s.ctx);
  expect(s.aborts()).toBe(before + 2);
});
