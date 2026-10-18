import { expect, test } from "bun:test";
import { duration, listeningLines } from "./listening";
import type { WidgetStyle } from "../../ui/style";

const style: WidgetStyle = {
  accent: (text) => text,
  muted: (text) => text,
  width: (text) => Array.from(text).length,
  fit: (text, width) => Array.from(text).slice(0, Math.max(0, width)).join(""),
};
const now = 1_000_000_000;
const watch = (label: string, seconds: number) => ({
  label,
  started: now - seconds * 1000,
});

test("armed watches show name and elapsed time, then new quiet results", () => {
  expect(
    listeningLines(
      [watch("build-x", 72), watch("checks", 20)],
      2,
      now,
      80,
      style,
    ),
  ).toEqual(["◉ listening  build-x 1m12s · checks 20s · 2 new"]);
  expect(listeningLines([watch("checks", 20)], 0, now, 80, style)).toEqual([
    "◉ listening  checks 20s",
  ]);
  expect(listeningLines([], 1, now, 80, style)).toEqual(["◉ inbox  1 new"]);
});

test("nothing armed and nothing new hides the indicator", () => {
  expect(listeningLines([], 0, now, 80, style)).toEqual([]);
  expect(listeningLines([watch("x", 1)], 0, now, 0, style)).toEqual([]);
});

test("width-safe: drops watches that do not fit and says how many", () => {
  const many = Array.from({ length: 6 }, (_, i) => watch(`job-${i}`, 5));
  const [narrow] = listeningLines(many, 3, now, 40, style);
  expect(style.width(narrow)).toBeLessThanOrEqual(40);
  expect(narrow).toContain("job-0 5s");
  expect(narrow).toMatch(/\+\d · 3 new$/);
  for (const width of [1, 5, 12, 20, 33, 80])
    for (const row of listeningLines(many, 3, now, width, style))
      expect(style.width(row)).toBeLessThanOrEqual(width);
});

test("untrusted job names cannot inject control bytes", () => {
  const [row] = listeningLines(
    [watch("evil\x1b[2J\nname", 3)],
    0,
    now,
    80,
    style,
  );
  expect(row).not.toMatch(/[\x00-\x1f]/);
  expect(row).toContain("evil [2J name 3s");
});

test("durations are compact", () => {
  expect(duration(-5)).toBe("0s");
  expect(duration(59_999)).toBe("59s");
  expect(duration(72_000)).toBe("1m12s");
  expect(duration(3_600_000 + 5 * 60_000)).toBe("1h05m");
});
