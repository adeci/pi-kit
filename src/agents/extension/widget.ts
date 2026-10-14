import { clean } from "./types";
import { treeGutters } from "../../ui/layout";

type WidgetAgent = {
  id: string;
  depth: number;
  name: string;
  role: string;
  state: string;
  model: string;
  thinking: string;
  requests: number;
  cost: number;
  activity: string;
};
export type { WidgetStyle } from "../../ui/style";
import type { WidgetStyle } from "../../ui/style";
const line = (text: string) => clean(text).replace(/[\r\n\t]/g, " ");
export const activeAgents = <T extends WidgetAgent>(agents: T[]) =>
  agents.filter((agent) =>
    ["queued", "starting", "running", "settling"].includes(agent.state),
  );

/** Anchored, width-safe tree preview. Full handles and evidence belong in /agents. */
export function agentWidgetLines(
  agents: WidgetAgent[],
  columns: number,
  terminalRows: number,
  style: WidgetStyle,
): string[] {
  const active = activeAgents(agents);
  if (!active.length || columns < 1) return [];
  const budget = Math.max(3, Math.floor(terminalRows / 3));
  const detailed = active.length * 2 + 1 <= budget;
  const count = Math.min(active.length, detailed ? active.length : budget - 2);
  const shown = active.slice(0, count);
  const gutters = treeGutters(shown, active.length > count);
  const result = [
    style.fit(
      style.accent(`Subagents · ${active.length} active`) +
        style.muted("  /agents"),
      columns,
    ),
  ];
  for (let index = 0; index < shown.length; index++) {
    const agent = shown[index];
    const gutter = gutters[index];
    const prefix = style.muted(gutter.branch);
    const name = line(agent.name || agent.role);
    const role =
      name.toLowerCase() === agent.role.toLowerCase()
        ? ""
        : ` ⟨${line(agent.role)}⟩`;
    const model = line(agent.model.slice(agent.model.indexOf("/") + 1));
    const stats = `${model} · ${line(agent.thinking)} · ${agent.requests} turns · $${agent.cost.toFixed(3)}`;
    const available = Math.max(0, columns - style.width(prefix));
    const titleWidth =
      columns < 40
        ? available
        : Math.max(
            0,
            Math.min(
              available,
              Math.floor(columns * 0.4) - style.width(prefix),
            ),
          );
    const statsWidth =
      columns < 40 ? 0 : Math.max(0, available - titleWidth - 2);
    const title = style.fit(
      `${name}${role}${detailed ? "" : ` · ${agent.state}`}`,
      titleWidth,
    );
    const padding = " ".repeat(Math.max(0, titleWidth - style.width(title)));
    result.push(
      style.fit(
        prefix +
          style.accent(title) +
          padding +
          (statsWidth ? "  " + style.muted(style.fit(stats, statsWidth)) : ""),
        columns,
      ),
    );
    const activity = line(agent.activity || agent.state);
    const status =
      activity === agent.state || agent.state === "running"
        ? activity
        : `${agent.state} · ${activity}`;
    if (detailed)
      result.push(
        style.fit(style.muted(`${gutter.continuation}↳ ${status}`), columns),
      );
  }
  if (active.length > count)
    result.push(
      style.fit(
        style.muted(
          `└─ … ${active.length - count} more active — /agents shows all`,
        ),
        columns,
      ),
    );
  return result;
}
