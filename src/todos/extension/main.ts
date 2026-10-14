import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Text,
  matchesKey,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { menuFrame, menuHeight, menuOptions } from "../../ui/menu";
import { singleLine } from "../../ui/style";
import { treeGutters } from "../../ui/layout";
import {
  apply,
  describe,
  entryType,
  restore,
  summary,
  tasks,
  type Phase,
  type Operation,
  type Task,
} from "./state";
const symbols = {
  pending: "○",
  in_progress: "◉",
  completed: "✓",
  blocked: "!",
  abandoned: "−",
};
function taskRow(task: Task, theme: Theme) {
  const color =
    task.status === "completed"
      ? "success"
      : task.status === "blocked"
        ? "warning"
        : task.status === "in_progress"
          ? "accent"
          : "dim";
  return (
    theme.fg(color, `${symbols[task.status]} ${singleLine(task.content)}`) +
    (task.blocker ? theme.fg("muted", ` — ${singleLine(task.blocker)}`) : "")
  );
}
export default function todos(pi: ExtensionAPI) {
  let claimed = false;
  pi.events.emit("pi-kit:claim:todos", () => {
    claimed = true;
  });
  if (claimed) return;
  const unclaim = pi.events.on("pi-kit:claim:todos", (callback: unknown) => {
    if (typeof callback === "function") callback();
  });
  let phases: Phase[] = [],
    ctx: ExtensionContext | undefined,
    mounted = false,
    widgetTui: TUI | undefined;
  let refresh: (() => void) | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let hidden = false;
  const allClosed = () =>
    tasks(phases).every(
      (task) => task.status === "completed" || task.status === "abandoned",
    );
  const update = () => {
    if (ctx?.mode !== "tui") return;
    if (tasks(phases).length && !hidden && !mounted) {
      mounted = true;
      ctx.ui.setWidget(
        "pi-todos",
        (tui, theme) => {
          widgetTui = tui;
          return {
            render(width) {
              const all = tasks(phases);
              const open = all.filter(
                (task) => !["completed", "abandoned"].includes(task.status),
              );
              const ordered = [
                ...open.filter((task) => task.status === "in_progress"),
                ...open.filter((task) => task.status !== "in_progress"),
              ];
              const cap = Math.max(
                1,
                Math.min(4, Math.floor(tui.terminal.rows / 6)),
              );
              const shown = ordered.slice(0, cap),
                gutters = treeGutters(
                  shown.map(() => ({ depth: 1 })),
                  ordered.length > cap,
                );
              const rows = [
                theme.fg("accent", theme.bold("Todos")) +
                  theme.fg("dim", ` · ${summary(phases)} · /todos`),
              ];
              shown.forEach((task, i) =>
                rows.push(
                  theme.fg("dim", gutters[i].branch) + taskRow(task, theme),
                ),
              );
              if (ordered.length > cap)
                rows.push(
                  theme.fg("dim", `└─ … ${ordered.length - cap} more open`),
                );
              return rows.map((row) => truncateToWidth(row, width));
            },
            invalidate() {},
          };
        },
        { placement: "aboveEditor" },
      );
    } else if ((!tasks(phases).length || hidden) && mounted) {
      ctx.ui.setWidget("pi-todos", undefined);
      mounted = false;
      widgetTui = undefined;
    }
    widgetTui?.requestRender();
    refresh?.();
  };
  const commit = (op: Operation) => {
    const next = apply(phases, op);
    if (op.op !== "view") {
      pi.appendEntry(entryType, { phases: next });
      phases = next;
      clearTimeout(hideTimer);
      hideTimer = undefined;
      hidden = false;
      if (allClosed()) {
        hideTimer = setTimeout(() => {
          hideTimer = undefined;
          hidden = true;
          update();
        }, 5000);
        hideTimer.unref();
      }
      update();
    }
    return next;
  };
  const reconstruct = (_event: unknown, context: ExtensionContext) => {
    ctx = context;
    phases = restore(context.sessionManager.getBranch());
    clearTimeout(hideTimer);
    hideTimer = undefined;
    hidden = allClosed();
    update();
  };
  pi.on("session_start", reconstruct);
  pi.on("session_tree", reconstruct);
  pi.on("session_shutdown", () => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
    ctx?.ui.setWidget("pi-todos", undefined);
    mounted = false;
    widgetTui = undefined;
    ctx = undefined;
    unclaim();
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.pi_todos =
      "Use todo for multi-step work worth tracking, not trivial answers. Use explicit transitions; mark done only after verifying the work. Agent/job completion does not complete a todo. Multiple tasks may be in_progress for parallel work. Do not replace an existing plan without a reason.\nCurrent branch todos:\n" +
      describe(phases);
  });
  const string = Type.String({ minLength: 1, maxLength: 1000 });
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Track session-branch work in phases. init replaces the plan using list:[{phase,items}] or flat items. append adds items to phase (default Tasks). start/done/block/unblock/drop/rm target exact task text. block accepts reason. view is read-only. States change only explicitly; concurrent tasks may be in progress. Mark done only after validation, never just because an agent or job settled. No repository files are written.",
    parameters: Type.Object({
      op: Type.Union(
        [
          "init",
          "append",
          "start",
          "done",
          "block",
          "unblock",
          "drop",
          "rm",
          "view",
        ].map((value) => Type.Literal(value)),
      ),
      list: Type.Optional(
        Type.Array(
          Type.Object({
            phase: string,
            items: Type.Array(string, { minItems: 1, maxItems: 200 }),
          }),
          { maxItems: 32 },
        ),
      ),
      items: Type.Optional(Type.Array(string, { minItems: 1, maxItems: 200 })),
      phase: Type.Optional(string),
      task: Type.Optional(string),
      reason: Type.Optional(string),
    }),
    async execute(_id, args) {
      const next = commit(args as Operation);
      return {
        content: [
          { type: "text", text: summary(next) + "\n" + describe(next) },
        ],
        details: { phases: next, op: args.op },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Todo ")) +
          theme.fg(
            "muted",
            singleLine(`${args.op ?? ""}${args.task ? ` · ${args.task}` : ""}`),
          ),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const data = result.details as { phases?: Phase[] } | undefined;
      if (!data?.phases)
        return new Text(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          0,
          0,
        );
      const all = tasks(data.phases),
        shown = expanded
          ? all
          : all
              .filter(
                (task) =>
                  task.status !== "completed" && task.status !== "abandoned",
              )
              .slice(0, 4);
      return new Text(
        [
          theme.fg("muted", summary(data.phases)),
          ...shown.map((task) => taskRow(task, theme)),
          ...(!expanded && all.length > shown.length
            ? [theme.fg("dim", "Expand for the full plan · /todos")]
            : []),
        ].join("\n"),
        0,
        0,
      );
    },
  });
  pi.registerCommand("todos", {
    description: "Todos — provided by pi-kit; current branch's task plan",
    handler: async (_args, context) => {
      if (context.mode !== "tui")
        throw new Error(
          "/todos requires interactive Pi; use the todo tool otherwise",
        );
      await context.ui.custom<void>((tui, theme, _keys, done) => {
        let selected = 0,
          error = "";
        refresh = () => tui.requestRender();
        return {
          render(width) {
            const all = tasks(phases),
              height = menuHeight(tui.terminal.rows),
              capacity = Math.max(1, height - 8);
            selected = Math.max(0, Math.min(selected, all.length - 1));
            const start = Math.max(0, selected - capacity + 1);
            const body = all.length
              ? all
                  .slice(start, start + capacity)
                  .map(
                    (task, i) =>
                      `${start + i === selected ? "› " : "  "}${taskRow(task, theme)}${theme.fg("dim", ` · ${task.phase}`)}`,
                  )
              : ["No todos yet. Ask Pi to create a plan with the todo tool."];
            return menuFrame(
              theme,
              width,
              height,
              "Todos",
              summary(phases),
              body,
              error ||
                "↑↓ select · s start · d done · u unblock · − drop · Esc close",
            );
          },
          handleInput(data) {
            if (matchesKey(data, "escape")) {
              done();
              return;
            }
            const all = tasks(phases);
            if (matchesKey(data, "up") || matchesKey(data, "down"))
              selected = Math.max(
                0,
                Math.min(
                  selected + (matchesKey(data, "up") ? -1 : 1),
                  all.length - 1,
                ),
              );
            else {
              const op = (
                { s: "start", d: "done", u: "unblock", "-": "drop" } as const
              )[data as "s"];
              if (op && all[selected]) {
                try {
                  commit({ op, task: all[selected].content });
                  error = "";
                } catch (err) {
                  error = String(err);
                }
              }
            }
            tui.requestRender();
          },
          invalidate() {},
          dispose() {
            refresh = undefined;
          },
        };
      }, menuOptions);
    },
  });
}
