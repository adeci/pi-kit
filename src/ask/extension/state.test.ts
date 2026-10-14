import { describe, expect, test } from "bun:test";
import { answered, result, summary, validate, type Question } from "./state";
const q: Question = {
  id: "scope",
  question: "Which scope?",
  options: [
    { id: "a", label: "First" },
    { id: "b", label: "Second" },
  ],
  recommended: "a",
};
describe("question contract", () => {
  test("recommendations do not supply answers", () => {
    validate([q]);
    expect(answered(q)).toBe(false);
    expect(() => result([q], [], "answered")).toThrow();
  });
  test("stable identities and recommendation validation", () => {
    expect(() => validate([q, q])).toThrow();
    expect(() => validate([{ ...q, recommended: "missing" }])).toThrow();
    expect(() =>
      validate([{ ...q, options: [q.options![0], q.options![0]] }]),
    ).toThrow();
    expect(() => validate([])).toThrow();
    expect(() => validate(Array(9).fill(q))).toThrow();
    expect(() => validate([{ ...q, question: " " }])).toThrow();
  });
  test("single, multi and custom answers", () => {
    expect(answered(q, { id: q.id, selected: ["a"], text: "" })).toBe(true);
    expect(answered(q, { id: q.id, selected: ["a", "b"], text: "" })).toBe(
      false,
    );
    expect(
      answered(
        { ...q, multi: true },
        { id: q.id, selected: ["a", "b"], text: "Also this" },
      ),
    ).toBe(true);
    expect(answered(q, { id: q.id, selected: [], text: "Other scope" })).toBe(
      true,
    );
    expect(
      answered(q, { id: q.id, selected: ["a"], text: "Other scope" }),
    ).toBe(false);
    expect(answered(q, { id: q.id, selected: ["missing"], text: "" })).toBe(
      false,
    );
    expect(answered(q, { id: q.id, selected: ["a", "a"], text: "" })).toBe(
      false,
    );
    expect(answered(q, { id: "wrong", selected: ["a"], text: "" })).toBe(false);
    expect(
      answered(
        { id: "text", question: "Why?" },
        { id: "text", selected: [], text: " " },
      ),
    ).toBe(false);
  });
  test("cancelled or unavailable forms never leak drafts as answers", () => {
    const drafts = [{ id: q.id, selected: ["a"], text: "" }];
    expect(result([q], drafts, "cancelled").answers).toEqual([]);
    expect(result([q], drafts, "unavailable").answers).toEqual([]);
    const saved = result([q], drafts, "answered");
    drafts[0].selected.push("b");
    expect(saved.answers[0].selected).toEqual(["a"]);
    expect(summary(q, saved.answers[0])).toBe("First");
  });
});
