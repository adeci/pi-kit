import type { WidgetStyle } from "../../ui/style";

export interface ListeningWatch {
  /** Job name, or a short handle when the job is unnamed. */
  label: string;
  /** Epoch milliseconds when the job started (or was submitted). */
  started: number;
}

const line = (text: string) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/** One width-safe line: armed job watches with elapsed time, then quiet
 * results that arrived since the user's last prompt. Empty when idle. */
export function listeningLines(
  watches: ListeningWatch[],
  fresh: number,
  now: number,
  columns: number,
  style: WidgetStyle,
): string[] {
  if ((!watches.length && fresh < 1) || columns < 1) return [];
  const separator = style.muted(" · ");
  const head =
    style.accent("◉ ") + style.accent(watches.length ? "listening" : "inbox");
  const tail = fresh > 0 ? style.accent(`${fresh} new`) : "";
  const chunks = watches.map(
    (watch) =>
      `${line(watch.label) || "job"} ${style.muted(duration(now - watch.started))}`,
  );
  // Keep as many watches as fit, then say how many were left out.
  let shown = chunks.length;
  const build = (count: number) => {
    const parts = chunks.slice(0, count);
    if (count < chunks.length)
      parts.push(style.muted(`+${chunks.length - count}`));
    if (tail) parts.push(tail);
    return parts.length ? `${head}  ${parts.join(separator)}` : head;
  };
  while (shown > 0 && style.width(build(shown)) > columns) shown--;
  return [style.fit(build(shown), columns)];
}
