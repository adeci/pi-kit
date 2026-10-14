import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  mixColors,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { clean } from "./state";

export type GitCounts = { staged: number; unstaged: number; untracked: number };
export function gitCounts(output: string): GitCounts {
  const counts = { staged: 0, unstaged: 0, untracked: 0 };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const code = records[i].slice(0, 2);
    if (code === "??") counts.untracked++;
    else if (code.length === 2) {
      if (code[0] !== " ") counts.staged++;
      if (code[1] !== " ") counts.unstaged++;
      if (/[RC]/.test(code)) i++;
    }
  }
  return counts;
}

export type StatusInfo = {
  model: string;
  thinking: string;
  path: string;
  branch?: string;
  git?: GitCounts;
  percent?: number | null;
  window?: number;
  elapsed?: number;
  cost: number;
  title: string;
  statuses: string[];
};
const effort: Record<string, string> = {
  off: "○",
  minimal: "○",
  low: "◔",
  medium: "◑",
  high: "◒",
  xhigh: "◕",
  max: "◉",
};
const compact = (n: number) =>
  n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${+(n / 1000).toFixed(1)}K`
      : `${n}`;
function tail(text: string, width: number, icons: boolean) {
  if (visibleWidth(text) <= width) return text;
  const mark = icons ? "…" : "~";
  return (
    mark +
    sliceByColumn(text, Math.max(0, visibleWidth(text) - width + 1), width - 1)
  );
}

/** OMP's classic cosine sweep: 30 cells/s, padding 10, half-width 6.
 * Keep its motion, but blend a quiet highlight instead of bold color tiers. */
function shimmer(theme: Theme, text: string, elapsed: number): string {
  const chars = Array.from(text);
  const position = ((elapsed / 1000) * 30) % (chars.length + 20);
  return chars
    .map((char, index) => {
      const distance = Math.abs(index + 10 - position);
      const intensity =
        distance >= 6 ? 0 : 0.5 * (1 + Math.cos((Math.PI * distance) / 6));
      return theme.style(char, {
        fg: mixColors(
          theme.colors.syntaxKeyword,
          theme.colors.text,
          intensity * 0.45,
        ),
      });
    })
    .join("");
}

/** OMP plain/compact segments and path-first fitting; see ../NOTICE. */
export function statusLine(
  theme: Theme,
  width: number,
  info: StatusInfo,
  icons = true,
): string {
  if (width < 3) return " ".repeat(Math.max(0, width));
  width -= 2;
  const fg = (color: Parameters<Theme["fg"]>[0], value: string) =>
    theme.fg(color, value);
  const sep = fg("dim", icons ? " · " : " | ");
  const icon = (glyph: string, text: string) =>
    icons ? `${glyph} ${text}` : text;
  const activity = fg(
    info.elapsed === undefined ? "muted" : "accent",
    icons ? "λ" : "lambda",
  );
  const counts = info.git;
  const changes = counts
    ? [
        counts.unstaged ? fg("warning", `*${counts.unstaged}`) : "",
        counts.staged ? fg("success", `+${counts.staged}`) : "",
        counts.untracked ? fg("muted", `?${counts.untracked}`) : "",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const context = `${info.percent == null ? "?" : +info.percent.toFixed(1)}%${info.window ? `/${compact(info.window)}` : ""}`;
  const model = clean(info.model).replace(/^Claude /, "");
  const path = clean(info.path);
  let pathWidth = Math.min(40, visibleWidth(path));
  let modelWidth = Math.min(48, visibleWidth(model));
  const parts = new Map<string, string>([
    ["activity", activity],
    ["model", ""],
    ["path", ""],
    [
      "git",
      info.branch
        ? fg("warning", icon("⑂", clean(info.branch))) +
          (changes ? " " + changes : "")
        : "",
    ],
    [
      "context",
      fg(
        (info.percent ?? 0) >= 90
          ? "error"
          : (info.percent ?? 0) >= 75
            ? "warning"
            : "accent",
        icon("◫", context),
      ),
    ],
    ["cost", info.cost > 0 ? fg("success", `$${info.cost.toFixed(2)}`) : ""],
  ]);
  const elastic = () => {
    parts.set(
      "model",
      fg(
        "syntaxKeyword",
        icon(effort[info.thinking] ?? "⬢", truncateToWidth(model, modelWidth)),
      ),
    );
    parts.set(
      "path",
      fg("syntaxType", icon("📁", tail(path, pathWidth, icons))),
    );
  };
  const joined = () => [...parts.values()].filter(Boolean).join(sep);
  elastic();
  while (visibleWidth(joined()) > width && pathWidth > 6) {
    pathWidth--;
    elastic();
  }
  while (visibleWidth(joined()) > width && modelWidth > 12) {
    modelWidth--;
    elastic();
  }
  const drop = ["git", "path", "model", "context", "cost"];
  for (const key of drop) {
    if (visibleWidth(joined()) <= width) break;
    parts.delete(key);
  }
  // Animate only the fitted model once, not during every width-fitting step.
  if (parts.has("model") && info.elapsed !== undefined) {
    parts.set(
      "model",
      (icons ? fg("syntaxKeyword", (effort[info.thinking] ?? "⬢") + " ") : "") +
        shimmer(theme, clean(truncateToWidth(model, modelWidth)), info.elapsed),
    );
  }
  let result = truncateToWidth(joined(), width);
  const separator = icons ? " · " : " | ";
  const space = width - visibleWidth(result) - 2;
  const right = [...info.statuses.map(clean), clean(info.title)]
    .filter(Boolean)
    .join(separator);
  if (right && space >= 12) {
    const text = truncateToWidth(right, space);
    result +=
      " ".repeat(width - visibleWidth(result) - visibleWidth(text)) +
      fg("dim", text);
  }
  const line = truncateToWidth(result, width);
  return " " + line + " ".repeat(Math.max(1, width - visibleWidth(line) + 1));
}
