import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  wrapTextWithAnsi,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { activeAgents, agentWidgetLines } from "./widget";
import { splitPaneLayout } from "../../ui/layout";
import { widgetStyle, workingLabel } from "../../ui/style";
import type { Supervisor } from "./supervisor";
import { clean } from "./types";
import { conversation } from "./settings";
import { nativeConversation } from "./conversation";
import { choose, menuFrame, menuHeight, menuOptions } from "../../ui/menu";
import { settingsUI } from "./settings-ui";

type Action = {
  kind:
    "send" | "assign" | "resume" | "stop" | "forget" | "integrate" | "spawn";
  id?: string;
};
const tabs = ["Active", "History", "Settings"];
const views = ["conversation", "result", "diff", "prompt", "status"];
const singleLine = (value: string) => clean(value).replace(/[\r\n\t]/g, " ");

export function installUI(pi: ExtensionAPI, get: () => Supervisor | undefined) {
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshInspector: (() => void) | undefined;
  let widgetTui: TUI | undefined;
  let widgetMounted = false;
  const update = () => {
    timer = undefined;
    const supervisor = get();
    if (context?.mode !== "tui" || !supervisor) return;
    const active = activeAgents(supervisor.list());
    if (active.length && !widgetMounted) {
      widgetMounted = true;
      context.ui.setWidget(
        "pi-agents",
        (tui, theme) => {
          widgetTui = tui;
          return {
            render: (width) =>
              agentWidgetLines(
                get()?.list() ?? [],
                width,
                tui.terminal.rows,
                widgetStyle(theme),
              ),
            invalidate() {},
          };
        },
        { placement: "aboveEditor" },
      );
    } else if (!active.length && widgetMounted) {
      context.ui.setWidget("pi-agents", undefined);
      widgetMounted = false;
      widgetTui = undefined;
    }
    widgetTui?.requestRender();
    refreshInspector?.();
  };
  const changed = () => {
    if (!timer) timer = setTimeout(update, 100);
  };

  pi.registerCommand("agents", {
    description: "Agents — provided by pi-kit; live streams and settings",
    handler: async (_args, ctx) => {
      context = ctx;
      if (ctx.mode !== "tui")
        throw new Error(
          "/agents requires interactive Pi; model control tools remain available in RPC mode.",
        );
      let tab = 0,
        selected = 0,
        view = 0;
      for (;;) {
        const supervisor = get();
        if (!supervisor) throw new Error("Agent supervisor is unavailable");
        const action = await ctx.ui.custom<Action | undefined>(
          (tui, theme, _keys, done) => {
            const agentList = () => {
              const all = supervisor.list(),
                running = activeAgents(all),
                ids = new Set(running.map((a) => a.id));
              return tab === 1 ? all.filter((a) => !ids.has(a.id)) : running;
            };
            let agents = agentList(),
              detail: string[] = [],
              scroll = 0,
              version = 0,
              disposed = false,
              follow = true;
            let components: Array<{ render(width: number): string[] }> = [];
            let initialSelection = true;
            let detailId: string | undefined;
            const settings = settingsUI(ctx, supervisor, tui, theme, () =>
              done(undefined),
            );
            const load = async () => {
              const current = ++version,
                id = agents[selected]?.id;
              agents = agentList();
              let moved = agents.findIndex((a) => a.id === id);
              if (initialSelection) {
                const firstActive = agents.findIndex(
                  (a) => activeAgents([a]).length,
                );
                if (firstActive >= 0) moved = firstActive;
                initialSelection = false;
              }
              selected = Math.max(
                0,
                Math.min(moved >= 0 ? moved : selected, agents.length - 1),
              );
              if (tab === 2 || !agents.length) {
                if (!agents.length) {
                  detail = [
                    tab === 1
                      ? "No inactive agents in this session yet."
                      : "No active agents. Press n to delegate; History holds this session's finished work.",
                  ];
                  components = [];
                }
                tui.requestRender();
                return;
              }
              try {
                const agent = agents[selected];
                if (detailId !== agent.id) {
                  detailId = agent.id;
                  follow = true;
                  scroll = 0;
                  components = [];
                  detail = ["Loading conversation…"];
                }
                const result = await supervisor.status(
                  "main",
                  agent.id,
                  views[view],
                );
                if (disposed || current !== version) return;
                detail =
                  views[view] === "conversation"
                    ? conversation(
                        result.text ?? "",
                        supervisor.runtime.get(agent.id)?.liveText ?? "",
                      )
                    : (typeof result.text === "string"
                        ? `${result.path}${result.truncated ? " (bounded preview)" : ""}\n\n${result.text}`
                        : JSON.stringify(result, null, 2)
                      ).split("\n");
                detail = detail.map(clean);
                components =
                  views[view] === "conversation"
                    ? nativeConversation(
                        result.text ?? "",
                        supervisor.runtime.get(agent.id)?.liveText ?? "",
                        tui,
                        supervisor.agents.get(agent.id)!.cwd,
                        supervisor.runtime.get(agent.id)?.liveThinking ?? "",
                      )
                    : [];
              } catch (error) {
                if (current === version) {
                  detail = [String(error)];
                  components = [];
                }
              }
              if (!disposed) tui.requestRender();
            };
            const tick = setInterval(() => {
              if (tab === 0 && activeAgents(agents).length) tui.requestRender();
            }, 100);
            tick.unref();
            void load();
            refreshInspector = () => {
              void load();
            };
            return {
              render(width: number) {
                const height = menuHeight(tui.terminal.rows),
                  innerWidth = Math.max(1, width - 4);
                const tabLine = tabs
                  .map((name, i) =>
                    i === tab
                      ? theme.fg("accent", theme.bold(`[${name}]`))
                      : theme.fg("muted", name),
                  )
                  .join("  ");
                const rows: string[] = [];
                let dividers: { column?: number; rows?: number[] } | undefined;
                if (tab === 2) rows.push(...settings.render(innerWidth));
                else {
                  const layout = splitPaneLayout(innerWidth, height - 6);
                  dividers = {
                    column: layout.dividerColumn,
                    rows: layout.dividerRows,
                  };
                  const list: string[] = [];
                  const listHeight = Math.max(
                    1,
                    Math.floor(layout.listRows / 2),
                  );
                  const start = Math.max(0, selected - listHeight + 1);
                  for (
                    let i = start;
                    i < Math.min(agents.length, start + listHeight);
                    i++
                  ) {
                    const a = agents[i];
                    const indent = "  ".repeat(Math.min(4, a.depth - 1));
                    const state = tab === 1 ? a.outcome : a.state;
                    const name = `${i === selected ? "›" : " "} ${indent}${singleLine(a.name)} · ${state}`;
                    list.push(
                      i === selected
                        ? theme.fg("accent", theme.bold(name))
                        : theme.fg("muted", name),
                    );
                    list.push(
                      theme.fg(
                        "dim",
                        `  ${singleLine(a.model.slice(a.model.indexOf("/") + 1))} · ${a.requests} turns · $${a.cost.toFixed(3)}`,
                      ),
                    );
                  }
                  if (!agents.length)
                    list.push(
                      theme.fg(
                        "muted",
                        tab === 1
                          ? "No session history"
                          : "No active agents · n new",
                      ),
                    );
                  const wrapped = components.length
                    ? components.flatMap((component) =>
                        component.render(layout.streamWidth),
                      )
                    : detail.flatMap((line) =>
                        wrapTextWithAnsi(line, layout.streamWidth),
                      );
                  const currentAgent = agents[selected];
                  const busy =
                    currentAgent && activeAgents([currentAgent]).length > 0;
                  const room = Math.max(1, layout.streamRows - (busy ? 1 : 0));
                  if (follow && view === 0)
                    scroll = Math.max(0, wrapped.length - room);
                  scroll = Math.max(
                    0,
                    Math.min(scroll, Math.max(0, wrapped.length - room)),
                  );
                  const stream = wrapped.slice(scroll, scroll + room);
                  if (busy) {
                    while (stream.length < room) stream.push("");
                    stream.push(
                      theme.fg(
                        "accent",
                        workingLabel(
                          Date.now(),
                          currentAgent.activity === "thinking"
                            ? "Thinking"
                            : "Working",
                        ),
                      ) +
                        theme.fg(
                          "dim",
                          ` · ${singleLine(currentAgent.activity)}`,
                        ),
                    );
                  }
                  const listTitle = theme.fg(
                    "accent",
                    theme.bold(
                      tab === 1
                        ? `History · ${agents.length} in session`
                        : `Active · ${agents.length} agents`,
                    ),
                  );
                  const viewTitle =
                    view === 0
                      ? "Live conversation"
                      : views[view][0].toUpperCase() + views[view].slice(1);
                  const streamTitle = theme.fg(
                    "accent",
                    theme.bold(
                      `${viewTitle} · ${singleLine(agents[selected]?.name ?? "Output")}${view === 0 && !follow ? " · paused" : ""}`,
                    ),
                  );
                  const join = (left: string, right: string) => {
                    const fitted = truncateToWidth(left, layout.listWidth);
                    return (
                      fitted +
                      " ".repeat(
                        Math.max(0, layout.listWidth - visibleWidth(fitted)),
                      ) +
                      theme.fg("border", "│") +
                      " " +
                      truncateToWidth(right, layout.streamWidth)
                    );
                  };
                  if (height < 12)
                    rows.push("Enlarge terminal to inspect agents");
                  else if (layout.split) {
                    rows.push(join(listTitle, streamTitle), "");
                    for (let i = 0; i < layout.listRows; i++)
                      rows.push(join(list[i] ?? "", stream[i] ?? ""));
                  } else {
                    rows.push(listTitle);
                    for (let i = 0; i < layout.listRows; i++)
                      rows.push(list[i] ?? "");
                    rows.push("", streamTitle, ...stream);
                  }
                }
                return menuFrame(
                  theme,
                  width,
                  height,
                  tab === 2 ? settings.title : "Agents",
                  tabLine,
                  rows,
                  tab === 2
                    ? settings.hint
                    : "↑↓ agent · PgUp/PgDn stream · n new · 1–5 view · Tab panes · ? · Esc",
                  dividers,
                );
              },
              handleInput(data: string) {
                const switching =
                  matchesKey(data, "tab") || matchesKey(data, "shift+tab");
                if (tab === 2 && (!switching || settings.depth > 0)) {
                  settings.handleInput(data);
                  return;
                }
                if (matchesKey(data, "escape")) {
                  done(undefined);
                  return;
                }
                if (switching) {
                  tab = (tab + (matchesKey(data, "shift+tab") ? 2 : 1)) % 3;
                  selected = 0;
                  scroll = 0;
                  void load();
                } else if (data === "?") {
                  detail = [
                    "n new · m message · a assign · r resume",
                    "x stop branch · i integrate · f forget",
                    "1 conversation · 2 result · 3 diff · 4 prompt · 5 status",
                    "PgUp/PgDn scroll · End follow output",
                  ];
                  components = [];
                  follow = false;
                  scroll = 0;
                  tui.requestRender();
                } else if (matchesKey(data, "enter")) {
                  view = 0;
                  follow = true;
                  void load();
                } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
                  selected = Math.max(
                    0,
                    Math.min(
                      selected + (matchesKey(data, "up") ? -1 : 1),
                      agents.length - 1,
                    ),
                  );
                  scroll = 0;
                  follow = true;
                  void load();
                } else if (
                  matchesKey(data, "pageUp") ||
                  matchesKey(data, "pageDown")
                ) {
                  follow = false;
                  scroll = Math.max(
                    0,
                    scroll + (matchesKey(data, "pageUp") ? -10 : 10),
                  );
                  tui.requestRender();
                } else if (matchesKey(data, "end")) {
                  follow = true;
                  tui.requestRender();
                } else if (/^[1-5]$/.test(data)) {
                  view = Number(data) - 1;
                  scroll = 0;
                  void load();
                } else if (data === "n") done({ kind: "spawn" });
                else {
                  const kinds: Record<string, Action["kind"]> = {
                    m: "send",
                    a: "assign",
                    r: "resume",
                    x: "stop",
                    f: "forget",
                    i: "integrate",
                  };
                  if (kinds[data] && agents[selected])
                    done({ kind: kinds[data], id: agents[selected].id });
                }
              },
              invalidate() {
                settings.invalidate();
              },
              dispose() {
                disposed = true;
                clearInterval(tick);
                version++;
                settings.dispose();
                refreshInspector = undefined;
              },
            };
          },
          menuOptions,
        );
        if (!action) return;
        try {
          if (action.kind === "spawn") {
            const role = await choose(
              ctx,
              "Agent role",
              Object.entries(supervisor.config.roles).map(([value, role]) => ({
                value,
                label: value,
                description: role.description,
              })),
            );
            if (!role) continue;
            const lifetime = await choose(ctx, "Agent lifetime", [
              {
                value: "task",
                label: "Task",
                description: "Exit after this assignment",
              },
              {
                value: "reusable",
                label: "Reusable",
                description: "Keep this agent's own history and workspace",
              },
            ]);
            if (!lifetime) continue;
            const task = await ctx.ui.editor("Self-contained assignment");
            if (task?.trim())
              await supervisor.dispatch("main", "spawn", {
                role,
                lifetime,
                task,
              });
          } else if (
            action.kind === "send" ||
            action.kind === "assign" ||
            action.kind === "resume"
          ) {
            const message = await ctx.ui.editor(
              action.kind === "send"
                ? "Send guidance"
                : action.kind === "resume"
                  ? "Resume objective (empty keeps interrupted objective)"
                  : "New assignment",
            );
            if (
              message !== undefined &&
              (message.trim() || action.kind === "resume")
            )
              await supervisor.dispatch("main", action.kind, {
                id: action.id,
                ...(action.kind === "send"
                  ? { message }
                  : message.trim()
                    ? { task: message }
                    : {}),
              });
          } else if (action.kind === "forget") {
            if (
              await ctx.ui.confirm(
                "Forget agent?",
                "Deletes its conversation, artifacts and isolated workspace.",
              )
            )
              await supervisor.forget(action.id!);
          } else
            await supervisor.dispatch("main", action.kind, { id: action.id });
        } catch (error) {
          ctx.ui.notify(String(error), "error");
        }
      }
    },
  });
  return {
    changed,
    attach(ctx: ExtensionContext) {
      context = ctx;
      changed();
    },
    close() {
      clearTimeout(timer);
      timer = undefined;
      if (context?.hasUI) {
        context.ui.setWidget("pi-agents", undefined);
        context.ui.setStatus("pi-agents", undefined);
      }
      context = undefined;
      refreshInspector = undefined;
      widgetMounted = false;
      widgetTui = undefined;
    },
  };
}
