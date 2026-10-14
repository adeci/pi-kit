import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { choose, editText } from "../../ui/menu";
import { singleLine } from "../../ui/style";
import type { GoalRuntime } from "./runtime";
import type { GoalModeState } from "./state";

export async function goalMenu(
  ctx: ExtensionCommandContext,
  runtime: GoalRuntime,
  getState: () => GoalModeState | undefined,
  start: (objective: string) => Promise<boolean>,
  account: () => Promise<void>,
  continueGoal: () => void,
  guided: (rough: string) => void,
) {
  let selected = "objective";
  for (;;) {
    await account();
    const goal = getState()?.goal;
    const field = await choose(
      ctx,
      "Goal",
      [
        {
          value: "objective",
          label: goal ? "Objective / replace" : "New objective",
          description: goal
            ? singleLine(goal.objective)
            : "Save an objective, set an optional budget, then Start",
        },
        {
          value: "guided",
          label: "Guided setup",
          description:
            "Interview for success criteria, verification, boundaries and stop conditions",
        },
        ...(goal
          ? [
              {
                value: "state",
                label: `State: ${goal.status}`,
                description: `${goal.tokensUsed.toLocaleString()} parent tokens · ${goal.timeUsedSeconds}s · completion is model-declared`,
              },
              {
                value: "budget",
                label: "Token budget",
                description:
                  goal.tokenBudget?.toLocaleString() ??
                  "None · parent tokens only, not a spending cap",
              },
              {
                value: "pause",
                label: "Pause",
                description:
                  "Pause parent pursuit; workers and durable jobs continue",
              },
              {
                value: "resume",
                label: goal.tokensUsed ? "Resume" : "Start",
                description: "Explicitly continue the saved objective",
              },
              {
                value: "drop",
                label: "Drop goal",
                description:
                  "Clear the goal without claiming success; history remains stored",
              },
            ]
          : []),
      ],
      selected,
    );
    if (!field) return;
    selected = field;
    try {
      if (field === "objective") {
        const text = await editText(
          ctx,
          "Goal objective",
          goal?.objective ?? "",
        );
        if (
          text !== undefined &&
          text !== goal?.objective &&
          (await start(text))
        ) {
          selected = "resume";
        }
      } else if (field === "guided") {
        const rough = await editText(ctx, "Guided goal: rough idea");
        if (rough !== undefined) {
          guided(rough);
          return;
        }
      } else if (field === "budget") {
        const text = await editText(
          ctx,
          "Goal token budget",
          String(goal?.tokenBudget ?? ""),
          "Positive integer · blank removes the cap · Enter saves · Esc discards",
        );
        if (text !== undefined) {
          const value = text.trim() ? Number(text) : undefined;
          if (
            value !== undefined &&
            (!Number.isSafeInteger(value) || value <= 0)
          )
            throw new Error(
              "Use a positive integer or leave the budget blank.",
            );
          await runtime.onBudgetMutated(value);
        }
      } else if (field === "pause") {
        ctx.abort();
        await ctx.waitForIdle();
        await runtime.pauseGoal();
      } else if (field === "resume") {
        if (!ctx.isIdle() || ctx.hasPendingMessages())
          throw new Error("Wait for current work before resuming the goal.");
        await runtime.resumeGoal();
        continueGoal();
        return;
      } else if (
        field === "drop" &&
        (await ctx.ui.confirm(
          "Drop goal?",
          "The objective will no longer drive automatic continuation.",
        ))
      ) {
        ctx.abort();
        await ctx.waitForIdle();
        await runtime.dropGoal();
      }
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Goal operation failed.",
        "error",
      );
    }
  }
}
