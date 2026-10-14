import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MAX_PENDING_RPC_REQUESTS,
  MAX_RPC_LINE_BYTES,
  RPC_REQUEST_TIMEOUT_MS,
} from "./limits.ts";

interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RpcTransportOptions {
  idPrefix: string;
  onEvent: (record: Record<string, unknown>) => void;
  onRecord?: (record: Record<string, unknown>, rawLine: string) => void;
  onDiagnostic: (message: string) => void;
  onStderr: (text: string) => void;
  onProtocolFailure: (error: Error) => void;
  onClose: (exit: ProcessExit) => void;
  maxLineBytes?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function correlatedResponseError(
  record: Record<string, unknown>,
  id: string,
  pending: PendingRequest,
): string | undefined {
  if (record.type !== "response")
    return `Correlated Pi RPC record ${id} was not a response.`;
  if (typeof record.id !== "string")
    return `Correlated Pi RPC response ${id} had a non-string id.`;
  if (typeof record.command !== "string")
    return `Correlated Pi RPC response ${id} had a non-string command.`;
  if (record.command !== pending.command) {
    return `Expected ${pending.command} response, received ${record.command}.`;
  }
  if (typeof record.success !== "boolean")
    return `Correlated Pi RPC response ${id} had a non-boolean success field.`;
  const hasError = Object.prototype.hasOwnProperty.call(record, "error");
  if (hasError && typeof record.error !== "string")
    return `Correlated Pi RPC response ${id} had a non-string error field.`;
  if (record.success && hasError)
    return `Successful Pi RPC response ${id} unexpectedly included an error.`;
  if (!record.success && !hasError)
    return `Failed Pi RPC response ${id} did not include an error string.`;
  return undefined;
}

/** Strict-LF, bounded, correlated Pi RPC transport. */
export class RpcTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private sequence = 0;
  private fatalError?: Error;
  private exited = false;
  private readonly maxLineBytes: number;
  readonly closed: Promise<ProcessExit>;
  private resolveClosed!: (exit: ProcessExit) => void;

  constructor(
    readonly process: ChildProcessWithoutNullStreams,
    private readonly options: RpcTransportOptions,
  ) {
    this.maxLineBytes = options.maxLineBytes ?? MAX_RPC_LINE_BYTES;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });

    process.stdin.on("error", (error) =>
      this.fail(new Error(`Child stdin failed: ${error.message}`)),
    );
    process.stdout.on("data", (chunk: Buffer | string) =>
      this.consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    process.stdout.on("end", () => this.consumeFinalStdout());
    process.stdout.on("error", (error) =>
      this.protocolFailure(`Child stdout failed: ${error.message}`),
    );
    process.stderr.on("data", (chunk: Buffer | string) =>
      options.onStderr(chunk.toString()),
    );
    process.stderr.on("error", (error) =>
      options.onDiagnostic(`Child stderr failed: ${error.message}`),
    );
    process.once("error", (error) => {
      const wrapped = new Error(`Could not start Pi child: ${error.message}`);
      this.fail(wrapped);
      options.onProtocolFailure(wrapped);
    });
    process.once("close", (code, signal) => {
      this.exited = true;
      this.consumeFinalStdout();
      const exit = { code, signal };
      this.fail(
        this.fatalError ??
          new Error(`Pi child exited (code=${code}, signal=${signal})`),
      );
      this.resolveClosed(exit);
      options.onClose(exit);
    });
  }

  async request(
    command: string,
    fields: Record<string, unknown> = {},
    timeoutMs = RPC_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("RPC timeout must be finite and positive");
    if (this.fatalError) throw this.fatalError;
    if (
      this.exited ||
      this.process.stdin.destroyed ||
      !this.process.stdin.writable
    ) {
      throw new Error("Pi child RPC stdin is unavailable");
    }
    if (this.pending.size >= MAX_PENDING_RPC_REQUESTS) {
      throw new Error(
        `Pi child has ${this.pending.size} pending RPC requests; limit is ${MAX_PENDING_RPC_REQUESTS}`,
      );
    }

    const id = `${this.options.idPrefix}:${++this.sequence}`;
    const payload = `${JSON.stringify({ ...fields, id, type: command })}\n`;
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(
          new Error(`Timed out waiting for Pi RPC response to ${command}`),
        );
      }, timeoutMs);
      this.pending.set(id, { command, resolve, reject, timer });
      this.process.stdin.write(payload, (error) => {
        if (!error) return;
        const pending = this.takePending(id);
        pending?.reject(
          new Error(
            `Could not write Pi RPC command ${command}: ${error.message}`,
          ),
        );
      });
    });
    if (!response.success)
      throw new Error(response.error || `Pi RPC command ${command} failed`);
    return response.data;
  }

  closeInput(): void {
    if (!this.process.stdin.destroyed && this.process.stdin.writable)
      this.process.stdin.end();
  }

  rejectPending(error: Error): void {
    this.fail(error);
  }

  private takePending(id: string): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.fatalError) return;
    const buffer = this.stdoutBuffer.length
      ? Buffer.concat([this.stdoutBuffer, chunk])
      : chunk;
    let start = 0;
    while (true) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline < 0) break;
      const raw = buffer.subarray(start, newline);
      if (raw.length > this.maxLineBytes) {
        this.protocolFailure(
          `Pi RPC record exceeded ${this.maxLineBytes} bytes`,
        );
        return;
      }
      const line =
        raw.length > 0 && raw[raw.length - 1] === 0x0d
          ? raw.subarray(0, -1)
          : raw;
      this.handleLine(line);
      if (this.fatalError) return;
      start = newline + 1;
    }
    this.stdoutBuffer = Buffer.from(buffer.subarray(start));
    if (this.stdoutBuffer.length > this.maxLineBytes) {
      this.protocolFailure(
        `Pi RPC pending record exceeded ${this.maxLineBytes} bytes`,
      );
    }
  }

  private consumeFinalStdout(): void {
    if (this.stdoutBuffer.length === 0 || this.fatalError) {
      this.stdoutBuffer = Buffer.alloc(0);
      return;
    }
    if (this.stdoutBuffer.length > this.maxLineBytes) {
      this.protocolFailure(
        `Pi RPC final record exceeded ${this.maxLineBytes} bytes`,
      );
    } else {
      const line =
        this.stdoutBuffer.at(-1) === 0x0d
          ? this.stdoutBuffer.subarray(0, -1)
          : this.stdoutBuffer;
      this.handleLine(line);
    }
    this.stdoutBuffer = Buffer.alloc(0);
  }

  private handleLine(line: Buffer): void {
    if (line.length === 0) return;
    let rawLine: string;
    let value: unknown;
    try {
      rawLine = new TextDecoder("utf-8", { fatal: true }).decode(line);
      value = JSON.parse(rawLine);
    } catch (error) {
      this.protocolFailure(
        `Invalid Pi RPC JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const record = asRecord(value);
    if (!record) {
      this.protocolFailure("Invalid Pi RPC record: expected an object");
      return;
    }
    this.options.onRecord?.(record, rawLine);

    const id = typeof record.id === "string" ? record.id : undefined;
    const pending = id ? this.pending.get(id) : undefined;
    if (id && pending) {
      const violation = correlatedResponseError(record, id, pending);
      if (violation) {
        this.protocolFailure(violation);
        return;
      }
      this.takePending(id)?.resolve(record as unknown as RpcResponse);
      return;
    }

    if (record.type === "response") {
      if (!id) {
        this.options.onDiagnostic(
          "Ignored uncorrelated Pi RPC response without a string id.",
        );
        return;
      }
      this.options.onDiagnostic(
        `Ignored stale or duplicate Pi RPC response ${id}.`,
      );
      return;
    }
    this.options.onEvent(record);
  }

  private protocolFailure(message: string): void {
    const error = new Error(message);
    this.fail(error);
    this.options.onProtocolFailure(error);
  }

  private fail(error: Error): void {
    this.fatalError ??= error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(this.fatalError);
    }
  }
}
