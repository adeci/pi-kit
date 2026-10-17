import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { clean, resetText, type Card } from "./state";

const names = { "openai-codex": "OpenAI Codex", anthropic: "Anthropic Claude" };

const meterLabel = (label: string) =>
  clean(label)
    .replace(/^(\d+)h\b/, "$1 hours")
    .replace(/^(\d+)d\b/, "$1 days");
const meterReset = (reset: number | undefined, now: number) =>
  reset === undefined
    ? "reset ?"
    : resetText(reset, now)
        .replace(/^resets in /, "")
        .replace(/\s+(?=\d)/g, "");
const pad = (text: string, width: number) => {
  const shown = truncateToWidth(text, width);
  return shown + " ".repeat(Math.max(0, width - visibleWidth(shown)));
};

function meterLayout(cards: Card[], width: number, now: number) {
  const meters = cards
    .filter((card) => !card.hidden)
    .flatMap((card) =>
      (card.report?.meters ?? []).filter((meter) => !meter.detail),
    );
  const label = Math.min(
    24,
    Math.max(0, ...meters.map((m) => visibleWidth(meterLabel(m.label)))),
  );
  const reset = Math.max(
    0,
    ...meters.map((m) => visibleWidth(`⟲ ${meterReset(m.reset, now)}`)),
  );
  // Three-digit percentage fields keep 0/99/100 transitions in the same columns.
  const percentages = visibleWidth("100% remaining · 100% used");
  const bar = width - 2 - label - 1 - 1 - percentages - 1 - reset;
  return { label, reset, percentages, bar, inline: bar >= 24 };
}

/** OMP's used-fraction bars and free percentage, with explicit used/remaining labels. */
export function cardLines(
  card: Card,
  theme: Theme,
  width: number,
  now = Date.now(),
  layout = meterLayout([card], width, now),
): string[] {
  if (card.hidden) return [];
  const fg = (color: Parameters<Theme["fg"]>[0], text: string) =>
    theme.fg(color, text);
  const worst = Math.max(
    0,
    ...(card.report?.meters.map((m) => m.used ?? 0) ?? []),
  );
  const color = card.notice
    ? "warning"
    : worst >= 90
      ? "error"
      : worst >= 75
        ? "warning"
        : "success";
  const lines = [
    fg(color, card.notice ? "! " : "✓ ") +
      theme.bold(names[card.provider]) +
      (card.report?.plan ? fg("dim", ` · ${clean(card.report.plan)}`) : ""),
  ];
  if (card.notice)
    lines.push(...wrapTextWithAnsi(fg("warning", clean(card.notice)), width));
  for (const meter of card.report?.meters ?? []) {
    const label = meterLabel(meter.label);
    if (meter.detail) {
      const n = Number(meter.detail);
      const detail =
        meter.label === "Credit balance" && Number.isFinite(n) && n >= 0
          ? n.toLocaleString("en-US", { maximumFractionDigits: 2 })
          : clean(meter.detail);
      lines.push(
        ...wrapTextWithAnsi(fg("muted", `  ${label} · ${detail}`), width),
      );
      continue;
    }
    const used = meter.used;
    const tone =
      used === undefined
        ? "dim"
        : used >= 90
          ? "error"
          : used >= 75
            ? "warning"
            : "success";
    const percentages =
      used === undefined
        ? fg("dim", "usage not reported")
        : fg(tone, `${String(100 - Math.round(used)).padStart(3)}% remaining`) +
          fg("dim", ` · ${String(Math.round(used)).padStart(3)}% used`);
    const reset = fg("dim", `⟲ ${meterReset(meter.reset, now)}`);
    const suffix = ` ${pad(percentages, layout.percentages)} ${pad(reset, layout.reset)}`;
    const prefix = `  ${fg("muted", pad(label, layout.label))} `;
    const bar = (size: number) => {
      if (used === undefined) return fg("dim", "·".repeat(size));
      const filled = Math.round((size * used) / 100);
      return (
        fg(tone, "█".repeat(filled)) + fg("dim", "░".repeat(size - filled))
      );
    };
    if (layout.inline) lines.push(prefix + bar(layout.bar) + suffix);
    else {
      // Every meter uses the same compact structure, never a per-row wrap decision.
      const available = Math.max(1, width - 2);
      const labelWidth = Math.max(1, available - layout.reset - 1);
      if (available >= layout.reset + 5) {
        lines.push(`  ${fg("muted", pad(label, labelWidth))} ${reset}`);
      } else {
        lines.push(`  ${fg("muted", truncateToWidth(label, available))}`);
        lines.push(`  ${truncateToWidth(reset, available)}`);
      }
      lines.push("  " + bar(available));
      if (available >= layout.percentages) {
        lines.push("  " + percentages);
      } else {
        // Tiny terminals still get a fixed row count, including unknown usage.
        lines.push(
          "  " +
            truncateToWidth(
              used === undefined
                ? percentages
                : fg(tone, `${100 - Math.round(used)}% remaining`),
              available,
            ),
          used === undefined
            ? ""
            : "  " +
                truncateToWidth(
                  fg("dim", `${Math.round(used)}% used`),
                  available,
                ),
        );
      }
    }
  }
  return lines.map((line) => truncateToWidth(line, width));
}

