import { stripVTControlCharacters } from "node:util";
import { clean } from "./types";
export type AgentLabel = {
  id: string;
  name?: string;
  role?: string;
  state?: string;
};
const line = (value: string) =>
  clean(stripVTControlCharacters(value)).replace(/[\r\n\t]/g, " ");
export function agentLabel(agent: AgentLabel): string {
  const name = line(agent.name || agent.role || "subagent");
  const role =
    agent.role && name.toLowerCase() !== agent.role.toLowerCase()
      ? ` ⟨${line(agent.role)}⟩`
      : "";
  return `${name}${role} [${line(agent.id)}]`;
}
export function resultAgents(value: unknown): AgentLabel[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(resultAgents);
  const object = value as Record<string, unknown>;
  if (typeof object.id === "string")
    return [
      {
        id: object.id,
        name: typeof object.name === "string" ? object.name : undefined,
        role: typeof object.role === "string" ? object.role : undefined,
        state: typeof object.state === "string" ? object.state : undefined,
      },
    ];
  return Array.isArray(object.agents)
    ? object.agents.flatMap(resultAgents)
    : [];
}
export function rememberAgents(
  state: { agents?: AgentLabel[] },
  agents: AgentLabel[],
): boolean {
  if (JSON.stringify(state.agents) === JSON.stringify(agents)) return false;
  // Pi creates a new render context each time, but shares this state object.
  state.agents = agents;
  return true;
}
export function callTargets(
  args: { id?: string; ids?: string[] },
  agents: AgentLabel[],
): string[] {
  const ids = args.ids ?? (args.id ? [args.id] : []);
  return ids.map((id) =>
    agentLabel(agents.find((agent) => agent.id === id) ?? { id }),
  );
}
