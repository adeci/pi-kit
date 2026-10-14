// Adapted from OMP 18.4.10. See ../OMP-LICENSE and ../README.md.
import { randomUUID } from "node:crypto";
import {
  active,
  continuation,
  budgetLimit,
  escapeXmlText,
  render,
} from "./prompts";
import type {
  Goal,
  GoalBudgetSteering,
  GoalModeState,
  GoalRuntimeEvent,
  GoalTokenUsage,
} from "./state";

export interface GoalRuntimeHost {
  getState(): GoalModeState | undefined;
  setState(state: GoalModeState | undefined): void;
  getCurrentUsage(): GoalTokenUsage;
  emit(event: GoalRuntimeEvent): void | Promise<void>;
  persist(mode: "goal" | "goal_paused" | "none", state?: GoalModeState): void;
  sendHiddenMessage(message: {
    customType: string;
    content: string;
    deliverAs?: "steer" | "followUp" | "nextTurn";
  }): Promise<void>;
  now?(): number;
}

export interface GoalTurnSnapshot {
  baselineUsage: GoalTokenUsage;
  activeGoalId?: string;
}

export interface GoalWallClockSnapshot {
  lastAccountedAt: number;
  activeGoalId?: string;
}

export type GoalPromptKind = "active" | "continuation" | "budget-limit";

function cloneGoal(goal: Goal): Goal {
  return { ...goal };
}

function cloneState(state: GoalModeState): GoalModeState {
  return { ...state, goal: cloneGoal(state.goal) };
}

function budgetValue(goal: Goal): string {
  return goal.tokenBudget === undefined ? "none" : String(goal.tokenBudget);
}

function remainingValue(goal: Goal): string {
  return goal.tokenBudget === undefined
    ? "unbounded"
    : String(Math.max(0, goal.tokenBudget - goal.tokensUsed));
}

