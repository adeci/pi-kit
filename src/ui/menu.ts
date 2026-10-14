import {
  getSelectListTheme,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  Editor,
  SelectList,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type SelectItem,
} from "@earendil-works/pi-tui";

export const menuOptions = {
  overlay: true,
  overlayOptions: {
    width: "90%" as const,
    maxHeight: "90%" as const,
    anchor: "center" as const,
    margin: 1,
  },
};
export const menuHeight = (rows: number) => Math.max(7, Math.floor(rows * 0.9));

/** OMP-style card chrome around stock Pi components. No separate terminal renderer. */
export function menuFrame(
  theme: Theme,
  width: number,
  height: number,
  title: string,
  tabs: string,
  body: string[],
  hint: string,
  dividers?: { column?: number; rows?: number[] },
): string[] {
  if (width < 6 || height < 7)
    return [truncateToWidth("Enlarge terminal · Esc closes", width)];
  const border = (text: string) => theme.fg("border", text);
  const row = (text: string) => {
    const clipped = truncateToWidth(text, width - 4);
    return `${border("│")} ${clipped}${" ".repeat(Math.max(0, width - 4 - visibleWidth(clipped)))} ${border("│")}`;
  };
  const shown = truncateToWidth(` ${title} `, width - 4);
  const rule = (junction = "─") => {
    const column = dividers?.column;
    return column === undefined
      ? border(`├${"─".repeat(width - 2)}┤`)
      : border(
          `├${"─".repeat(column + 1)}${junction}${"─".repeat(Math.max(0, width - column - 4))}┤`,
        );
  };
  const result = [
    border("╭─") +
      theme.fg("accent", theme.bold(shown)) +
      border("─".repeat(Math.max(0, width - 3 - visibleWidth(shown))) + "╮"),
    row(tabs),
    rule("┬"),
  ];
  for (let i = 0; i < height - 6; i++)
    result.push(dividers?.rows?.includes(i) ? rule("┼") : row(body[i] ?? ""));
  result.push(
    rule("┴"),
    row(theme.fg("muted", hint)),
    border(`╰${"─".repeat(width - 2)}╯`),
  );
  return result;
}

/** Searchable stock Pi selector used for models and thinking levels. */
export async function choose(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
  current?: string,
) {
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const input = new Input();
    input.focused = true;
    let list: SelectList,
      height = 0;
    const rebuild = (force = false) => {
      const next = menuHeight(tui.terminal.rows);
      if (height === next && !force) return;
      // A changed search selects its best match; resizing preserves selection.
      const selected = force
        ? undefined
        : (list?.getSelectedItem()?.value ?? current);
      height = next;
      const filtered = fuzzyFilter(
        items,
        input.getValue(),
        (item) => `${item.label} ${item.description ?? ""} ${item.value}`,
      );
      list = new SelectList(filtered, Math.max(1, height - 10), {
        ...getSelectListTheme(),
        noMatch: () => theme.fg("muted", "  No matches"),
      });
      const index = filtered.findIndex((item) => item.value === selected);
      if (index >= 0) list.setSelectedIndex(index);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
    };
    rebuild();
    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render(width: number) {
        rebuild();
        return menuFrame(
          theme,
          width,
          height,
          title,
          "Choose a value",
          [
            "Search",
            ...input.render(Math.max(1, width - 4)),
            "",
            ...list.render(Math.max(1, width - 4)),
          ],
          "↑↓ select · type to filter · Enter save · Esc back",
        );
      },
      handleInput(data: string) {
        if (
          matchesKey(data, "up") ||
          matchesKey(data, "down") ||
          matchesKey(data, "enter") ||
          matchesKey(data, "escape")
        )
          list.handleInput(data);
        else {
          input.handleInput(data);
          rebuild(true);
        }
        tui.requestRender();
      },
      invalidate() {
        input.invalidate();
        list.invalidate();
      },
    };
  }, menuOptions);
}

/** Multiline editing with the same card chrome and stock editor keybindings. */
export async function editText(
  ctx: ExtensionContext,
  title: string,
  initial = "",
  hint = "Enter saves · Shift-Enter newline · Esc discards",
) {
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const editor = new Editor(tui, {
      borderColor: (text) => theme.fg("border", text),
      selectList: getSelectListTheme(),
    });
    editor.focused = true;
    editor.setText(initial);
    editor.onSubmit = (value) => done(value);
    return {
      get focused() {
        return editor.focused;
      },
      set focused(value: boolean) {
        editor.focused = value;
      },
      render: (width: number) =>
        menuFrame(
          theme,
          width,
          menuHeight(tui.terminal.rows),
          title,
          "Edit value",
          editor.render(Math.max(1, width - 4)),
          hint,
        ),
      handleInput(data: string) {
        if (matchesKey(data, "escape")) done(undefined);
        else editor.handleInput(data);
        tui.requestRender();
      },
      invalidate() {
        editor.invalidate();
      },
    };
  }, menuOptions);
}
