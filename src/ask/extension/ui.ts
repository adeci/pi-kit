import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  answered,
  result,
  summary,
  type Answer,
  type Question,
  type Result,
} from "./state";

const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** The dialog rises from the bottom and sizes to its content, up to this share of the terminal. */
const HEIGHT_RATIO = 0.7;
const MIN_HEIGHT = 8;
/** Option descriptions beyond this many lines are clipped unless the row is focused. */
const DESCRIPTION_ROWS = 2;
const CHIP_WIDTH = 16;

const askOptions = {
  overlay: true,
  overlayOptions: {
    width: "90%" as const,
    maxHeight: "70%" as const,
    anchor: "bottom-center" as const,
    margin: 1,
  },
};

/** Rounded card with the title in the top border and key hints in the bottom border. */
function frame(
  theme: Theme,
  width: number,
  title: string,
  progress: string,
  body: string[],
  hint: string,
): string[] {
  if (width < 12)
    return [truncateToWidth("Enlarge terminal · Esc cancels", width)];
  const border = (text: string) => theme.fg("border", text);
  const inner = width - 4;
  const row = (text: string) => {
    const clipped = truncateToWidth(text, inner);
    return `${border("│")} ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} ${border("│")}`;
  };
  const edge = (left: string, label: string, right: string, end: string) => {
    // Drop the right-hand label first, then truncate the left one.
    const room = width - 2;
    let start = label ? ` ${label} ` : "";
    let finish = right ? ` ${right} ` : "";
    if (visibleWidth(start) + visibleWidth(finish) + 2 > room) finish = "";
    if (visibleWidth(start) + 2 > room)
      start = truncateToWidth(start, room - 2);
    const fill = room - 1 - visibleWidth(start) - visibleWidth(finish) - 1;
    return (
      border(`${left}─`) +
      start +
      border("─".repeat(Math.max(0, fill))) +
      finish +
      border(`─${end}`)
    );
  };
  return [
    edge("╭", theme.fg("accent", theme.bold(title)), progress, "╮"),
    row(""),
    ...body.map(row),
    row(""),
    edge("╰", theme.fg("dim", hint), "", "╯"),
  ];
}

