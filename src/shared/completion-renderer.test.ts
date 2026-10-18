import { expect, mock, test } from "bun:test";
// Width-faithful stand-ins: count code points, ignore the fake theme markup.
const visible = (text: string) => text.replace(/<\/?[a-zA-Z]*>|\*/g, "");
mock.module("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string, width: number) => {
    let out = "";
    let shown = 0;
    for (const part of text.split(/(<\/?[a-zA-Z]*>)/)) {
      if (/^<\/?[a-zA-Z]*>$/.test(part)) out += part;
      else
        for (const char of part) {
          if (char !== "*" && shown >= width) return out;
          if (char !== "*") shown++;
          out += char;
        }
    }
    return out;
  },
  wrapTextWithAnsi: (text: string, width: number) => {
    const plain = visible(text);
    const rows: string[] = [];
    for (let at = 0; at < plain.length || !rows.length; at += width)
      rows.push(plain.slice(at, at + width));
    return rows;
  },
}));
const { completionRenderer } = await import("./completion-renderer");

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</>`,
  bold: (text: string) => `*${text}*`,
};
function render(expanded: boolean, width = 80) {
  let renderer: any;
  completionRenderer(
    {
      registerMessageRenderer: (_: string, value: any) => (renderer = value),
    } as any,
    "test",
    () => ({
      tone: "error",
      glyph: "✗",
      title: "checks\nname",
      meta: ["failed", undefined, "exit 1", "44s", "job 33"],
      preview: ["error: broken\u001b[31m"],
      body: "Compiling noise\nerror: broken",
    }),
  );
  return renderer(
    { content: "[external event: x]\nraw", details: {} },
    { expanded, outputPad: 1 },
    theme,
  ).render(width);
}
test("collapsed card: accent bar, glyph, bold title, dim chips, gutter preview, hint", () => {
  expect(render(false)).toEqual([
    " <error>▌</> <error>✗</> *<text>checks name</>*  <dim>failed · exit 1 · 44s · job 33</>",
    " <error>▌</> <muted>│</> <muted>error: broken [31m</>",
    " <error>▌</> <muted>╰</> <dim>Ctrl+O expands</>",
  ]);
});
test("expanded card shows the body on the gutter, never the raw event banner", () => {
  const rows = render(true);
  expect(rows[0]).toContain("<error>✗</>");
  expect(rows.slice(1)).toEqual([
    " <error>▌</> <muted>│</> Compiling noise",
    " <error>▌</> <muted>│</> error: broken",
  ]);
  expect(rows.join("\n")).not.toContain("external event");
  expect(rows.join("\n")).not.toContain("Ctrl+O");
});
test("every row fits narrow widths, collapsed and expanded", () => {
  for (const width of [1, 4, 12, 30])
    for (const expanded of [false, true])
      for (const row of render(expanded, width))
        expect(Array.from(visible(row)).length).toBeLessThanOrEqual(width);
});
