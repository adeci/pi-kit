/** Tree gutters include continuation rows, including each visible ancestor. */
export function treeGutters(items: Array<{ depth: number }>, overflow = false) {
  const ancestors = new Map<number, boolean>();
  return items.map((item, index) => {
    const depth = Math.max(1, item.depth);
    const next = items.slice(index + 1).find((other) => other.depth <= depth);
    const sibling = next?.depth === depth || (overflow && depth === 1);
    for (const key of ancestors.keys()) if (key >= depth) ancestors.delete(key);
    let prefix = "";
    for (let level = 1; level < depth; level++)
      prefix += ancestors.get(level) ? "│ " : "  ";
    ancestors.set(depth, sibling);
    return {
      branch: prefix + (sibling ? "├─ " : "└─ "),
      continuation: prefix + (sibling ? "│  " : "   "),
    };
  });
}

/** Body geometry only; rendering and terminal-column measurement stay with Pi. */
export function splitPaneLayout(width: number, height: number) {
  const split = width >= 72;
  const listWidth = split
    ? Math.min(36, Math.max(24, Math.floor(width * 0.32)))
    : width;
  const listRows = split
    ? height - 2
    : Math.max(1, Math.floor((height - 3) * 0.3));
  return {
    split,
    listWidth,
    streamWidth: split ? width - listWidth - 2 : width,
    listRows,
    streamRows: split ? height - 2 : Math.max(1, height - listRows - 3),
    dividerRows: split ? [1] : [listRows + 1],
    dividerColumn: split ? listWidth : undefined,
  };
}
