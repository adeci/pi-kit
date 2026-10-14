// Adapted from OMP 18.4.10; see ../OMP-LICENSE.
export type GoalStatus =
  "active" | "paused" | "budget-limited" | "complete" | "dropped";
export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  evidence?: string[];
}
export interface GoalModeState {
  enabled: boolean;
  mode: "active" | "exiting";
  reason?: "completed";
  goal: Goal;
}
export type GoalTokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalRuntimeEvent =
  | { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
  | { type: "goal_continuation_requested"; prompt: string };
export const entryType = "pi-kit:goal:v1";

export function validState(value: unknown): value is GoalModeState {
  const state = value as GoalModeState | undefined;
  const goal = state?.goal;
  return Boolean(
    state &&
    typeof state.enabled === "boolean" &&
    ["active", "exiting"].includes(state.mode) &&
    goal &&
    typeof goal.id === "string" &&
    typeof goal.objective === "string" &&
    goal.objective.trim() &&
    goal.objective.length <= 65536 &&
    ["active", "paused", "budget-limited", "complete", "dropped"].includes(
      goal.status,
    ) &&
    [
      goal.tokensUsed,
      goal.timeUsedSeconds,
      goal.createdAt,
      goal.updatedAt,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) &&
    (goal.tokenBudget === undefined ||
      (Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0)),
  );
}
