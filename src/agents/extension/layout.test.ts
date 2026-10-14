import { expect, test } from "bun:test";
import { treeGutters, splitPaneLayout } from "../../ui/layout";
test("tree continuations connect activity rows and nested children", () => {
  expect(treeGutters([{ depth: 1 }, { depth: 2 }, { depth: 1 }])).toEqual([
    { branch: "├─ ", continuation: "│  " },
    { branch: "│ └─ ", continuation: "│    " },
    { branch: "└─ ", continuation: "   " },
  ]);
  expect(treeGutters([{ depth: 1 }], true)[0]).toEqual({
    branch: "├─ ",
    continuation: "│  ",
  });
});
test("wide inspector allocates independent panes with a joined divider", () => {
  const layout = splitPaneLayout(100, 30);
  expect(layout.split).toBe(true);
  expect(layout.listWidth + layout.streamWidth + 2).toBe(100);
  expect(layout.streamRows + 2).toBe(30);
  expect(layout.dividerColumn).toBe(layout.listWidth);
});
test("narrow inspector stacks both panes within available height", () => {
  const layout = splitPaneLayout(38, 20);
  expect(layout.split).toBe(false);
  expect(layout.listRows + layout.streamRows + 3).toBe(20);
  expect(layout.streamWidth).toBe(38);
  expect(layout.dividerColumn).toBeUndefined();
});
