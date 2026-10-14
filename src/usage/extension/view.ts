import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { clean, resetText, type Card } from "./state";

const names = { "openai-codex": "OpenAI Codex", anthropic: "Anthropic Claude" };

/** OMP's used-fraction bars and free percentage, with explicit used/remaining labels. */
export function cardLines(
  card: Card,
  theme: Theme,
  width: number,
  now = Date.now(),
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
    const label = clean(meter.label)
      .replace(/^(\d+)h\b/, "$1 hours")
      .replace(/^(\d+)d\b/, "$1 days");
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
        : fg(tone, `${100 - Math.round(used)}% remaining`) +
          fg("dim", ` · ${Math.round(used)}% used`);
    const reset =
      meter.reset === undefined
        ? "reset ?"
        : resetText(meter.reset, now)
            .replace(/^resets in /, "")
            .replace(/\s+(?=\d)/g, "");
    const suffix = ` ${percentages} ${fg("dim", `⟲ ${reset}`)}`;
    const prefix = `  ${fg("muted", label)} `;
    const cells = width - visibleWidth(prefix) - visibleWidth(suffix);
    const bar = (size: number) => {
      if (used === undefined) return fg("dim", "·".repeat(size));
      const filled = Math.round((size * used) / 100);
      return (
        fg(tone, "█".repeat(filled)) + fg("dim", "░".repeat(size - filled))
      );
    };
    if (cells >= 24) lines.push(prefix + bar(cells) + suffix);
    else {
      // Stack labels rather than squeeze a wide meter into a tiny sparkline.
      lines.push(
        ...wrapTextWithAnsi(
          `  ${fg("muted", label)} ${fg("dim", `⟲ ${reset}`)}`,
          width,
        ),
      );
      lines.push("  " + bar(Math.max(1, width - 2)));
      lines.push(...wrapTextWithAnsi("  " + percentages, width));
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
  const body = visible.flatMap((card, i) => [
    ...(i ? [""] : []),
    ...cardLines(card, theme, inner, now),
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
