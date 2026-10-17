import { expect, mock, test } from "bun:test";
// Real width handling is exercised by the agents TUI test.
mock.module("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string) => text,
  wrapTextWithAnsi: (text: string) => [text],
}));
const { completionRenderer } = await import("./completion-renderer");

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</>`,
  bold: (text: string) => `*${text}*`,
};
function render(expanded: boolean) {
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
      meta: ["failed", undefined, "exit 1", "44s"],
      preview: ["error: broken\u001b[31m"],
      body: "Compiling noise\nerror: broken",
    }),
  );
  return renderer(
    { content: "[external event: x]\nraw", details: {} },
    { expanded, outputPad: 1 },
    theme,
  ).render(80);
}
test("collapsed card: themed glyph, bold title, dimmed metadata, preview only", () => {
  expect(render(false)).toEqual([
    " <error>✗</> *<text>checks name</>*  <dim>failed · exit 1 · 44s</>",
    "   <muted>error: broken [31m</>",
    "   <dim>Ctrl+O expands</>",
  ]);
});
test("expanded card shows the body, never the raw event banner", () => {
  const rows = render(true);
  expect(rows[0]).toContain("<error>✗</>");
  expect(rows.slice(1)).toEqual([
    "   <toolOutput>Compiling noise</>",
    "   <toolOutput>error: broken</>",
  ]);
  expect(rows.join("\n")).not.toContain("external event");
});
