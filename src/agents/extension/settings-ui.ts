import {
  getSettingsListTheme,
  getSelectListTheme,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Input,
  SettingsList,
  SelectList,
  fuzzyFilter,
  matchesKey,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Supervisor } from "./supervisor";
import { editSettings, rawSettings } from "./settings";
import { menuHeight } from "../../ui/menu";

const thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function settingsUI(
  ctx: ExtensionContext,
  supervisor: Supervisor,
  tui: TUI,
  theme: Theme,
  close: () => void,
) {
  const trail: string[] = [];
  let error = "",
    saving = false,
    disposed = false;
  type Field = {
    id: string;
    label: string;
    value: () => string;
    description: string;
    open: (done: () => void) => Component;
  };
  const changed = () => tui.requestRender();
  const save = async (edit: (raw: any) => void, done: () => void) => {
    if (saving || disposed) return;
    saving = true;
    error = "";
    try {
      supervisor.config = await editSettings(edit);
      if (!disposed) done();
    } catch (cause) {
      error = String(cause);
    } finally {
      saving = false;
      changed();
    }
  };
  const roleEdit = (
    name: string,
    key: string,
    value: unknown,
    done: () => void,
  ) =>
    save((raw) => {
      raw.roles ??= {};
      raw.roles[name] = { ...raw.roles[name], [key]: value };
    }, done);
  const picker = (
    options: string[],
    current: string,
    apply: (value: string, done: () => void) => void,
    done: () => void,
  ): Component => {
    const input = new Input();
    input.focused = true;
    let list: SelectList;
    const rebuild = () => {
      const items = fuzzyFilter(
        options.map((value) => ({ value, label: value })),
        input.getValue(),
        (item) => item.value,
      );
      list = new SelectList(
        items,
        Math.max(1, menuHeight(tui.terminal.rows) - 10),
        getSelectListTheme(),
      );
      const selected = items.findIndex((item) => item.value === current);
      if (selected >= 0) list.setSelectedIndex(selected);
      list.onSelect = (item) => apply(item.value, done);
      list.onCancel = done;
    };
    rebuild();
    return {
      render: (width) => [
        "Search",
        ...input.render(width),
        "",
        ...list.render(width),
      ],
      invalidate() {
        input.invalidate();
        list.invalidate();
      },
      handleInput(data) {
        if (saving) return;
        if (
          ["up", "down", "enter", "escape"].some((key) =>
            matchesKey(data, key as "up"),
          )
        )
          list.handleInput(data);
        else {
          input.handleInput(data);
          rebuild();
        }
        changed();
      },
    };
  };
  const number = (
    current: number,
    apply: (value: number, done: () => void) => void,
    done: () => void,
  ): Component => {
    const input = new Input();
    input.setValue(String(current));
    input.focused = true;
    return {
      render: (width) => [
        "Enter a non-negative integer",
        "",
        ...input.render(width),
      ],
      invalidate() {
        input.invalidate();
      },
      handleInput(data) {
        if (saving) return;
        if (matchesKey(data, "escape")) done();
        else if (matchesKey(data, "enter")) {
          const value = input.getValue().trim();
          if (/^\d+$/.test(value)) apply(Number(value), done);
          else error = "Enter a non-negative integer";
        } else input.handleInput(data);
        changed();
      },
    };
  };
  const page = (
    title: string,
    fields: Field[],
    done: () => void,
  ): Component => {
    if (!trail.length) trail.push(title);
    const search = new Input();
    search.focused = true;
    let list: SettingsList,
      child: Component | undefined,
      visible = 0,
      selected = fields[0]?.id;
    const rebuild = (force = false) => {
      const next = Math.max(1, menuHeight(tui.terminal.rows) - 13);
      if (!force && visible === next) return;
      visible = next;
      const filtered = fuzzyFilter(
        fields,
        search.getValue(),
        (field) => `${field.label} ${field.description}`,
      );
      const colors = getSettingsListTheme();
      list = new SettingsList(
        filtered.map((field) => ({
          id: field.id,
          label: field.label,
          currentValue: field.value(),
          description: field.description,
          submenu: (_value, back) => {
            selected = field.id;
            trail.push(field.label);
            error = "";
            child = field.open(() => {
              child = undefined;
              trail.pop();
              error = "";
              back();
              changed();
            });
            return child;
          },
        })),
        visible,
        {
          ...colors,
          label: (text, active) => {
            if (active)
              selected =
                filtered.find((field) => field.label === text)?.id ?? selected;
            return colors.label(text, active);
          },
        },
        () => {},
        () => {
          done();
          changed();
        },
      );
      if (selected) list.selectItem(selected);
    };
    rebuild();
    return {
      render(width) {
        if (child) return child.render(width);
        rebuild();
        for (const field of fields) list.updateValue(field.id, field.value());
        return [...search.render(width), "", ...list.render(width)];
      },
      handleInput(data) {
        if (child) {
          child.handleInput?.(data);
          return;
        }
        rebuild();
        if (matchesKey(data, "escape") && search.getValue()) {
          search.setValue("");
          rebuild(true);
        } else if (
          matchesKey(data, "up") ||
          matchesKey(data, "down") ||
          matchesKey(data, "enter") ||
          matchesKey(data, "escape") ||
          (matchesKey(data, "space") && !search.getValue())
        )
          list.handleInput(data);
        else {
          search.handleInput(data);
          rebuild(true);
        }
        changed();
      },
      invalidate() {
        search.invalidate();
        list.invalidate();
        child?.invalidate();
      },
    };
  };
  const available = () =>
    ctx.modelRegistry
      .getAvailable()
      .map((model) => `${model.provider}/${model.id}`)
      .sort();
  const modelPicker = (
    current: string,
    apply: (value: string, done: () => void) => void,
    done: () => void,
  ) => {
    const options = available();
    if (!options.length)
      return {
        render: () => [
          "No authenticated models. Use Pi /login first.",
          "Esc returns without changing configuration.",
        ],
        invalidate() {},
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) done();
        },
      };
    return picker(options, current, apply, done);
  };
  const roleFields = (name: string): Field[] => {
    const role = () => supervisor.config.roles[name];
    return [
      {
        id: "model",
        label: "Model",
        value: () => role().model ?? "Not configured",
        description:
          "Choose the authenticated model this agent type uses. Saved as an exact provider/model identity.",
        open: (done) =>
          modelPicker(
            role().model ?? "",
            (value, back) => {
              void roleEdit(name, "model", value, back);
            },
            done,
          ),
      },
      {
        id: "thinking",
        label: "Thinking",
        value: () => role().thinking,
        description:
          "Default thinking for future assignments; Pi clamps unsupported levels.",
        open: (done) =>
          picker(
            thinking,
            role().thinking,
            (value, back) => {
              void roleEdit(name, "thinking", value, back);
            },
            done,
          ),
      },
      {
        id: "limits",
        label: "Limits",
        value: () => "Configure…",
        description: "Runaway-work guards, not a spending cap.",
        open: (done) =>
          page(
            "Limits",
            [
              {
                id: "requestBudget",
                label: "Request guard",
                value: () =>
                  role().requestBudget
                    ? `${role().requestBudget} requests`
                    : "Disabled",
                description:
                  "OMP-style per-assignment assistant request guard. 0 disables it; wrap-up at the guard, forced reporting at 1.5×.",
                open: (back) =>
                  number(
                    role().requestBudget,
                    (value, finish) => {
                      void roleEdit(name, "requestBudget", value, finish);
                    },
                    back,
                  ),
              },
              {
                id: "maxRuntimeMs",
                label: "Wall-clock limit",
                value: () =>
                  role().maxRuntimeMs
                    ? `${role().maxRuntimeMs} ms`
                    : "Unlimited",
                description:
                  "Maximum assignment runtime in milliseconds. 0 means unlimited.",
                open: (back) =>
                  number(
                    role().maxRuntimeMs,
                    (value, finish) => {
                      void roleEdit(name, "maxRuntimeMs", value, finish);
                    },
                    back,
                  ),
              },
              {
                id: "maxConcurrency",
                label: "Child concurrency",
                value: () =>
                  role().maxConcurrency
                    ? String(role().maxConcurrency)
                    : "Unlimited",
                description:
                  "Concurrency when this agent delegates. 0 means unlimited.",
                open: (back) =>
                  number(
                    role().maxConcurrency,
                    (value, finish) => {
                      void roleEdit(name, "maxConcurrency", value, finish);
                    },
                    back,
                  ),
              },
            ],
            done,
          ),
      },
      {
        id: "configuration",
        label: "Role configuration",
        value: () => "Edit JSON…",
        description:
          "Tools, skills, supporting extensions, prompt/promptFile and workspace policy. These are permissions/defaults, not an OS sandbox.",
        open: (done) => {
          const editor = new Editor(tui, {
            borderColor: (text) => theme.fg("border", text),
            selectList: getSelectListTheme(),
          });
          editor.focused = true;
          let loaded = false;
          void rawSettings()
            .then((raw) => {
              if (!disposed) {
                editor.setText(
                  JSON.stringify(raw.roles?.[name] ?? {}, null, 2),
                );
                loaded = true;
                changed();
              }
            })
            .catch((cause) => {
              error = String(cause);
              changed();
            });
          editor.onSubmit = (text) => {
            if (!loaded) return;
            try {
              const value = JSON.parse(text);
              if (!value || typeof value !== "object" || Array.isArray(value))
                throw new Error("Role configuration must be an object");
              void save((raw) => {
                raw.roles ??= {};
                raw.roles[name] = value;
              }, done);
            } catch (cause) {
              error = String(cause);
              changed();
            }
          };
          return {
            render: (width) => [
              "Enter saves · Shift-Enter newline · Esc discards",
              ...editor.render(width),
            ],
            invalidate() {
              editor.invalidate();
            },
            handleInput(data) {
              if (saving) return;
              if (matchesKey(data, "escape")) done();
              else editor.handleInput(data);
              changed();
            },
          };
        },
      },
    ];
  };
  const fields: Field[] = [];
  for (const name of Object.keys(supervisor.config.roles))
    fields.push({
      id: `role:${name}`,
      label: `${name[0].toUpperCase()}${name.slice(1)} agent`,
      value: () =>
        `${supervisor.config.roles[name].model ?? "Not configured"} · ${supervisor.config.roles[name].thinking}`,
      description: supervisor.config.roles[name].description,
      open: (done) => page(name, roleFields(name), done),
    });
  fields.push({
    id: "defaults",
    label: "Supervisor limits",
    value: () => "Configure…",
    description: "Session concurrency, nesting and idle parking.",
    open: (done) =>
      page(
        "Supervisor limits",
        (["maxConcurrency", "maxDepth", "idleTtlMs"] as const).map((key) => ({
          id: key,
          label: key,
          value: () => String(supervisor.config[key]),
          description:
            key === "maxDepth"
              ? "0 prevents delegation."
              : key === "idleTtlMs"
                ? "Milliseconds before parking an idle reusable worker. 0 disables parking."
                : "Concurrent agents per session. 0 means unlimited.",
          open: (back) =>
            number(
              supervisor.config[key],
              (value, finish) => {
                void save((raw) => {
                  raw[key] = value;
                }, finish);
              },
              back,
            ),
        })),
        done,
      ),
  });
  const root = page("Settings", fields, close);
  return {
    get depth() {
      return trail.length - 1;
    },
    get title() {
      return trail.join(" › ");
    },
    get hint() {
      return saving
        ? "Saving…"
        : error ||
            (trail.length > 1
              ? "↑↓ select · Enter edit/save · Esc back"
              : "Tab tabs · type to search · Enter edit · Esc close");
    },
    render(width: number) {
      return root.render(width);
    },
    handleInput(data: string) {
      if (!saving) root.handleInput?.(data);
      changed();
    },
    invalidate() {
      root.invalidate();
    },
    dispose() {
      disposed = true;
    },
  };
}
