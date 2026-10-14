export interface Option {
  id: string;
  label: string;
  description?: string;
}
export interface Question {
  id: string;
  question: string;
  options?: Option[];
  multi?: boolean;
  recommended?: string;
}
export interface Answer {
  id: string;
  selected: string[];
  text: string;
}
export interface Result {
  status: "answered" | "cancelled" | "unavailable";
  questions: Question[];
  answers: Answer[];
}

export function validate(questions: Question[]) {
  if (questions.length < 1 || questions.length > 8)
    throw new Error("Ask requires 1–8 questions.");
  const ids = new Set<string>();
  for (const q of questions) {
    if (!q.id.trim() || ids.has(q.id))
      throw new Error("Question IDs must be nonempty and unique.");
    ids.add(q.id);
    if (!q.question.trim()) throw new Error("Question text cannot be empty.");
    const options = q.options ?? [];
    const keys = new Set(options.map((o) => o.id));
    if (
      keys.size !== options.length ||
      options.some((o) => !o.id.trim() || !o.label.trim())
    )
      throw new Error("Option IDs must be unique and option labels nonempty.");
    if (q.recommended !== undefined && !keys.has(q.recommended))
      throw new Error("Recommended option must name an existing option ID.");
  }
}

export function answered(q: Question, answer?: Answer): boolean {
  if (!answer || answer.id !== q.id) return false;
  const keys = new Set((q.options ?? []).map((o) => o.id));
  if (
    new Set(answer.selected).size !== answer.selected.length ||
    answer.selected.some((id) => !keys.has(id))
  )
    return false;
  if (
    !q.multi &&
    answer.selected.length + Number(Boolean(answer.text.trim())) > 1
  )
    return false;
  return answer.selected.length > 0 || Boolean(answer.text.trim());
}
export function summary(q: Question, answer?: Answer): string {
  if (!answered(q, answer)) return "Not answered";
  return [
    ...answer!.selected.map((id) => q.options!.find((o) => o.id === id)!.label),
    answer!.text,
  ]
    .filter(Boolean)
    .join("; ");
}
export function result(
  questions: Question[],
  drafts: Answer[],
  status: Result["status"],
): Result {
  if (
    status === "answered" &&
    !questions.every((q, i) => answered(q, drafts[i]))
  )
    throw new Error("Answer every question before submitting.");
  return {
    status,
    questions,
    answers:
      status === "answered"
        ? drafts.map((a) => ({ ...a, selected: [...a.selected] }))
        : [],
  };
}