export function usageFrame(
  theme: Theme,
  width: number,
  rows: number,
  cards: Card[],
  loading: boolean,
  offset: number,
  now = Date.now(),
  feedback?: string,
) {
  const inner = Math.max(1, width - 4);
  const visible = cards.filter((card) => !card.hidden);
  const layout = meterLayout(visible, inner, now);
  const body = visible.flatMap((card, i) => [
    ...(i ? [""] : []),
    ...cardLines(card, theme, inner, now, layout),
  ]);
  if (!body.length)
    body.push(
      theme.fg(
        "dim",
        loading
          ? "Checking subscriptions…"
          : "No logged-in subscriptions. Use /login.",
      ),
    );
  const fetched = visible.flatMap((card) =>
    card.report ? [card.report.fetchedAt] : [],
  );
  const age = fetched.length
    ? Math.max(0, Math.floor((now - Math.min(...fetched)) / 1000))
    : undefined;
  const checked = loading
    ? "refreshing…"
    : age === undefined
      ? ""
      : `${visible.some((card) => card.stale) ? "stale · " : ""}checked ${age}s ago`;
  const height = Math.max(7, Math.min(rows - 4, body.length + 6));
  const capacity = height - 5;
  const scroll = Math.max(0, Math.min(offset, body.length - capacity));
  if (width < 12 || rows < 9)
    return {
      lines: [truncateToWidth("Enlarge terminal · Esc closes", width)],
      capacity: 1,
      length: body.length,
      offset: 0,
    };
  const border = (text: string) => theme.fg("accent", text);
  const row = (text: string) => {
    const shown = truncateToWidth(text, inner);
    return (
      border("│ ") +
      shown +
      " ".repeat(Math.max(0, inner - visibleWidth(shown))) +
      border(" │")
    );
  };
  const title = " Usage ";
  const lines = [
    border("╭─") +
      theme.fg("syntaxKeyword", theme.bold(title)) +
      border("─".repeat(width - 3 - title.length) + "╮"),
    row(
      theme.fg(
        "dim",
        !loading && feedback ? `${feedback} · ${checked}` : checked,
      ),
    ),
  ];
  for (let i = 0; i < capacity; i++) lines.push(row(body[scroll + i] ?? ""));
  lines.push(
    border("├" + "─".repeat(width - 2) + "┤"),
    row(
      theme.fg(
        "dim",
        `${body.length > capacity ? "↑↓ scroll · " : ""}r refresh · Esc close`,
      ),
    ),
    border("╰" + "─".repeat(width - 2) + "╯"),
  );
  return { lines, capacity, length: body.length, offset: scroll };
}
