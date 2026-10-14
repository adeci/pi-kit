import {
  CustomEditor,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { mixColors, visibleWidth } from "@earendil-works/pi-tui";
import { clean } from "./state";

type Frame = { theme: Theme; elapsed?: number; name?: string };
type Label = { start: number; end: number };

/** Replace only spare trailing strokes; never cover native status/overflow text. */
export function namedBorder(
  line: string,
  width: number,
  value?: string,
): { line: string; label?: Label } {
  const name = clean(value ?? "");
  const size = visibleWidth(name);
  const tail = /(─+)((?:\x1b\[[0-?]*[ -/]*[@-~])*)$/;
  const match = line.match(tail);
  if (!name || width < size + 6 || !match || match[1].length < size + 4)
    return { line };
  const start = visibleWidth(line) - size - 3;
  return {
    line: line.replace(
      tail,
      (_all, strokes: string, ansi: string) =>
        strokes.slice(0, -(size + 4)) + ` ${name} ──` + ansi,
    ),
    label: { start, end: start + size },
  };
}
type EditorFactory = NonNullable<
  Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]
>;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Paint border strokes and the requested label range without changing geometry. */
export function gradientBorder(
  line: string,
  width: number,
  { theme, elapsed }: Frame,
  label?: Label,
): string {
  if (elapsed === undefined || width < 2) return line;
  const phase = (elapsed % 6000) / 6000;
  const onset =
    (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, elapsed) / 300))) / 2;

  let column = 0;
  return line
    .split(/(\x1b\[[0-?]*[ -/]*[@-~])/g)
    .map((chunk) => {
      if (chunk.startsWith("\x1b")) return chunk;
      return Array.from(graphemes.segment(chunk), ({ segment }) => {
        const position = column / (width - 1);
        const inLabel =
          label !== undefined && column >= label.start && column < label.end;
        column += visibleWidth(segment);
        if (segment !== "─" && !inLabel) return segment;
        const blend = (1 + Math.cos(2 * Math.PI * (position - phase))) / 2;
        const color = mixColors(
          theme.colors.syntaxKeyword,
          theme.colors.syntaxType,
          blend,
        );
        return (
          theme.style(segment, {
            fg: mixColors(theme.colors.accent, color, onset),
          }) + theme.getFgAnsi("accent")
        );
      }).join("");
    })
    .join("");
}

/** All editing and application keybindings remain stock Pi behavior. */
export function statusEditor(current: () => Frame): EditorFactory {
  return (tui, theme, keys) =>
    new (class extends CustomEditor {
      private frame = current();
      private working = false;
      override setWorkingStatusIndicator(
        indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0],
      ) {
        this.working = indicator?.kind === "working";
        super.setWorkingStatusIndicator(indicator);
      }
      override render(width: number) {
        this.frame = current();
        // Keep Pi's shell-mode warning; only thinking-level color cycling changes.
        const shell = this.getText().trimStart().startsWith("!");
        if (shell) this.frame = { ...this.frame, elapsed: undefined };
        this.borderColor = (text) =>
          this.frame.theme.fg(shell ? "bashMode" : "accent", text);
        return super.render(width);
      }
      protected override renderTopBorder(width: number, hidden: number) {
        const named = namedBorder(
          super.renderTopBorder(width, hidden),
          width,
          this.frame.name,
        );
        return gradientBorder(
          named.line,
          width,
          this.frame,
          this.working ? { start: 0, end: width } : named.label,
        );
      }
      protected override renderBottomBorder(width: number, hidden: number) {
        return gradientBorder(
          super.renderBottomBorder(width, hidden),
          width,
          this.frame,
        );
      }
    })(tui, theme, keys, { embedWorkingStatus: true });
}
