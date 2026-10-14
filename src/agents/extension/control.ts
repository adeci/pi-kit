import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { chmod, unlink } from "node:fs/promises";
import type { ChildConfig } from "./types";

const MAX_FRAME = 512 * 1024;
export async function request(
  config: Pick<ChildConfig, "id" | "socket" | "token" | "assignment">,
  operation: string,
  args: unknown = {},
  signal?: AbortSignal,
  timeoutMs = 30000,
): Promise<any> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection(config.socket);
    let buffer = Buffer.alloc(0),
      finished = false;
    const end = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () =>
      end(
        new Error(
          "Agent request cancelled; accepted work is not cancelled or resubmitted.",
        ),
      );
    const timer = setTimeout(
      () =>
        end(
          new Error(
            `Agent ${operation} acknowledgment timed out; inspect state before retrying.`,
          ),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({
          version: 1,
          agent: config.id,
          token: config.token,
          assignment: config.assignment,
          operation,
          args,
        }) + "\n",
      ),
    );
    socket.on("error", end);
    socket.once("close", () =>
      end(new Error("Agent control connection closed")),
    );
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME)
        return end(new Error("Agent response too large"));
      const lf = buffer.indexOf(10);
      if (lf < 0) return;
      try {
        const frame = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, lf),
          ),
        );
        if (typeof frame.ok !== "boolean")
          throw new Error("Invalid agent response");
        end(
          frame.ok
            ? undefined
            : new Error(frame.error || "Agent request failed"),
          frame.result,
        );
      } catch (error) {
        end(error as Error);
      }
    });
  });
}
export async function listen(
  path: string,
  authorize: (id: string, token: string, assignment: string) => void,
  dispatch: (
    id: string,
    operation: string,
    args: any,
    signal: AbortSignal,
  ) => Promise<unknown>,
): Promise<{ close(): Promise<void> }> {
  const connections = new Set<Socket>();
  let closing = false;
  const server: Server = createServer((socket) => {
    socket.on("error", () => {});
    if (closing || connections.size >= 512) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    const controller = new AbortController();
    let buffer = Buffer.alloc(0),
      dispatched = false;
    const timer = setTimeout(() => {
      if (!dispatched) socket.destroy();
    }, 15000);
    socket.once("close", () => {
      clearTimeout(timer);
      connections.delete(socket);
      controller.abort();
    });
    const respond = (frame: unknown) => {
      if (socket.destroyed) return;
      const output = JSON.stringify(frame);
      socket.end(
        (Buffer.byteLength(output) <= MAX_FRAME
          ? output
          : JSON.stringify({
              ok: false,
              error: "Agent response exceeds 512 KiB; inspect artifact files.",
            })) + "\n",
      );
    };
    socket.on("data", (chunk: Buffer) => {
      if (dispatched) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      const lf = buffer.indexOf(10);
      if (lf < 0) return;
      dispatched = true;
      clearTimeout(timer);
      Promise.resolve()
        .then(async () => {
          const frame = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              buffer.subarray(0, lf),
            ),
          );
          if (
            frame.version !== 1 ||
            typeof frame.agent !== "string" ||
            typeof frame.token !== "string" ||
            typeof frame.assignment !== "string" ||
            typeof frame.operation !== "string"
          )
            throw new Error("Invalid agent control frame");
          authorize(frame.agent, frame.token, frame.assignment);
          return dispatch(
            frame.agent,
            frame.operation,
            frame.args,
            controller.signal,
          );
        })
        .then(
          (result) => respond({ ok: true, result }),
          (error) =>
            respond({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return {
    close: async () => {
      closing = true;
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(path).catch(() => {});
    },
  };
}
