import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { text } from "./completions";

export function safeText(value: unknown): string {
  return String(value ?? "").replace(
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g,
    " ",
  );
}

/** A compact completion card: an accent bar in the status colour, a header
 * (glyph, bold title, dim detail chips), a short preview on a thin gutter, and
 * the full body only when expanded (Ctrl+O). Colours are theme tokens. */
export interface CompletionCard {
  tone: "success" | "error" | "warning" | "accent" | "muted";
  glyph: string;
  title: string;
  /** Dim header chips; empty entries are skipped. */
  meta?: (string | undefined)[];
  /** Collapsed preview lines. */
  preview?: string[];
  /** Expanded body; defaults to the message content. */
  body?: string;
}

const line = (value: unknown) => safeText(value).replace(/\n/g, " ");

export function completionRenderer(
  pi: ExtensionAPI,
  type: string,
  describe: (details: unknown, content: string) => CompletionCard,
) {
  pi.registerMessageRenderer(type, (message, options, theme) => {
    const content = safeText(text(message.content));
    const card = describe(message.details, content);
    const pad = " ".repeat(Math.max(0, options.outputPad ?? 1));
    return {
      invalidate() {},
      render(width: number) {
        const bar = pad + theme.fg(card.tone, "▌") + " ";
        const inner = Math.max(1, width - pad.length - 2);
        const meta = (card.meta ?? []).filter(Boolean).map(line).join(" · ");
        const rows = [
          truncateToWidth(
            `${theme.fg(card.tone, card.glyph)} ${theme.bold(theme.fg(card.tone === "muted" ? "muted" : "text", line(card.title)))}${meta ? "  " + theme.fg("dim", meta) : ""}`,
            inner,
          ),
        ];
        const gutter = theme.fg("muted", "│") + " ";
        if (options.expanded) {
          for (const row of safeText(card.body ?? content).split("\n"))
            for (const wrapped of wrapTextWithAnsi(
              theme.fg("toolOutput", row),
              Math.max(1, inner - 2),
            ))
              rows.push(gutter + wrapped);
        } else {
          for (const row of card.preview ?? [])
            rows.push(
              gutter + theme.fg("muted", truncateToWidth(line(row), inner - 2)),
            );
          rows.push(
            theme.fg("muted", "╰") + " " + theme.fg("dim", "Ctrl+O expands"),
          );
        }
        return rows.map((row) => truncateToWidth(bar + row, width));
      },
    };
  });
}
