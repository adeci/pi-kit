import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface ProcessTerminationPlan {
  /** Delay from this request to SIGTERM. Omit to skip TERM. */
  termAfterMs?: number;
  /** Delay from this request to the mandatory SIGKILL fallback. */
  killAfterMs: number;
}

export interface ProcessGroupOwnerOptions {
  onDiagnostic?: (message: string) => void;
  pollIntervalMs?: number;
  reapGraceMs?: number;
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => boolean;
}

interface ScheduledSignal {
  dueAt: number;
  timer: ReturnType<typeof setTimeout>;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Owns the immutable process identity captured at spawn time.
 *
 * On POSIX, a detached child's PID is also its process-group ID. That ID is
 * retained after the leader closes so TERM/KILL can still reap descendants.
 * Ownership ends when the original group is gone, or after a short final reap
 * window following SIGKILL. No signal is sent after that window, bounding the
 * interval in which the captured ID can be used.
 */
export class ProcessGroupOwner {
  private readonly platform: NodeJS.Platform;
  private readonly killProcess: (
    pid: number,
    signal: NodeJS.Signals | 0,
  ) => boolean;
  private readonly pollIntervalMs: number;
  private readonly reapGraceMs: number;
  private readonly groupId?: number;
  private readonly scheduled = new Map<NodeJS.Signals, ScheduledSignal>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private reapDeadlineTimer?: ReturnType<typeof setTimeout>;
  private leaderHasClosed = false;
  private owned = true;
  private terminationRequested = false;
  private termSent = false;
  private killSent = false;
  private resolveReleased!: () => void;
  private resolveClosed!: () => void;
  readonly released: Promise<void>;
  readonly closed: Promise<void>;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly options: ProcessGroupOwnerOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.killProcess =
      options.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.reapGraceMs = options.reapGraceMs ?? 1_000;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("pollIntervalMs must be finite and positive");
    }
    if (!Number.isFinite(this.reapGraceMs) || this.reapGraceMs <= 0) {
      throw new Error("reapGraceMs must be finite and positive");
    }
    this.groupId =
      this.platform !== "win32" && child.pid ? child.pid : undefined;
    this.released = new Promise<void>((resolve) => {
      this.resolveReleased = resolve;
    });
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get isOwned(): boolean {
    return this.owned;
  }

  get hasTerminationRequest(): boolean {
    return this.terminationRequested;
  }

  get processGroupId(): number | undefined {
    return this.groupId;
  }

  /** Record the leader's close without discarding the captured group ID. */
  markLeaderClosed(): void {
    if (!this.leaderHasClosed) {
      this.leaderHasClosed = true;
      this.resolveClosed();
    }
    if (this.owned) this.probeAndSchedule();
  }

  /**
   * Merge a bounded escalation request. Repeated requests can only move a
   * signal earlier; they never postpone an already-owned cleanup.
   */
  requestTermination(plan: ProcessTerminationPlan): Promise<void> {
    if (!Number.isFinite(plan.killAfterMs) || plan.killAfterMs < 0) {
      throw new Error("killAfterMs must be finite and non-negative");
    }
    if (
      plan.termAfterMs !== undefined &&
      (!Number.isFinite(plan.termAfterMs) || plan.termAfterMs < 0)
    ) {
      throw new Error("termAfterMs must be finite and non-negative");
    }
    if (!this.owned) return this.released;
    this.terminationRequested = true;
    const now = Date.now();
    if (plan.termAfterMs !== undefined && !this.termSent && !this.killSent) {
      this.scheduleSignal("SIGTERM", now + plan.termAfterMs);
    }
    if (!this.killSent) this.scheduleSignal("SIGKILL", now + plan.killAfterMs);
    this.probeAndSchedule();
    return this.released;
  }

  private scheduleSignal(signal: NodeJS.Signals, dueAt: number): void {
    const existing = this.scheduled.get(signal);
    if (existing && existing.dueAt <= dueAt) return;
    if (existing) clearTimeout(existing.timer);
    const fire = () => {
      this.scheduled.delete(signal);
      this.sendSignal(signal);
    };
    const delay = Math.max(0, dueAt - Date.now());
    if (delay === 0) {
      fire();
      return;
    }
    this.scheduled.set(signal, { dueAt, timer: setTimeout(fire, delay) });
  }

  private sendSignal(signal: NodeJS.Signals): void {
    if (!this.owned || (signal === "SIGTERM" && this.killSent)) return;
    if (signal === "SIGTERM") this.termSent = true;
    if (signal === "SIGKILL") {
      this.killSent = true;
      const pendingTerm = this.scheduled.get("SIGTERM");
      if (pendingTerm) clearTimeout(pendingTerm.timer);
      this.scheduled.delete("SIGTERM");
    }

    if (this.groupId !== undefined) {
      try {
        this.killProcess(-this.groupId, signal);
      } catch (error) {
        if (errorCode(error) === "ESRCH") {
          this.release();
          return;
        }
        this.options.onDiagnostic?.(
          `Process-group ${signal} failed for PGID ${this.groupId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      try {
        if (!this.child.kill(signal)) {
          this.options.onDiagnostic?.(
            `Process ${signal} reported that no signal was sent.`,
          );
        }
      } catch (error) {
        this.options.onDiagnostic?.(
          `Process ${signal} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (signal === "SIGKILL" && this.owned) this.scheduleReapDeadline();
    this.probeAndSchedule();
  }

  private scheduleReapDeadline(): void {
    if (this.reapDeadlineTimer || !this.owned) return;
    this.reapDeadlineTimer = setTimeout(() => {
      this.reapDeadlineTimer = undefined;
      if (!this.owned) return;
      if (this.groupId !== undefined) {
        try {
          this.killProcess(-this.groupId, 0);
          this.options.onDiagnostic?.(
            `Process group PGID ${this.groupId} remained observable ${this.reapGraceMs}ms after SIGKILL; bounded ownership ended without further signaling.`,
          );
        } catch (error) {
          if (errorCode(error) === "ESRCH") {
            this.release();
            return;
          }
          this.options.onDiagnostic?.(
            `Final process-group probe failed for PGID ${this.groupId}: ${error instanceof Error ? error.message : String(error)}; bounded ownership ended.`,
          );
        }
      } else {
        this.options.onDiagnostic?.(
          `Process did not emit close within ${this.reapGraceMs}ms after SIGKILL; bounded ownership ended without further signaling.`,
        );
      }
      this.release();
    }, this.reapGraceMs);
  }

  private probeAndSchedule(): void {
    if (!this.owned) return;
    if (this.platform === "win32" || this.groupId === undefined) {
      if (this.leaderHasClosed) this.release();
      else if (this.terminationRequested) this.schedulePoll();
      return;
    }
    try {
      this.killProcess(-this.groupId, 0);
    } catch (error) {
      if (errorCode(error) === "ESRCH") {
        this.release();
        return;
      }
      if (errorCode(error) !== "EPERM") {
        this.options.onDiagnostic?.(
          `Process-group probe failed for PGID ${this.groupId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (this.terminationRequested || this.leaderHasClosed) this.schedulePoll();
  }

  private schedulePoll(): void {
    if (!this.owned || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      this.probeAndSchedule();
    }, this.pollIntervalMs);
  }

  private release(): void {
    if (!this.owned) return;
    this.owned = false;
    for (const pending of this.scheduled.values()) clearTimeout(pending.timer);
    this.scheduled.clear();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reapDeadlineTimer) clearTimeout(this.reapDeadlineTimer);
    this.pollTimer = undefined;
    this.reapDeadlineTimer = undefined;
    this.resolveReleased();
  }
}
