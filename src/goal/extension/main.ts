import { Type } from "typebox";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { GoalRuntime } from "./runtime";
import {
  entryType,
  validState,
  type GoalModeState,
  type GoalTokenUsage,
} from "./state";
import { guided, render, escapeXmlText } from "./prompts";
import { goalMenu } from "./ui";

export function usage(entries: readonly any[]): GoalTokenUsage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of entries) {
    const value =
      entry.type === "message"
        ? entry.message?.usage
        : ["usage", "compaction", "branch_summary"].includes(entry.type)
          ? entry.usage
          : undefined;
    for (const key of Object.keys(total) as (keyof GoalTokenUsage)[])
      if (Number.isFinite(value?.[key]) && value[key] > 0)
        total[key] += value[key];
  }
  return total;
}
export function blockedTodos(entries: readonly any[]) {
  const data = entries.findLast(
    (entry) =>
      entry.type === "custom" && entry.customType === "pi-kit:todos:v1",
  )?.data;
  const tasks = Array.isArray(data?.phases)
    ? data.phases.flatMap((phase: any) =>
        Array.isArray(phase.tasks) ? phase.tasks : [],
      )
    : [];
  return (
    tasks.some((task: any) => task.status === "blocked") &&
    !tasks.some((task: any) => ["pending", "in_progress"].includes(task.status))
  );
}
export default function install(pi: ExtensionAPI) {
  let claimed = false;
  pi.events.emit("pi-kit:claim:goal", () => {
    claimed = true;
  });
  if (claimed) return;
  const unclaim = pi.events.on("pi-kit:claim:goal", (reply: unknown) => {
    if (typeof reply === "function") reply();
  });
  let state: GoalModeState | undefined,
    runtime: GoalRuntime | undefined,
    ctx: ExtensionContext | undefined;
  let epoch = 0,
    prompts = 0,
    inputPending = false,
    guidedSetup = false,
    menuOpen = false;
  let waiting: string | undefined;
  let runGoal = false;
  let goalSeen = false;
  let budgetNotice: string | undefined;
  let removeInput: (() => void) | undefined;
  const checkEpoch = (expected: number) => {
    if (expected !== epoch)
      throw new Error("Goal operation belongs to a closed session.");
  };
  const currentUsage = () => usage(ctx?.sessionManager.getBranch() ?? []);
  const display = () => {
    if (!ctx) return;
    const goal = state?.goal;
    if (guidedSetup && !state?.enabled) {
      ctx.ui.setStatus("pi-kit-goal", "Goal setup · interview");
      return;
    }
    ctx.ui.setStatus(
      "pi-kit-goal",
      goal
        ? `Goal ${goal.status}${goal.status === "active" && waiting ? ` · ${waiting}` : ""} · ${goal.tokensUsed.toLocaleString()}${goal.tokenBudget ? `/${goal.tokenBudget.toLocaleString()}` : ""} parent tokens`
        : undefined,
    );
  };
  const account = async () => {
    if (!runtime || !state?.enabled) return;
    await runtime.flushUsage("suppressed", currentUsage());
  };
  const start = async (objective: string, paused = false) => {
    if (!runtime || !objective.trim() || objective.length > 65536)
      throw new Error("Use a nonempty objective of at most 65536 characters.");
    if (!ctx?.isIdle() || ctx.hasPendingMessages())
      throw new Error("Wait for current work before replacing the objective.");
    const generation = epoch;
    const owner = runtime;
    await account();
    checkEpoch(generation);
    if (state && !["complete", "dropped"].includes(state.goal.status)) {
      if (
        !ctx?.hasUI ||
        !(await ctx.ui.confirm(
          "Replace goal?",
          "This replaces the objective and resets its counters.",
        ))
      )
        return false;
      checkEpoch(generation);
      await owner.dropGoal();
    }
    checkEpoch(generation);
    await owner.createGoal({ objective, paused });
    checkEpoch(generation);
    inputPending = false;
    return true;
  };
  const beginGuided = (rough: string) => {
    if (state && !["complete", "dropped"].includes(state.goal.status))
      throw new Error(
        "Drop the existing goal through /goal before starting a guided goal.",
      );
    guidedSetup = true;
    inputPending = false;
    display();
    pi.sendUserMessage(
      render(guided, {
        initial: escapeXmlText(
          rough.slice(0, 65536) || "Ask what the user wants to achieve.",
        ),
      }),
      { deliverAs: "followUp" },
    );
  };
  pi.on("session_start", async (_event, context) => {
    ctx = context;
    const generation = ++epoch;
    state = undefined;
    runGoal = false;
    menuOpen = false;
    prompts = 0;
    inputPending = false;
    guidedSetup = false;
    goalSeen = ctx.sessionManager
      .getBranch()
      .some(
        (entry) => entry.type === "custom" && entry.customType === entryType,
      );
    for (const entry of ctx.sessionManager.getBranch())
      if (entry.type === "custom" && entry.customType === entryType)
        state = validState((entry.data as any)?.state)
          ? structuredClone((entry.data as any).state)
          : undefined;
    runtime = new GoalRuntime({
      getState: () => (generation === epoch ? state : undefined),
      setState: (next) => {
        if (generation !== epoch) return;
        goalSeen ||= Boolean(next);
        const changed =
          next?.goal.id !== state?.goal.id ||
          next?.goal.status !== state?.goal.status;
        if (next?.enabled && next.goal.status === "active") runGoal = true;
        state = next;
        if (changed)
          pi.sendMessage(
            {
              customType: "pi-kit:goal:mode",
              content:
                next?.enabled && next.goal.status === "active"
                  ? "Goal pursuit is active. Use the current saved objective; goal({op: 'get'}) returns its full text and budget."
                  : `Goal pursuit is ${next?.goal.status ?? "off"}. Do not continue the saved objective on your own. Respond to new user requests normally; resumption requires an explicit action.`,
              display: false,
            },
            { triggerTurn: false },
          );
      },
      getCurrentUsage: currentUsage,
      persist: (mode, next) => {
        if (generation === epoch)
          pi.appendEntry(entryType, { mode, state: next ?? null });
      },
      emit: (event) => {
        if (generation !== epoch) return;
        display();
        if (event.type === "goal_updated") {
          if (
            event.goal?.status === "budget-limited" &&
            budgetNotice !== event.goal.id
          ) {
            budgetNotice = event.goal.id;
            ctx?.ui.notify(
              "Goal token budget reached. No automatic continuation; review /goal to adjust or stop.",
              "warning",
            );
          } else if (event.goal?.status !== "budget-limited")
            budgetNotice = undefined;
        }
      },
      sendHiddenMessage: async (message) => {
        if (generation === epoch)
          pi.sendMessage(
            { ...message, display: false },
            { deliverAs: message.deliverAs, triggerTurn: false },
          );
      },
    });
    await runtime.onThreadResumed();
    removeInput?.();
    if (ctx.mode === "tui")
      removeInput = ctx.ui.onTerminalInput((data) => {
        // Mouse motion/scrolling and empty-editor navigation are not draft input.
        if (/^\u001b\[<\d+;\d+;\d+[Mm]$/.test(data)) return;
        const navigation = [
          "up",
          "down",
          "left",
          "right",
          "pageUp",
          "pageDown",
          "home",
          "end",
        ] as const;
        if (
          !ctx?.ui.getEditorText().trim() &&
          navigation.some((key) => matchesKey(data, key))
        )
          return;
        if (!menuOpen && !prompts) inputPending = true;
      });
    display();
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") inputPending = false;
  });
  pi.on("ui_prompt_start", () => {
    prompts++;
  });
  pi.on("ui_prompt_end", () => {
    prompts = Math.max(0, prompts - 1);
  });
  pi.on("before_agent_start", () => {
    waiting = undefined;
    runGoal = state?.goal.status === "active";
    const prompt = runtime?.buildActivePrompt();
    if (prompt)
      return {
        message: {
          customType: "pi-kit:goal:context",
          content:
            prompt +
            "\nIf director mode is active, delegate execution and verification commands; inspect worker evidence yourself. Use goal pause when blocked on human input.",
          display: false,
        },
      };
  });
  // Result-driven turns need current policy too; they bypass before_agent_start.
  pi.on("context", (event) => {
    if (!goalSeen && !guidedSetup) return;
    const content =
      guidedSetup && !state?.enabled
        ? "Guided goal setup is active. Ask one concise question at a time; do not inspect, implement or delegate. Create the goal only when ready for user confirmation."
        : (runtime?.buildActivePrompt() ??
          `Current goal state: ${state?.goal.status ?? "off"}. Do not continue the saved objective without explicit resumption. Handle new user requests normally.`);
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: "pi-kit:goal:current",
          content,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.on("agent_start", () => {
    waiting = undefined;
    display();
  });
  pi.on("turn_start", async (_event, context) => {
    const generation = epoch;
    await account();
    if (generation !== epoch) return;
    // Flush the preceding turn (including compaction), then start one snapshot
    // for this actual model turn. Ordinary checkpoints never reset its baseline.
    runtime?.onTurnStart(currentUsage());
    if (runGoal && state?.enabled && state.goal.status === "budget-limited")
      context.abort();
  });
  pi.on("turn_end", async (event) => {
    const generation = epoch;
    await account();
    if (generation !== epoch) return;
    if (event.outcome === "aborted")
      await runtime?.onTaskAborted({ reason: "interrupted" });
  });
  pi.on("tool_call", async (event) => {
    if (
      guidedSetup &&
      !state?.enabled &&
      event.toolName !== "ask" &&
      (event.toolName !== "goal" ||
        !["get", "create"].includes(String(event.input.op)))
    ) {
      return {
        block: true,
        reason:
          "Guided goal setup is an interview. Ask the user; do not inspect, implement or delegate until the goal is confirmed.",
      };
    }
    const generation = epoch;
    await account();
    if (generation !== epoch) return;
    if (
      state?.enabled &&
      state.goal.status === "budget-limited" &&
      event.toolName !== "goal" &&
      event.toolName !== "ask"
    )
      return {
        block: true,
        reason:
          "Goal token budget reached. Pause, complete with evidence, or ask the user to adjust the budget.",
      };
  });
  pi.on("tool_result", async (event) => {
    if (
      event.toolName !== "ask" ||
      !event.details ||
      typeof event.details !== "object" ||
      !("status" in event.details) ||
      (event.details.status !== "cancelled" &&
        event.details.status !== "unavailable")
    )
      return;
    const generation = epoch;
    const owner = runtime;
    await account();
    if (generation !== epoch) return;
    guidedSetup = false;
    if (state?.goal.status === "active") await owner?.pauseGoal();
    display();
  });
  pi.on("agent_before_settle", async (event, context) => {
    const generation = epoch;
    await account();
    if (generation !== epoch) return;
    if (!runtime || !state?.enabled || state.goal.status !== "active") return;
    if (event.outcome !== "completed" || context.signal?.aborted) {
      await runtime.pauseGoal();
      return;
    }
    if (blockedTodos(context.sessionManager.getBranch())) {
      await runtime.pauseGoal();
      context.ui.notify(
        "Goal paused: all remaining todo work is blocked.",
        "warning",
      );
      return;
    }
    // canContinue describes the current preview, which normally ends with an
    // assistant message. Our draft below supplies the user-like continuation.
    waiting =
      event.continue || context.hasPendingMessages()
        ? "queued work"
        : prompts || menuOpen
          ? "settings open"
          : inputPending ||
              (context.mode === "tui" && context.ui.getEditorText().trim())
            ? "user input"
            : undefined;
    display();
    if (waiting) return;
    let workers = 0;
    pi.events.emit("pi-kit:agents:query", (value: any) => {
      workers = value.active ?? 0;
    });
    if (workers) {
      waiting = "waiting for workers";
      display();
      return;
    } // Existing result delivery supplies the next turn.
    const prompt = runtime.buildContinuationPrompt();
    if (!prompt) return;
    return {
      entries: [
        {
          type: "custom_message" as const,
          customType: "pi-kit:goal:continue",
          content: prompt,
          display: false,
        },
      ],
      continue: true,
    };
  });
  pi.registerCommand("goal", {
    description:
      "Goal controls: objective, token budget, pause/resume, replace and drop",
    handler: async (args, context) => {
      if (!runtime || menuOpen) return;
      const generation = epoch;
      ctx = context;
      if (args.trim()) {
        if (await start(args))
          pi.sendUserMessage("Work toward the active goal.", {
            deliverAs: "followUp",
          });
        return;
      }
      if (context.mode !== "tui") {
        context.ui.notify(
          "Use /goal <objective> to start; the control menu requires the terminal UI.",
          "info",
        );
        return;
      }
      menuOpen = true;
      try {
        await goalMenu(
          context,
          runtime,
          () => (generation === epoch ? state : undefined),
          (objective) => {
            checkEpoch(generation);
            return start(objective, true);
          },
          async () => {
            checkEpoch(generation);
            await account();
          },
          () => {
            checkEpoch(generation);
            inputPending = false;
            pi.sendUserMessage("Continue the active goal.", {
              deliverAs: "followUp",
            });
          },
          (rough) => {
            checkEpoch(generation);
            beginGuided(rough);
          },
        );
      } catch (error) {
        if (generation === epoch)
          context.ui.notify(
            error instanceof Error ? error.message : "Goal operation failed.",
            "error",
          );
      } finally {
        if (generation === epoch) {
          menuOpen = false;
          display();
        }
      }
    },
  });
  pi.registerCommand("guided-goal", {
    description:
      "Interview for success criteria, verification, boundaries and stop conditions",
    handler: async (args, context) => {
      try {
        beginGuided(args);
      } catch (error) {
        context.ui.notify(
          error instanceof Error
            ? error.message
            : "Could not start guided goal.",
          "warning",
        );
      }
    },
  });
  pi.registerTool({
    name: "goal",
    label: "Goal",
    description:
      "Inspect or control the session goal. Complete only with current-state evidence for every deliverable, never because a budget ran out. Pause when blocked on human input. Completion is a model declaration, not independent verification. Creation is reserved for a user-requested guided-goal interview; resume/drop require user confirmation.",
    parameters: Type.Object({
      op: Type.Union(
        ["create", "get", "complete", "resume", "drop", "pause"].map((value) =>
          Type.Literal(value),
        ),
      ),
      objective: Type.Optional(Type.String({ minLength: 1, maxLength: 65536 })),
      token_budget: Type.Optional(Type.Integer({ minimum: 1 })),
      evidence: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), {
          minItems: 1,
          maxItems: 64,
        }),
      ),
      reason: Type.Optional(Type.String({ maxLength: 4000 })),
    }),
    async execute(_id, args, _signal, _update, context) {
      if (!runtime) throw new Error("Goal runtime is not attached.");
      const generation = epoch;
      const owner = runtime;
      await account();
      checkEpoch(generation);
      _signal?.throwIfAborted();
      if (["create", "resume", "drop"].includes(args.op)) {
        if (args.op === "create" && !guidedSetup)
          throw new Error("The user must start /goal or /guided-goal first.");
        if (
          !context.hasUI ||
          !(await context.ui.confirm(
            `Goal: ${args.op}?`,
            args.op === "create"
              ? `${args.objective ?? "Missing objective"}\nToken budget: ${args.token_budget ?? "none"}`
              : `Confirm ${args.op} of the current goal.`,
          ))
        )
          throw new Error("Goal change was not approved.");
      }
      checkEpoch(generation);
      _signal?.throwIfAborted();
      if (args.op === "create") {
        await owner.createGoal({
          objective: args.objective ?? "",
          tokenBudget: args.token_budget,
        });
        checkEpoch(generation);
        guidedSetup = false;
        inputPending = false;
      } else if (args.op === "resume") {
        await owner.resumeGoal();
        checkEpoch(generation);
        inputPending = false;
      } else if (args.op === "drop") await owner.dropGoal();
      else if (args.op === "pause") await owner.pauseGoal();
      else if (args.op === "complete")
        await owner.completeGoalFromTool(args.evidence ?? []);
      checkEpoch(generation);
      const details = {
        op: args.op,
        goal: state?.goal ?? null,
        reason: args.reason,
        completionIsModelDeclared: args.op === "complete",
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
        ...(args.op === "pause" || args.op === "drop"
          ? { terminate: true }
          : {}),
      };
    },
  });
  pi.on("session_shutdown", async (event) => {
    await account();
    await runtime?.onTaskAborted({ reason: "interrupted" });
    removeInput?.();
    removeInput = undefined;
    ctx?.ui.setStatus("pi-kit-goal", undefined);
    epoch++;
    ctx = undefined;
    runtime = undefined;
    state = undefined;
    if (event.reason === "quit" || event.reason === "reload") unclaim();
  });
}
