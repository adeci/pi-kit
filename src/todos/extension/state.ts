export const statuses = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "abandoned",
] as const;
export type Status = (typeof statuses)[number];
export interface Task {
  content: string;
  status: Status;
  blocker?: string;
}
export interface Phase {
  name: string;
  tasks: Task[];
}
export interface Operation {
  op:
    | "init"
    | "append"
    | "start"
    | "done"
    | "block"
    | "unblock"
    | "drop"
    | "rm"
    | "view";
  list?: { phase: string; items: string[] }[];
  items?: string[];
  phase?: string;
  task?: string;
  reason?: string;
}
export const entryType = "pi-kit:todos:v1";
const text = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    throw new Error(`Invalid ${label}: use 1–1000 characters on one line`);
  return value.trim();
};
export function validate(phases: Phase[]): Phase[] {
  if (!Array.isArray(phases) || phases.length > 32)
    throw new Error("At most 32 phases are allowed");
  const names = new Set<string>(),
    tasks = new Set<string>();
  for (const phase of phases) {
    phase.name = text(phase.name, "phase");
    if (names.has(phase.name) || !Array.isArray(phase.tasks))
      throw new Error("Duplicate or invalid phase");
    names.add(phase.name);
    for (const task of phase.tasks) {
      task.content = text(task.content, "task");
      if (tasks.has(task.content))
        throw new Error(`Duplicate task: ${task.content}`);
      tasks.add(task.content);
      if (!statuses.includes(task.status))
        throw new Error("Invalid task status");
      if (task.blocker !== undefined)
        task.blocker = text(task.blocker, "blocker");
    }
  }
  if (tasks.size > 200) throw new Error("At most 200 tasks are allowed");
  return phases;
}
export function apply(current: Phase[], op: Operation): Phase[] {
  let phases: Phase[] = structuredClone(current);
  if (op.op === "view") return phases;
  if (op.op === "init") {
    const list =
      op.list ??
      (op.items
        ? [{ phase: op.phase ?? "Tasks", items: op.items }]
        : undefined);
    if (!list?.length || list.some((phase) => !phase.items?.length))
      throw new Error("init requires non-empty list or items");
    phases = list.map((phase) => ({
      name: phase.phase,
      tasks: phase.items.map((content) => ({ content, status: "pending" })),
    }));
  } else if (op.op === "append") {
    const name = text(op.phase ?? "Tasks", "phase");
    if (!op.items?.length) throw new Error("append requires items");
    let phase = phases.find((phase) => phase.name === name);
    if (!phase) {
      phase = { name, tasks: [] };
      phases.push(phase);
    }
    phase.tasks.push(
      ...op.items.map((content) => ({ content, status: "pending" as const })),
    );
  } else {
    if (!op.task)
      throw new Error(
        `${op.op} requires exact task content; use view to inspect tasks`,
      );
    const phase = phases.find((phase) =>
      phase.tasks.some((task) => task.content === op.task),
    );
    const task = phase?.tasks.find((task) => task.content === op.task);
    if (!phase || !task)
      throw new Error("Task not found; use the exact content from view");
    const transitions: Partial<Record<Operation["op"], Status>> = {
      start: "in_progress",
      done: "completed",
      block: "blocked",
      unblock: "pending",
      drop: "abandoned",
    };
    if (op.op === "rm")
      phase.tasks = phase.tasks.filter((other) => other !== task);
    else {
      const status = transitions[op.op];
      if (!status) throw new Error("Unknown todo operation");
      if (op.op === "block" && ["completed", "abandoned"].includes(task.status))
        throw new Error("Cannot block closed work; explicitly start it first");
      if (op.op === "unblock" && task.status !== "blocked")
        throw new Error("Only blocked tasks can be unblocked");
      task.status = status;
      delete task.blocker;
      if (op.op === "block" && op.reason)
        task.blocker = text(op.reason, "blocker");
    }
  }
  return validate(phases);
}
export function restore(entries: readonly any[]): Phase[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === entryType) {
      try {
        return validate(structuredClone(entry.data.phases));
      } catch {
        /* Ignore malformed historical entries. */
      }
    }
  }
  return [];
}
export const tasks = (phases: Phase[]) =>
  phases.flatMap((phase) =>
    phase.tasks.map((task) => ({ ...task, phase: phase.name })),
  );
export function summary(phases: Phase[]) {
  const all = tasks(phases);
  return `${all.filter((task) => task.status === "completed").length}/${all.length} completed · ${all.filter((task) => task.status === "in_progress").length} active · ${all.filter((task) => task.status === "blocked").length} blocked`;
}
export const describe = (phases: Phase[]) =>
  phases.length
    ? phases
        .map(
          (phase) =>
            `${phase.name}\n${phase.tasks.map((task) => `  [${task.status}] ${task.content}${task.blocker ? ` — ${task.blocker}` : ""}`).join("\n")}`,
        )
        .join("\n")
    : "No todos. Use init to create a plan.";
