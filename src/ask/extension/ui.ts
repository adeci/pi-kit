import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { menuFrame, menuHeight, menuOptions } from "../../ui/menu";
import {
  answered,
  result,
  summary,
  type Answer,
  type Question,
  type Result,
} from "./state";

const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

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
    let page = 0,
      cursor = 0,
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
      page = Math.max(0, Math.min(questions.length, next));
      cursor = 0;
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
        const height = menuHeight(tui.terminal.rows);
        const inner = Math.max(1, width - 4);
        const q = questions[page];
        let body: string[] = [],
          focus = 0;
        const add = (text: string) =>
          body.push(...wrapTextWithAnsi(clean(text), inner));
        const tabs =
          questions
            .map(
              (item, i) =>
                `${i === page ? "›" : ""}${i + 1}${answered(item, drafts[i]) ? "✓" : ""}`,
            )
            .join("  ") + (q ? "  Review" : "  ›Review");
        if (editing) {
          add(q.question);
          add("Your answer");
          body.push(...editor.render(inner));
        } else if (!q) {
          for (const [i, item] of questions.entries()) {
            add(`${i + 1}. ${item.question}`);
            add(`  ${summary(item, drafts[i])}`);
            add("");
          }
          focus = body.length;
          add(
            questions.every((item, i) => answered(item, drafts[i]))
              ? "Enter: Submit answers"
              : "Answer every question before submitting. ← returns to questions.",
          );
        } else {
          add(q.question);
          add("");
          const options = q.options ?? [];
          options.forEach((option, i) => {
            if (i === cursor) focus = body.length;
            const marked = drafts[page].selected.includes(option.id);
            const mark = q.multi
              ? marked
                ? "[x]"
                : "[ ]"
              : marked
                ? "(●)"
                : "( )";
            const text = `${i === cursor ? "›" : " "} ${mark} ${option.label}${q.recommended === option.id ? " · Recommended" : ""}`;
            body.push(
              ...wrapTextWithAnsi(
                theme.fg(i === cursor ? "accent" : "text", clean(text)),
                inner,
              ),
            );
            if (option.description) add(`    ${option.description}`);
          });
          if (cursor === options.length) focus = body.length;
          add(
            `${cursor === options.length ? "›" : " "} ${options.length ? "Other / add your own answer" : "Write your answer"}`,
          );
          if (drafts[page].text) add(`    ${drafts[page].text}`);
        }
        const available = Math.max(1, height - 6);
        if (!manualScroll && !editing) {
          if (focus < offset) offset = focus;
          if (focus >= offset + available) offset = focus - available + 1;
        }
        offset = Math.max(
          0,
          Math.min(offset, Math.max(0, body.length - available)),
        );
        const hint = editing
          ? "Enter saves · Shift-Enter newline · Esc back"
          : "↑↓ choose · Space toggle · Enter next/submit · ←→ questions · PgUp/Dn scroll · Esc cancel";
        return menuFrame(
          theme,
          width,
          height,
          "Ask",
          tabs,
          body.slice(offset),
          hint,
        );
      },
      handleInput(data: string) {
        if (closed) return;
        if (editing) {
          if (matchesKey(data, "escape")) editing = false;
          else editor.handleInput(data);
        } else if (matchesKey(data, "escape")) finish("cancelled");
        else if (matchesKey(data, "left") || matchesKey(data, "shift+tab"))
          move(page - 1);
        else if (matchesKey(data, "right") || matchesKey(data, "tab"))
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
  }, menuOptions);
}