export async function questionnaire(
  ctx: ExtensionContext,
  questions: Question[],
  signal: AbortSignal,
): Promise<Result> {
  return ctx.ui.custom<Result>((tui, theme, _keys, done) => {
    const drafts: Answer[] = questions.map((q) => ({
      id: q.id,
      selected: [],
      text: "",
    }));
    const single = questions.length === 1;
    // Start on the recommended option so accepting it is one keypress; this
    // never selects it on the user's behalf.
    const start = (index: number) =>
      Math.max(
        0,
        questions[index]?.options?.findIndex(
          (option) => option.id === questions[index].recommended,
        ) ?? 0,
      );
    let page = 0,
      cursor = start(0),
      editing = false,
      closed = false,
      offset = 0,
      manualScroll = false;
    const editor = new Editor(tui, {
      borderColor: (text) => theme.fg("border", text),
      selectList: getSelectListTheme(),
    });
    const finish = (status: Result["status"]) => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", abort);
      done(result(questions, drafts, status));
    };
    const abort = () => finish("cancelled");
    signal.addEventListener("abort", abort, { once: true });
    const move = (next: number) => {
      // A lone question has nothing to review: answering it submits.
      if (single && next > 0) {
        if (answered(questions[0], drafts[0])) finish("answered");
        return;
      }
      page = Math.max(0, Math.min(questions.length, next));
      cursor = start(page);
      offset = 0;
      manualScroll = false;
    };
    editor.onSubmit = (text) => {
      if (!text.trim()) return;
      drafts[page].text = text.trim();
      if (!questions[page].multi) drafts[page].selected = [];
      editing = false;
      move(page + 1);
    };
    const edit = () => {
      editing = true;
      editor.setText(drafts[page].text);
    };
    if (signal.aborted) abort();

    const accent = (text: string) => theme.fg("accent", text);
    const dim = (text: string) => theme.fg("dim", text);
    const muted = (text: string) => theme.fg("muted", text);
    const success = (text: string) => theme.fg("success", text);

    /** Question progress chips; only shown when there is more than one question. */
    const chips = () =>
      [
        ...questions.map((item, i) => {
          const label = truncateToWidth(clean(item.id), CHIP_WIDTH);
          if (i === page) return accent(theme.bold(`● ${label}`));
          return answered(item, drafts[i])
            ? success(`✓ ${label}`)
            : dim(`○ ${label}`);
        }),
        page === questions.length
          ? accent(theme.bold("● Review"))
          : dim("○ Review"),
      ].join(dim("  "));

    return {
      get focused() {
        return editor.focused;
      },
      set focused(value: boolean) {
        editor.focused = value;
      },
      dispose() {
        signal.removeEventListener("abort", abort);
      },
      invalidate() {
        editor.invalidate();
      },
      render(width: number) {
        const inner = Math.max(1, width - 4);
        const q = questions[page];
        const body: string[] = [];
        let focus = 0;
        const add = (text: string, indent = "") => {
          const wrapped = wrapTextWithAnsi(
            text,
            Math.max(1, inner - visibleWidth(indent)),
          );
          body.push(...wrapped.map((line) => indent + line));
        };
        if (!single) {
          add(chips());
          body.push("");
        }
        let hint: string;
        if (editing) {
          add(theme.bold(clean(q.question)));
          body.push("");
          add(dim("Your answer"));
          body.push(...editor.render(inner));
          hint = "enter save · shift+enter newline · esc back";
        } else if (!q) {
          add(theme.bold("Review answers"));
          body.push("");
          for (const [i, item] of questions.entries()) {
            add(`${dim(`${i + 1}.`)} ${clean(item.question)}`);
            const done = answered(item, drafts[i]);
            add(
              done
                ? accent(clean(summary(item, drafts[i])))
                : theme.fg("warning", "unanswered"),
              "   ",
            );
          }
          body.push("");
          focus = body.length;
          add(
            questions.every((item, i) => answered(item, drafts[i]))
              ? accent(theme.bold("❯ Submit answers"))
              : theme.fg(
                  "warning",
                  "Answer every question before submitting. ← returns to questions.",
                ),
          );
          hint = "enter submit · ← back · esc cancel";
        } else {
          add(theme.bold(clean(q.question)));
          body.push("");
          const options = q.options ?? [];
          options.forEach((option, i) => {
            const focused = i === cursor;
            if (focused) focus = body.length;
            const checked = drafts[page].selected.includes(option.id);
            const marker = q.multi
              ? checked
                ? "☑"
                : "☐"
              : checked
                ? "●"
                : "○";
            const label = clean(option.label);
            const badge =
              q.recommended === option.id
                ? `  ${theme.fg("warning", "★ recommended")}`
                : "";
            add(
              `${focused ? accent("❯") : " "} ${checked ? success(marker) : dim(marker)} ${
                focused
                  ? accent(theme.bold(label))
                  : checked
                    ? success(label)
                    : label
              }${badge}`,
            );
            if (option.description) {
              const lines = wrapTextWithAnsi(
                muted(clean(option.description)),
                Math.max(1, inner - 6),
              );
              const shown = focused ? lines : lines.slice(0, DESCRIPTION_ROWS);
              if (shown.length < lines.length)
                shown[shown.length - 1] += muted("…");
              body.push(...shown.map((line) => `      ${line}`));
            }
          });
          const otherFocused = cursor === options.length;
          if (otherFocused) focus = body.length;
          const otherLabel = options.length ? "Other…" : "Write your answer";
          add(
            `${otherFocused ? accent("❯") : " "} ${dim("✎")} ${
              otherFocused ? accent(theme.bold(otherLabel)) : muted(otherLabel)
            }`,
          );
          if (drafts[page].text)
            add(muted(`“${clean(drafts[page].text)}”`), "      ");
          const select = q.multi ? "space toggle · enter next" : "enter select";
          const pages = single ? "" : " · ←→ questions";
          hint = `↑↓ move · ${select}${pages} · esc cancel`;
        }
        // Size to content; only scroll when the content exceeds the cap.
        const cap = Math.max(
          MIN_HEIGHT,
          Math.floor(tui.terminal.rows * HEIGHT_RATIO),
        );
        const available = Math.max(1, cap - 4);
        if (!manualScroll && !editing) {
          if (focus < offset) offset = focus;
          if (focus >= offset + available) offset = focus - available + 1;
        }
        offset = Math.max(
          0,
          Math.min(offset, Math.max(0, body.length - available)),
        );
        const overflow = body.length > available;
        const progress = overflow
          ? dim(
              `${offset + 1}–${Math.min(body.length, offset + available)}/${body.length}`,
            )
          : single
            ? ""
            : dim(
                page === questions.length
                  ? "review"
                  : `${page + 1}/${questions.length}`,
              );
        return frame(
          theme,
          width,
          "? Ask",
          progress,
          body.slice(offset, offset + available),
          overflow ? `${hint} · pgup/pgdn scroll` : hint,
        );
      },
      handleInput(data: string) {
        if (closed) return;
        if (editing) {
          if (matchesKey(data, "escape")) editing = false;
          else editor.handleInput(data);
        } else if (matchesKey(data, "escape")) finish("cancelled");
        else if (
          !single &&
          (matchesKey(data, "left") || matchesKey(data, "shift+tab"))
        )
          move(page - 1);
        else if (
          !single &&
          (matchesKey(data, "right") || matchesKey(data, "tab"))
        )
          move(page + 1);
        else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
          offset += matchesKey(data, "pageUp") ? -5 : 5;
          manualScroll = true;
        } else {
          const q = questions[page],
            options = q?.options ?? [];
          manualScroll = false;
          if (q && matchesKey(data, "up")) cursor = Math.max(0, cursor - 1);
          else if (q && matchesKey(data, "down"))
            cursor = Math.min(options.length, cursor + 1);
          else if (matchesKey(data, "enter") || data === " ") {
            if (!q) {
              if (
                matchesKey(data, "enter") &&
                questions.every((item, i) => answered(item, drafts[i]))
              )
                finish("answered");
            } else if (cursor === options.length) edit();
            else if (q.multi) {
              if (data === " ") {
                const selected = drafts[page].selected;
                const id = options[cursor].id;
                drafts[page].selected = selected.includes(id)
                  ? selected.filter((value) => value !== id)
                  : [...selected, id];
              } else if (answered(q, drafts[page])) move(page + 1);
            } else {
              drafts[page] = {
                id: q.id,
                selected: [options[cursor].id],
                text: "",
              };
              if (matchesKey(data, "enter")) move(page + 1);
            }
          }
        }
        tui.requestRender();
      },
    };
  }, askOptions);
}
