import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { text } from "./completions";

export function safeText(value: unknown): string {
  return String(value ?? "").replace(
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g,
    " ",
  );
}
export function completionRenderer(
  pi: ExtensionAPI,
  type: string,
  describe: (
    details: unknown,
    content: string,
  ) => { title: string; summary: string },
) {
  pi.registerMessageRenderer(type, (message, options, theme) => {
    const content = safeText(text(message.content));
    const description = describe(message.details, content);
    return {
      invalidate() {},
      render(width: number) {
        const title = theme.fg(
          "accent",
          safeText(description.title).replace(/\n/g, " "),
        );
        if (options.expanded)
          return new Text(
            title + "\n" + theme.fg("toolOutput", content),
            0,
            0,
          ).render(width);
        const summary = truncateToWidth(
          safeText(description.summary).replace(/\n/g, " "),
          Math.max(1, width) * 2,
        );
        return new Text(
          truncateToWidth(title, Math.max(1, width) * 3) +
            "\n" +
            theme.fg("muted", summary) +
            theme.fg("dim", "\nCtrl+O expands details"),
          0,
          0,
        ).render(width);
      },
    };
  });
}
