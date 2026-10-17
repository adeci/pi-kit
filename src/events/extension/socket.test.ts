import { expect, test, mock } from "bun:test";
// This socket test does not render. Actual Pi tests exercise the real TUI.
mock.module("@earendil-works/pi-tui", () => ({
  Text: class {},
  truncateToWidth: (text: string) => text,
  wrapTextWithAnsi: (text: string) => [text],
}));
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
const { default: events } = await import("./index");

test("live Pi subscriber bounds follow-ups, permits controls, and invalidates old sockets", async () => {
  const root = mkdtempSync("/tmp/pe-bun-");
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = root;
  const hooks = new Map<string, Function>();
  const messages: any[] = [];
  const entries: any[] = [];
  const bus = new EventEmitter();
  const commands = new Map<string, any>();
  const statuses = new Map<string, string | undefined>();
  const notices: string[] = [];
  const api: any = {
    exec: async (file: string, args: string[]) => {
      const child = Bun.spawn([file, ...args], {
        env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code, killed: false };
    },
    events: {
      emit: bus.emit.bind(bus),
      on: (name: string, handler: (...args: any[]) => void) => {
        bus.on(name, handler);
        return () => bus.off(name, handler);
      },
    },
    on: (name: string, handler: Function) => {
      const previous = hooks.get(name);
      hooks.set(name, async (...args: any[]) => {
        await previous?.(...args);
        return handler(...args);
      });
    },
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerMessageRenderer: () => {},
    sendMessage: (message: any) => messages.push(message),
  };
  const ctx: any = {
    sessionManager: {
      getSessionId: () => "test-session",
      getEntries: () => entries,
      getBranch: () => entries,
    },
    isIdle: () => false,
    hasUI: true,
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (key: string, value: string | undefined) =>
        statuses.set(key, value),
    },
  };
  await events(api);
  let controlled = false;
  let releaseStalled: (() => void) | undefined;
  bus.emit("pi-events:subscribe", {
    topic: "test.control",
    handler: () => {
      controlled = true;
    },
  });
  const record = () =>
    JSON.parse(
      readFileSync(
        join(
          root,
          "pi-events",
          readdirSync(join(root, "pi-events")).find((name) =>
            name.endsWith(".json"),
          )!,
        ),
        "utf8",
      ),
    );
  const send = (
    subscription: any,
    index: number,
    topic = "agent.result",
    frame?: any,
  ): Promise<any> =>
    new Promise((resolve, reject) => {
      const socket = createConnection(
        join(root, "pi-events", `${subscription.id}.sock`),
      );
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("error", reject);
      socket.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
      socket.end(
        Buffer.isBuffer(frame)
          ? frame
          : JSON.stringify(
              frame ?? {
                version: 1,
                subscription: subscription.id,
                token: subscription.token,
                event: {
                  version: 1,
                  id: index.toString(16).padStart(32, "0"),
                  topic,
                  source: "test",
                  payload: { text: "event" },
                },
              },
            ),
      );
    });
  try {
    await hooks.get("session_start")!(undefined, ctx);
    const first = record();
    expect(notices).toEqual([]);
    expect(first.name).toBe(statuses.get("pi-events:name"));
    expect(first.name).toMatch(/^[a-z]/);
    expect(first.topics).toContain("session.message");
    await commands.get("events").handler("rename Albacore", ctx);
    expect(record().name).toBe("albacore");
    expect(statuses.get("pi-events:name")).toBe("albacore");
    await commands.get("events").handler("rename bad--name", ctx);
    expect(record().name).toBe("albacore");
    for (let i = 1; i <= 32; i++) expect((await send(first, i)).ok).toBe(true);
    expect(messages).toHaveLength(0); // Owned by the extension until settlement.
    expect((await send(first, 33)).ok).toBe(false);
    expect((await send(first, 34, "agent.progress")).ok).toBe(true);
    expect((await send(first, 35, "test.control")).ok).toBe(true);
    expect(controlled).toBe(true);
    const boundary = await hooks.get("agent_before_settle")!(
      { outcome: "completed" },
      ctx,
    );
    messages.push(...boundary.entries);
    expect(messages).toHaveLength(32);
    entries.push(
      ...messages.map((message) => ({
        type: "custom_message",
        customType: message.customType,
        details: message.details,
      })),
    );
    expect((await send(first, 33)).ok).toBe(true);
    const nextBoundary = await hooks.get("agent_before_settle")!(
      { outcome: "completed" },
      ctx,
    );
    messages.push(...nextBoundary.entries);
    expect(messages).toHaveLength(33);
    expect((await send(first, 33)).ok).toBe(true);
    expect(messages).toHaveLength(33);
    await hooks.get("session_start")!(undefined, ctx);
    expect(record().id).not.toBe(first.id);
    expect(record().name).toBe("albacore");
    await expect(send(first, 36)).rejects.toThrow();
    const fixtures = JSON.parse(
      readFileSync(new URL("../protocol.json", import.meta.url), "utf8"),
    );
    const next = record();
    bus.emit("pi-events:subscribe", {
      topic: "agent.result",
      handler: () => {},
    });
    const base = {
      version: 1,
      subscription: next.id,
      token: next.token,
      event: fixtures.event,
    };
    for (const item of fixtures.frames) {
      const frame = { ...base, ...item.changes };
      for (const key of item.remove ?? []) delete frame[key];
      expect((await send(next, 0, "agent.result", frame)).ok).toBe(item.valid);
    }
    for (const [index, item] of fixtures.duplicates.entries()) {
      const event = {
        ...fixtures.event,
        id: index.toString(16).padStart(32, "0"),
      };
      expect(
        (
          await send(next, 0, "agent.result", {
            ...base,
            event: { ...event, payload: item.first },
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await send(next, 0, "agent.result", {
            ...base,
            event: { ...event, payload: item.second },
          })
        ).ok,
      ).toBe(item.same);
    }
    expect(messages).toHaveLength(33);
    const malformed = Buffer.from(
      JSON.stringify({ ...base, event: { ...fixtures.event, payload: "x" } }),
    );
    malformed[malformed.indexOf('"x"') + 1] = 0xff;
    expect((await send(next, 0, "agent.result", malformed)).ok).toBe(false);
    let cancelled: AbortSignal | undefined;
    bus.emit("pi-events:subscribe", {
      topic: "test.slow",
      handler: (_event: unknown, signal: AbortSignal) => {
        cancelled = signal;
        return new Promise<void>((resolve) => {
          releaseStalled = resolve;
        });
      },
    });
    expect((await send(next, 90, "test.slow")).ok).toBe(false);
    expect(cancelled?.aborted).toBe(true);
    controlled = false;
    expect((await send(next, 91, "test.control")).ok).toBe(true);
    expect(controlled).toBe(true);
    // Shutdown must not wait for an extension that ignores cancellation.
    await hooks.get("session_shutdown")!();
  } finally {
    releaseStalled?.();
    await hooks.get("session_shutdown")!();
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