export function remainingTokens(goal: Goal | null | undefined): number | null {
  if (!goal || goal.tokenBudget === undefined) return null;
  return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function goalTokenDelta(
  current: GoalTokenUsage,
  baseline: GoalTokenUsage,
): number {
  // Count fresh input, cache writes and output. Cached reads are not new work.
  return (
    Math.max(0, current.input - baseline.input) +
    Math.max(0, current.cacheWrite - baseline.cacheWrite) +
    Math.max(0, current.output - baseline.output)
  );
}

export function renderGoalPrompt(kind: GoalPromptKind, goal: Goal): string {
  const template =
    kind === "active"
      ? active
      : kind === "continuation"
        ? continuation
        : budgetLimit;
  return render(template, {
    objective: escapeXmlText(goal.objective),
    tokensUsed: String(goal.tokensUsed),
    tokenBudget: budgetValue(goal),
    remainingTokens: remainingValue(goal),
    timeUsedSeconds: String(goal.timeUsedSeconds),
  });
}

function validateTokenBudget(tokenBudget: number | undefined): void {
  if (
    tokenBudget !== undefined &&
    (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
  ) {
    throw new Error(
      "goal token_budget must be a positive integer when provided",
    );
  }
}

function isAccountingStatus(goal: Goal): boolean {
  return goal.status === "active" || goal.status === "budget-limited";
}

export class GoalRuntime {
  readonly #host: GoalRuntimeHost;
  #turnSnapshot: GoalTurnSnapshot | undefined;
  #wallClock: GoalWallClockSnapshot;
  #budgetReportedFor: string | undefined;
  #accountingTail: Promise<void> = Promise.resolve();

  constructor(host: GoalRuntimeHost) {
    this.#host = host;
    this.#wallClock = { lastAccountedAt: this.#now() };
  }

  #now(): number {
    return this.#host.now?.() ?? Date.now();
  }

  async #withAccounting<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.#accountingTail;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#accountingTail = previous.then(
      () => promise,
      () => promise,
    );
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      resolve();
    }
  }

  #getStateClone(): GoalModeState | undefined {
    const state = this.#host.getState();
    return state ? cloneState(state) : undefined;
  }

  async #commitState(
    state: GoalModeState | undefined,
    options?: { persist?: "goal" | "goal_paused" | "none"; emit?: boolean },
  ): Promise<void> {
    this.#host.setState(state ? cloneState(state) : undefined);
    if (options?.persist) {
      this.#host.persist(options.persist, state);
    }
    if (options?.emit !== false) {
      await this.#host.emit({
        type: "goal_updated",
        goal: state ? cloneGoal(state.goal) : null,
        state,
      });
    }
  }

  #markActiveAccounting(goal: Goal): void {
    if (this.#wallClock.activeGoalId !== goal.id) {
      this.#wallClock = { lastAccountedAt: this.#now(), activeGoalId: goal.id };
    }
    if (this.#turnSnapshot) {
      this.#turnSnapshot.activeGoalId = goal.id;
      this.#turnSnapshot.baselineUsage = { ...this.#host.getCurrentUsage() };
    }
  }

  #clearActiveAccounting(): void {
    this.#wallClock = { lastAccountedAt: this.#now() };
    if (this.#turnSnapshot) {
      this.#turnSnapshot.activeGoalId = undefined;
    }
  }

  onTurnStart(baselineUsage: GoalTokenUsage): void {
    this.#turnSnapshot = { baselineUsage: { ...baselineUsage } };
    const state = this.#host.getState();
    if (state?.enabled && isAccountingStatus(state.goal)) {
      this.#turnSnapshot.activeGoalId = state.goal.id;
      if (this.#wallClock.activeGoalId !== state.goal.id) {
        this.#wallClock = {
          lastAccountedAt: this.#now(),
          activeGoalId: state.goal.id,
        };
      }
    }
  }

  async onTaskAborted(options?: {
    reason?: "interrupted" | "internal";
  }): Promise<void> {
    const state = this.#host.getState();
    const needsAccounting = state?.enabled && isAccountingStatus(state.goal);
    const needsPause =
      options?.reason === "interrupted" &&
      state?.enabled &&
      state.goal.status === "active";
    if (!needsAccounting && !needsPause) {
      this.#turnSnapshot = undefined;
      return;
    }
    await this.#withAccounting(async () => {
      await this.#flushUsageLocked(
        "suppressed",
        undefined,
        options?.reason === "internal",
      );
      this.#turnSnapshot = undefined;
      if (options?.reason !== "interrupted") return;
      const cloned = this.#getStateClone();
      if (!cloned?.enabled || cloned.goal.status !== "active") return;
      cloned.enabled = false;
      cloned.goal.status = "paused";
      cloned.goal.updatedAt = this.#now();
      this.#clearActiveAccounting();
      this.#budgetReportedFor = undefined;
      await this.#commitState(cloned, { persist: "goal_paused" });
    });
  }

  async onThreadResumed(): Promise<GoalModeState | undefined> {
    const state = this.#getStateClone();
    if (!state) return undefined;
    if (state.goal.status === "active") {
      state.enabled = false;
      state.goal.status = "paused";
      state.goal.updatedAt = this.#now();
      this.#clearActiveAccounting();
      this.#budgetReportedFor = undefined;
      await this.#commitState(state, { persist: "goal_paused" });
      return state;
    }
    if (state.enabled && isAccountingStatus(state.goal)) {
      this.#markActiveAccounting(state.goal);
    } else {
      this.#clearActiveAccounting();
    }
    await this.#commitState(state, { emit: true });
    return state;
  }

  async onBudgetMutated(
    newBudget: number | undefined,
  ): Promise<GoalModeState | undefined> {
    validateTokenBudget(newBudget);
    return await this.#withAccounting(async () => {
      this.#budgetReportedFor = undefined;
      await this.#flushUsageLocked("suppressed");
      const state = this.#getStateClone();
      if (!state?.goal) return undefined;
      state.goal.tokenBudget = newBudget;
      state.goal.updatedAt = this.#now();
      let shouldSteer = false;
      if (newBudget !== undefined && state.goal.tokensUsed >= newBudget) {
        if (state.goal.status === "active") {
          state.goal.status = "budget-limited";
          shouldSteer = true;
        }
      } else if (state.goal.status === "budget-limited") {
        state.goal.status = "active";
        state.enabled = true;
        this.#markActiveAccounting(state.goal);
      }
      await this.#commitState(state, {
        persist: state.enabled ? "goal" : "goal_paused",
      });
      if (shouldSteer) {
        await this.#sendBudgetLimitSteer(state.goal);
      }
      return state;
    });
  }

  async #flushUsageLocked(
    steering: GoalBudgetSteering,
    currentUsage: GoalTokenUsage = this.#host.getCurrentUsage(),
    persistWallClock = false,
  ): Promise<void> {
    const state = this.#getStateClone();
    if (!state?.enabled || !isAccountingStatus(state.goal)) return;
    if (
      this.#turnSnapshot?.activeGoalId !== state.goal.id &&
      this.#wallClock.activeGoalId !== state.goal.id
    )
      return;

    const tokenDelta =
      this.#turnSnapshot?.activeGoalId === state.goal.id
        ? goalTokenDelta(currentUsage, this.#turnSnapshot.baselineUsage)
        : 0;
    const wallSeconds =
      this.#wallClock.activeGoalId === state.goal.id
        ? Math.max(
            0,
            Math.floor((this.#now() - this.#wallClock.lastAccountedAt) / 1000),
          )
        : 0;
    if (tokenDelta <= 0 && wallSeconds <= 0) return;

    state.goal.tokensUsed += tokenDelta;
    state.goal.timeUsedSeconds += wallSeconds;
    state.goal.updatedAt = this.#now();
    const flippedToBudgetLimited =
      state.goal.tokenBudget !== undefined &&
      state.goal.tokensUsed >= state.goal.tokenBudget &&
      state.goal.status === "active";
    if (flippedToBudgetLimited) {
      state.goal.status = "budget-limited";
    }

    if (this.#turnSnapshot?.activeGoalId === state.goal.id) {
      this.#turnSnapshot.baselineUsage = { ...currentUsage };
    }
    if (this.#wallClock.activeGoalId === state.goal.id && wallSeconds > 0) {
      this.#wallClock.lastAccountedAt += wallSeconds * 1000;
    }
    // Persisting wall-clock-only accounting on every tool event bloats /goal sessions with full
    // objective snapshots. Keep normal tool flushes in memory/UI only, but make wall-clock
    // usage durable before internal session switches because the active runtime is leaving.
    const shouldPersistUsage =
      tokenDelta > 0 ||
      flippedToBudgetLimited ||
      (persistWallClock && wallSeconds > 0);
    await this.#commitState(state, {
      persist: shouldPersistUsage ? "goal" : undefined,
    });

    if (state.goal.status !== "budget-limited") {
      this.#budgetReportedFor = undefined;
    }
    if (
      steering === "allowed" &&
      flippedToBudgetLimited &&
      this.#budgetReportedFor !== state.goal.id
    ) {
      await this.#sendBudgetLimitSteer(state.goal);
    }
  }

  async flushUsage(
    steering: GoalBudgetSteering,
    currentUsage: GoalTokenUsage = this.#host.getCurrentUsage(),
  ): Promise<void> {
    await this.#withAccounting(() =>
      this.#flushUsageLocked(steering, currentUsage),
    );
  }

  #createGoalState(
    objective: string,
    tokenBudget: number | undefined,
  ): GoalModeState {
    const now = this.#now();
    const goal: Goal = {
      id: randomUUID(),
      objective,
      status: "active",
      tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };
    return { enabled: true, mode: "active", goal };
  }

  async createGoal(input: {
    objective: string;
    tokenBudget?: number;
    paused?: boolean;
  }): Promise<GoalModeState> {
    const objective = input.objective.trim();
    if (!objective) throw new Error("objective is required when op=create");
    validateTokenBudget(input.tokenBudget);
    return await this.#withAccounting(async () => {
      const existing = this.#host.getState();
      if (
        existing?.goal &&
        existing.goal.status !== "dropped" &&
        existing.goal.status !== "complete"
      ) {
        throw new Error(
          "cannot create a new goal because this session already has a goal",
        );
      }
      const state = this.#createGoalState(objective, input.tokenBudget);
      this.#budgetReportedFor = undefined;
      if (input.paused) {
        state.enabled = false;
        state.goal.status = "paused";
        this.#clearActiveAccounting();
      } else {
        this.#markActiveAccounting(state.goal);
      }
      await this.#commitState(state, {
        persist: input.paused ? "goal_paused" : "goal",
      });
      return state;
    });
  }

  async resumeGoal(): Promise<GoalModeState> {
    return await this.#withAccounting(async () => {
      const state = this.#getStateClone();
      if (!state?.goal) throw new Error("No paused goal.");
      if (state.goal.status === "complete" || state.goal.status === "dropped")
        throw new Error(
          "Create a new goal instead of resuming a terminal goal.",
        );
      if (
        state.goal.tokenBudget !== undefined &&
        state.goal.tokensUsed >= state.goal.tokenBudget
      )
        throw new Error("Increase the token budget before resuming.");
      state.enabled = true;
      state.mode = "active";
      state.reason = undefined;
      state.goal.status = "active";
      state.goal.updatedAt = this.#now();
      this.#budgetReportedFor = undefined;
      this.#markActiveAccounting(state.goal);
      await this.#commitState(state, { persist: "goal" });
      return state;
    });
  }

  async pauseGoal(): Promise<GoalModeState | undefined> {
    return await this.#withAccounting(async () => {
      await this.#flushUsageLocked("suppressed");
      const state = this.#getStateClone();
      if (!state?.goal) return undefined;
      state.enabled = false;
      state.mode = "active";
      state.reason = undefined;
      if (
        state.goal.status === "active" ||
        state.goal.status === "budget-limited"
      ) {
        state.goal.status = "paused";
      }
      state.goal.updatedAt = this.#now();
      this.#clearActiveAccounting();
      this.#budgetReportedFor = undefined;
      await this.#commitState(state, { persist: "goal_paused" });
      return state;
    });
  }

  async dropGoal(): Promise<Goal | undefined> {
    return await this.#withAccounting(async () => {
      await this.#flushUsageLocked("suppressed");
      const state = this.#getStateClone();
      if (!state?.goal) return undefined;
      const dropped = {
        ...state.goal,
        status: "dropped" as const,
        updatedAt: this.#now(),
      };
      this.#clearActiveAccounting();
      this.#budgetReportedFor = undefined;
      await this.#host.emit({
        type: "goal_updated",
        goal: dropped,
        state: { ...state, enabled: false, goal: dropped },
      });
      await this.#commitState(undefined, { persist: "none", emit: false });
      return dropped;
    });
  }

  async completeGoalFromTool(evidence: string[]): Promise<Goal> {
    if (!evidence.length || evidence.some((item) => !item.trim()))
      throw new Error("Completion requires current-state evidence.");
    return await this.#withAccounting(async () => {
      await this.#flushUsageLocked("suppressed");
      const state = this.#getStateClone();
      if (!state?.goal) {
        throw new Error("cannot complete goal because no goal is active");
      }
      if (state.goal.status === "complete") {
        throw new Error("goal is already complete");
      }
      if (state.goal.status === "dropped") {
        throw new Error("cannot complete a dropped goal");
      }
      state.enabled = false;
      state.goal.status = "complete";
      state.goal.evidence = evidence;
      state.goal.updatedAt = this.#now();
      state.mode = "exiting";
      state.reason = "completed";
      this.#clearActiveAccounting();
      this.#budgetReportedFor = undefined;
      await this.#commitState(state, { persist: "goal" });
      return state.goal;
    });
  }

  buildActivePrompt(): string | undefined {
    const state = this.#host.getState();
    return state?.enabled && state.goal && state.goal.status === "active"
      ? renderGoalPrompt("active", state.goal)
      : undefined;
  }

  buildContinuationPrompt(): string | undefined {
    const state = this.#host.getState();
    return state?.enabled && state.goal.status === "active"
      ? renderGoalPrompt("continuation", state.goal)
      : undefined;
  }

  async #sendBudgetLimitSteer(goal: Goal): Promise<void> {
    if (this.#budgetReportedFor === goal.id) return;
    this.#budgetReportedFor = goal.id;
    await this.#host.sendHiddenMessage({
      customType: "goal-budget-limit",
      content: renderGoalPrompt("budget-limit", goal),
      deliverAs: "steer",
    });
  }
}
