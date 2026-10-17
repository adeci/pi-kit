// Load with `pi --offline --no-extensions -e ./src/usage/tests/rendering.ts`.
// Assertions use the real SDK; the extension exits before starting a session.
import assert from "node:assert/strict";
import { stripVTControlCharacters as strip } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { cardLines, usageFrame } from "../extension/view";
import type { Card } from "../extension/state";

const theme: any = {
  fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const now = 1_000_000;
const cards: Card[] = [
  {
    provider: "openai-codex",
    report: {
      provider: "openai-codex",
      fetchedAt: now,
      meters: [{ label: "7d", used: 1, reset: now + 60_000 }],
    },
  },
  {
    provider: "anthropic",
    report: {
      provider: "anthropic",
      fetchedAt: now,
      meters: [
        { label: "5h", used: 0, reset: now + 3_600_000 },
        { label: "7d", used: 99, reset: now + 86_400_000 },
        { label: "7d · Fable", used: 100 },
      ],
    },
  },
];
function render(width: number, input = cards) {
  const frame = usageFrame(theme, width, 100, input, false, 0, now);
  assert(frame.lines.every((line) => visibleWidth(line) <= width));
  return frame.lines.map(strip);
}
function bars(lines: string[]) {
  return lines.filter((line) => /[█░·]{3}/.test(line));
}
function assertAligned(lines: string[]) {
  const positions = bars(lines).map((line) => {
    const match = /[█░·]{3,}/.exec(line)!;
    return [visibleWidth(line.slice(0, match.index)), visibleWidth(match[0])];
  });
  assert.equal(positions.length, 4);
  assert(
    positions.every((position) => String(position) === String(positions[0])),
    `bars must share columns: ${JSON.stringify(positions)}`,
  );
}
for (const width of [70, 80, 100, 140, 220]) {
  const lines = render(width);
  assertAligned(lines);
  const inline = bars(lines).map((line) => line.includes("% remaining"));
  assert(
    inline.every((value) => value === inline[0]),
    "one layout for every provider/window",
  );
  if (inline[0]) {
    for (const marker of ["% remaining", "% used", "⟲"]) {
      const columns = bars(lines).map((line) => line.indexOf(marker));
      assert(
        columns.every((column) => column === columns[0]),
        `${marker} column`,
      );
    }
  }
}
const long = structuredClone(cards);
long[1].report!.meters[0].label =
  "7d · 非常に長いモデル名 " + "extended ".repeat(20);
for (const width of [12, 24, 40, 60, 80, 140, 220]) {
  assertAligned(render(width, long));
}
const unknown = structuredClone(cards);
unknown[1].report!.meters[0].used = undefined;
unknown[1].report!.meters[1].reset = now - 1;
for (const width of [60, 100, 140, 220]) {
  const lines = render(width, unknown);
  assertAligned(lines);
  assert(lines.some((line) => line.includes("usage not reported")));
  assert(lines.some((line) => line.includes("reset due; refresh")));
}
for (const width of [12, 24, 40, 60]) {
  const known = structuredClone(cards[0]);
  const missing = structuredClone(known);
  missing.report!.meters[0].used = undefined;
  assert.equal(
    cardLines(known, theme, width, now).length,
    cardLines(missing, theme, width, now).length,
    "compact meters retain the same row count when usage is unknown",
  );
}
// Resize back to the same width must not retain an earlier layout.
const beforeResize = render(140);
render(60);
render(220);
assert.deepEqual(render(140), beforeResize);
for (const width of [8, 11]) render(width);
// Short frames must scroll without overflowing and clamp stale resize offsets.
let offset = 0;
for (const width of [140, 40, 24, 140]) {
  for (const rows of [9, 12, 20]) {
    const top = usageFrame(theme, width, rows, cards, false, -1, now);
    const bottom = usageFrame(theme, width, rows, cards, false, 10_000, now);
    assert.equal(top.offset, 0);
    assert.equal(bottom.offset, Math.max(0, bottom.length - bottom.capacity));
    const resized = usageFrame(theme, width, rows, cards, false, offset, now);
    assert.equal(
      resized.offset,
      Math.max(0, Math.min(offset, resized.length - resized.capacity)),
    );
    for (const frame of [top, bottom, resized]) {
      assert(frame.lines.length <= rows);
      assert(frame.lines.every((line) => visibleWidth(line) <= width));
      if (frame.length > frame.capacity)
        assert(frame.lines.some((line) => strip(line).includes("↑↓ scroll")));
    }
    offset = bottom.offset;
  }
}
for (const rows of [1, 4, 8]) {
  const frame = usageFrame(theme, 40, rows, cards, false, offset, now);
  assert.equal(frame.lines.length, 1);
  assert.equal(frame.offset, 0);
}
if (process.env.PI_USAGE_TEST_PREVIEW) {
  for (const width of [140, 70, 40, 24]) {
    console.log(
      `\nUsage preview: ${width} columns\n${render(width).join("\n")}`,
    );
  }
}
console.log(
  "PASS usage shared columns, responsive layouts, percentage boundaries, ANSI and wide labels",
);
export default function () {
  process.exit(0);
}
