import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  answered,
  result,
  summary,
  validate,
  type Answer,
  type Question,
  type Result,
} from "./state";
import { questionnaire } from "./ui";

const identifier = Type.String({ minLength: 1, maxLength: 64 });
const parameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: identifier,
      question: Type.String({ minLength: 1, maxLength: 2000 }),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            id: identifier,
            label: Type.String({ minLength: 1, maxLength: 160 }),
            description: Type.Optional(Type.String({ maxLength: 500 })),
          }),
          { maxItems: 12 },
        ),
      ),
      multi: Type.Optional(Type.Boolean()),
      recommended: Type.Optional(identifier),
    }),
    { minItems: 1, maxItems: 8 },
  ),
});

// RPC supports standard dialogs, not custom terminal components. Never supply
// a timeout or turn an undefined/false response into a recommended answer.
async function rpcQuestions(
  ctx: ExtensionContext,
  questions: Question[],
  signal: AbortSignal,
): Promise<Result> {
  const drafts: Answer[] = [];
  const cancel = () => result(questions, [], "cancelled");
  for (const q of questions) {
    const answer: Answer = { id: q.id, selected: [], text: "" };
    drafts.push(answer);
    const options = q.options ?? [];
    if (!options.length) {
      const text = await ctx.ui.input(q.question, "Your answer", { signal });
      if (signal.aborted || !text?.trim()) return cancel();
      answer.text = text.trim();
      continue;
    }
    for (;;) {
      const labels = options.map(
        (option, i) =>
          `${i + 1}. ${q.multi ? (answer.selected.includes(option.id) ? "[x] " : "[ ] ") : ""}${option.label}${option.id === q.recommended ? " (Recommended)" : ""}${option.description ? ` — ${option.description}` : ""}`,
      );
      const other = "Other / type your answer",
        next = "Next question";
      const choice = await ctx.ui.select(
        q.question,
        [...labels, other, ...(q.multi ? [next] : [])],
        { signal },
      );
      if (signal.aborted || choice === undefined) return cancel();
      if (choice === other) {
        const text = await ctx.ui.input(q.question, "Your answer", { signal });
        if (signal.aborted || text === undefined) return cancel();
        if (!text.trim()) continue;
        answer.text = text.trim();
        break;
      }
      if (q.multi && choice === next) {
        if (answered(q, answer)) break;
        continue;
      }
      const index = labels.indexOf(choice);
      if (index < 0) return cancel();
      const id = options[index].id;
      if (!q.multi) {
        answer.selected = [id];
        break;
      }
      answer.selected = answer.selected.includes(id)
        ? answer.selected.filter((value) => value !== id)
        : [...answer.selected, id];
    }
  }
  const confirmed = await ctx.ui.confirm(
    "Submit answers?",
    questions
      .map((q, i) => `${q.question}\n${summary(q, drafts[i])}`)
      .join("\n\n"),
    { signal },
  );
  return result(
    questions,
    drafts,
    confirmed && !signal.aborted ? "answered" : "cancelled",
  );
}

export default function install(pi: ExtensionAPI) {
  let claimed = false;
  pi.events.emit("pi-kit:claim:ask", () => {
    claimed = true;
  });
  if (claimed) return;
  const unclaim = pi.events.on("pi-kit:claim:ask", (reply: unknown) => {
    if (typeof reply === "function") reply();
  });
  let epoch = 0;
  let active: AbortController | undefined;
  const close = () => {
    epoch++;
    active?.abort();
    active = undefined;
  };
  pi.on("session_start", close);
  pi.on("session_shutdown", (event) => {
    close();
    if (event.reason === "quit" || event.reason === "reload") unclaim();
  });
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Ask the user a focused question or a short set of related questions. Supports single/multiple choices, recommended option IDs, and free text (omit options). The user can always write their own answer and must submit explicitly. Use only for material ambiguity or decisions, not routine progress or needless confirmation. Cancellation/unavailability supplies no answers: stop and wait for user input, never infer consent or immediately ask again. Workers should ask their parent with agent_send instead.",
    exposure: "model-only",
    executionMode: "sequential",
    parameters,
    async execute(_id, args, signal, _update, ctx) {
      validate(args.questions);
      if (active) throw new Error("Another question form is already open.");
      const generation = epoch;
      const controller = new AbortController();
      const combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      active = controller;
      try {
        let details: Result;
        if (combined.aborted) details = result(args.questions, [], "cancelled");
        else if (!ctx.hasUI || pi.getFlag("pi-agents-child"))
          details = result(args.questions, [], "unavailable");
        else
          details = await (ctx.mode === "tui" ? questionnaire : rpcQuestions)(
            ctx,
            args.questions,
            combined,
          );
        if (generation !== epoch || combined.aborted)
          details = result(args.questions, [], "cancelled");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details) }],
          details,
          ...(details.status !== "answered" ? { terminate: true } : {}),
        };
      } finally {
        if (active === controller) active = undefined;
      }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Ask")) +
          ` · ${args.questions?.length ?? 0} questions`,
        0,
        0,
      );
    },
    renderResult(value, { isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("muted", "Waiting for your answers…"), 0, 0);
      const details = value.details as Result | undefined;
      if (!details) return new Text("Question form unavailable", 0, 0);
      const text =
        details.status === "answered"
          ? details.questions
              .map(
                (q, i) => `${q.question}\n  ${summary(q, details.answers[i])}`,
              )
              .join("\n")
          : `Ask ${details.status} — no answers submitted`;
      return new Text(text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""), 0, 0);
    },
  });
}
