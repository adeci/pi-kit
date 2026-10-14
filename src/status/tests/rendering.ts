// Run against the stock Pi SDK, not the unit suite's lightweight TUI mocks.
import assert from "node:assert/strict";
import usage, { credentials } from "../../usage/extension/main";
import status from "../extension/main";
import { namedBorder, gradientBorder, statusEditor } from "../extension/editor";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { cardLines, usageFrame } from "../../usage/extension/view";
import { parse } from "../../usage/extension/state";
import { gitCounts, statusLine } from "../extension/layout";
import { visibleWidth, parseColor, styleText } from "@earendil-works/pi-tui";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const theme: any = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  style: (text: string) => text,
  colors: {
    syntaxKeyword: parseColor("#9d7cd8"),
    syntaxType: parseColor("#2ac3de"),
    accent: parseColor("#7aa2f7"),
    text: parseColor("#c0caf5"),
  },
};
let command: any, component: any, finish: any;
let renders = 0,
  requests = 0;
const hooks = new Map();
const fetch = globalThis.fetch;
globalThis.fetch = (async () => {
  requests++;
  return Response.json({
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 604800,
        reset_after_seconds: 60,
      },
    },
    credits: { balance: "61283.9178000000" },
  });
}) as typeof fetch;
usage({
  on: (name: string, handler: any) => hooks.set(name, handler),
  registerCommand: (_name: string, spec: any) => (command = spec.handler),
} as any);
const ctx: any = {
  mode: "tui",
  modelRegistry: {
    getAll: () => [
      { provider: "openai-codex", baseUrl: "https://chatgpt.com" },
    ],
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => true,
    getProviderAuth: async () => ({ auth: { apiKey: "fixture" } }),
  },
  ui: {
    theme,
    custom: (factory: any) =>
      new Promise<void>((resolve) => {
        finish = () => {
          component.dispose();
          resolve();
        };
        component = factory(
          { terminal: { rows: 42 }, requestRender: () => renders++ },
          theme,
          {},
          finish,
        );
      }),
  },
};
try {
  ctx.modelRegistry.isUsingOAuth = () => false;
  const apiKey = await credentials(ctx, "openai-codex");
  assert(
    "notice" in apiKey && apiKey.hidden,
    "API-key billing must not appear as a subscription",
  );
  ctx.modelRegistry.isUsingOAuth = () => true;
  const running = command("", ctx);
  await pause(50);
  const before = renders;
  await pause(1100);
  assert(
    renders > before,
    "usage must repaint while idle without keyboard input",
  );
  assert.equal(requests, 1, "repainting must not query a provider");
  const shown = component.render(100).join("\n");
  assert(shown.includes("90% remaining") && shown.includes("10% used"));
  assert(shown.includes("Credit balance · 61,283.92"));
  assert(!shown.includes("Anthropic"), "logged-out provider must not appear");
  assert(shown.includes("checked 1s ago"));
  component.handleInput("r");
  await pause(30);
  const cached = component.render(100).join("\n");
  assert(
    cached.includes("Using cached results") &&
      cached.includes("checked 1s ago"),
  );
  assert.equal(
    requests,
    1,
    "manual refresh retains the cache and the real data age",
  );
  finish();
  await running;
  const closed = renders;
  await pause(1100);
  assert.equal(renders, closed, "closing must stop the timer");
  const again = command("", ctx);
  await pause(50);
  hooks.get("session_shutdown")();
  const stopped = renders;
  await pause(1100);
  assert.equal(renders, stopped, "shutdown must stop the timer");
  finish();
  await again;
  console.log(
    "PASS live repaint, no polling, filtering, credits, disposal and shutdown",
  );
} finally {
  component?.dispose();
  globalThis.fetch = fetch;
}

const statusHooks = new Map();
let footer: any,
  statusCommand: any,
  footerRenders = 0;
let nativeWorking = true;
const footerContext: any = {
  mode: "tui",
  cwd: process.cwd(),
  model: { name: "GPT-6 Astra", reasoning: true, contextWindow: 272000 },
  sessionManager: { getBranch: () => [] },
  getContextUsage: () => ({ percent: 2.7, contextWindow: 272000 }),
  ui: {
    theme,
    setEditorComponent: (_factory: unknown) => {},
    setWorkingVisible: (visible: boolean) => {
      nativeWorking = visible;
    },
    setFooter: (factory: any) => {
      footer?.dispose();
      footer = factory?.({ requestRender: () => footerRenders++ }, theme, {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => {},
      });
    },
  },
};
status({
  on: (event: string, fn: any) => statusHooks.set(event, fn),
  registerCommand: (_name: string, spec: any) => (statusCommand = spec.handler),
  getThinkingLevel: () => "high",
  getSessionName: () => "",
} as any);
try {
  statusHooks.get("session_start")({}, footerContext);
  assert.equal(nativeWorking, true, "native working indicator remains visible");
  statusHooks.get("agent_start")({}, footerContext);
  const before = footerRenders;
  await pause(1100);
  assert(footerRenders > before && footer.render(120)[0].startsWith(" λ"));
  statusHooks.get("agent_settled")({}, footerContext);
  await pause(50);
  const idle = footerRenders;
  await pause(150);
  assert.equal(
    footerRenders,
    idle,
    "idle footer must not run an animation timer",
  );
  assert(footer.render(120)[0].startsWith(" λ"));
  await statusCommand("off", footerContext);
  assert.equal(
    nativeWorking,
    true,
    "disabling leaves the stock indicator alone",
  );
  const off = footerRenders;
  await pause(250);
  assert.equal(footerRenders, off, "disabled footer must stop repainting");
  await statusCommand("on", footerContext);
  statusHooks.get("session_shutdown")({}, footerContext);
  assert.equal(
    nativeWorking,
    true,
    "unloading leaves the stock indicator alone",
  );
  const ended = footerRenders;
  await pause(250);
  assert.equal(footerRenders, ended, "shutdown must fence footer callbacks");
} finally {
  footer?.dispose();
}
console.log("PASS footer clock and off/shutdown disposal");

const info = {
  model: "GPT-6 Astra",
  thinking: "high",
  path: "/home/alex/git/界-wide-project",
  branch: "main",
  git: { staged: 7, unstaged: 2, untracked: 1 },
  percent: 2.7,
  window: 272000,
  elapsed: 2000,
  cost: 0,
  title: "Session",
  statuses: [],
};
const colored = {
  ...theme,
  style: (text: string, options: any) => styleText(text, options, "truecolor"),
};
const frame = (elapsed: number) =>
  statusLine(colored, 160, { ...info, elapsed });
for (const elapsed of [undefined, 0, 400, 1200, 2400, 60000]) {
  let lambdaColor: string | undefined;
  const line = statusLine(
    {
      ...colored,
      fg: (color: string, text: string) => {
        if (text === "λ") lambdaColor = color;
        return text;
      },
    },
    160,
    { ...info, elapsed },
  );
  assert.equal(
    lambdaColor,
    elapsed === undefined ? "muted" : "accent",
    "lambda color depends only on idle/busy, not animation phase",
  );
  assert(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(line), "no footer spinner");
  assert.equal(
    stripVTControlCharacters(line).split(" · ")[0],
    " λ",
    "no footer elapsed time",
  );
}
assert.notEqual(
  frame(400).split(" · ")[1],
  frame(600).split(" · ")[1],
  "model shimmer travels",
);
assert.deepEqual(
  frame(400).split(" · ").slice(2),
  frame(600).split(" · ").slice(2),
  "other segments stay steady",
);
assert(
  statusLine(theme, 10, info).includes("λ"),
  "activity survives narrow layouts",
);
for (const width of [40, 60, 75, 100, 180]) {
  for (const icons of [false, true]) {
    const line = statusLine(
      theme,
      width,
      {
        ...info,
        cost: 12.34,
        statuses: ["a long unrelated extension status"],
      },
      icons,
    );
    assert.equal(visibleWidth(line), width);
    assert(
      stripVTControlCharacters(line).includes("$12.34"),
      "price survives before secondary segments",
    );
  }
}
const wide = statusLine(theme, 110, info);
assert(
  wide.includes("◒ GPT-6 Astra") &&
    wide.includes("⑂ main") &&
    wide.includes("+7"),
);
assert(wide.includes("2.7%/272K"));
assert(
  !wide.includes("cache") && !wide.includes("tok/s") && !wide.includes("\n"),
);
for (let width = 1; width <= 200; width++) {
  for (const icons of [true, false]) {
    const line = statusLine(theme, width, info, icons);
    assert.equal(visibleWidth(line), width, `footer width ${width}`);
    assert(
      line.startsWith(" ") && line.endsWith(" "),
      "one-column edge padding",
    );
    assert(!line.includes("\n"));
  }
}
const hostile = statusLine(theme, 150, {
  ...info,
  model: "Model\x1b[2J\nOops",
  branch: "branch\rINJECT",
  statuses: ["Status\nINJECT"],
});
assert(!/[\n\r\x07]/.test(hostile) && !hostile.includes("\x1b[2J"));
assert.deepEqual(
  gitCounts("M  staged\0 M unstaged\0?? untracked\0R  renamed\0old-name\0"),
  { staged: 2, unstaged: 1, untracked: 1 },
);

const report = parse(
  "openai-codex",
  {
    rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 604800,
        reset_after_seconds: 600,
      },
    },
  },
  0,
)!;
const card = { provider: "openai-codex" as const, report };
const quota = cardLines(card, theme, 120, 1000).join("\n");
assert(quota.includes("90% remaining") && quota.includes("10% used"));
assert(
  (quota.match(/[█░]/g) ?? []).length > 50,
  "meter must use available width",
);
for (const width of [12, 20, 40, 65, 100, 180]) {
  for (const rows of [8, 12, 24, 42]) {
    const frame = usageFrame(
      theme,
      width,
      rows,
      [card, { ...card, provider: "anthropic" }],
      false,
      999,
      1000,
    );
    assert(frame.lines.length <= rows);
    assert(frame.lines.every((line) => visibleWidth(line) <= width));
  }
}
assert.equal(cardLines({ ...card, hidden: true }, theme, 120).length, 0);
const unknown = cardLines(
  { ...card, report: { ...report, meters: [{ label: "5h" }] } },
  theme,
  90,
).join("\n");
assert(unknown.includes("usage not reported") && !unknown.includes("0%"));
console.log(
  "PASS OMP segments, Unicode widths 1–200, git counts, wide meters and unknown values",
);

const gradientTheme = { ...colored, getFgAnsi: () => "\x1b[34m" };
const border = "─".repeat(81);
const gradient = (elapsed: number) =>
  gradientBorder(border, 81, { theme: gradientTheme, elapsed });
const cells = (text: string) =>
  [...text.matchAll(/\x1b\[38;2;([0-9;]+)m─/g)].map((m) => m[1]);
const thin = stripVTControlCharacters;
assert.equal(gradientBorder(border, 81, { theme: gradientTheme }), border);
for (const elapsed of [0, 50, 150, 300, 900, 2400, 10000])
  assert.equal(
    thin(gradient(elapsed)),
    border,
    "only color changes; all glyphs remain identical",
  );
assert(
  new Set(cells(gradient(900))).size >= 3,
  "gradient has spatial color variation",
);
assert(
  new Set(cells(gradient(0))).size === 1,
  "activation starts in the idle color",
);
assert.equal(
  gradient(900),
  gradient(6900),
  "one gentle six-second cycle, without accumulated phases",
);
assert.notEqual(gradient(900), gradient(2400), "gradient drifts over time");
for (const width of [12, 40, 81, 120]) {
  const named = namedBorder("─".repeat(width), width, "wren");
  assert.equal(visibleWidth(named.line), width);
  assert(named.line.endsWith(" wren ──"));
  const first = gradientBorder(
    named.line,
    width,
    { theme: gradientTheme, elapsed: 400 },
    named.label,
  );
  const second = gradientBorder(
    named.line,
    width,
    { theme: gradientTheme, elapsed: 900 },
    named.label,
  );
  assert.equal(thin(first), named.line);
  assert.equal(thin(second), named.line);
  assert.notEqual(
    first.slice(first.indexOf("w")),
    second.slice(second.indexOf("w")),
    "gradient crosses the stationary name",
  );
}
const occupied = "── Retry in 2s ──";
assert.equal(
  namedBorder(occupied, visibleWidth(occupied), "albacore").line,
  occupied,
);
assert.equal(namedBorder("─".repeat(8), 8, "albacore").line, "─".repeat(8));
for (const width of [2, 15, 40, 81, 120, 180]) {
  for (const elapsed of [0, 400, 900, 1800, 2799, 2800]) {
    const line = gradientBorder("─".repeat(width), width, {
      theme: gradientTheme,
      elapsed,
    });
    assert.equal(visibleWidth(line), width);
    const plain = stripVTControlCharacters(line);
    assert.equal(plain, [...plain].reverse().join(""));
  }
}
let editorElapsed: number | undefined;
let editorName: string | undefined;
const editorTui: any = {
  terminal: { rows: 30, columns: 81 },
  requestRender() {},
};
const editorTheme: any = {
  borderColor: (text: string) => text,
  selectList: {},
};
const keys: any = { matches: () => false };
const editor = statusEditor(() => ({
  theme: gradientTheme,
  elapsed: editorElapsed,
  name: editorName,
}))(editorTui, editorTheme, keys);
const native = new CustomEditor(editorTui, editorTheme, keys, {
  embedWorkingStatus: true,
});
editor.setText("hello 界\nsecond line");
native.setText("hello 界\nsecond line");
const idleEditor = editor.render(81);
assert.deepEqual(
  idleEditor,
  native.render(81),
  "stock text/cursor/layout are unchanged",
);
(editor as CustomEditor).borderColor = (text) => "THINKING_COLOR" + text;
assert.deepEqual(
  editor.render(81),
  idleEditor,
  "thinking changes do not recolor idle borders",
);
editorElapsed = 900;
const activeEditor = editor.render(81);
assert.equal(
  activeEditor[0],
  activeEditor.at(-1),
  "top and bottom share the same gradient",
);
assert.deepEqual(
  activeEditor.map(thin),
  idleEditor.map(thin),
  "idle and active frames retain identical glyphs, rows, text and cursor position",
);
editorName = "wren";
const namedEditor = editor.render(81);
assert(thin(namedEditor[0]).endsWith(" wren ──"));
assert(!thin(namedEditor.at(-1)!).includes("wren"));
assert.deepEqual(namedEditor.slice(1, -1), activeEditor.slice(1, -1));
editorName = undefined;
for (const kind of [
  "working",
  "retry",
  "compaction",
  "branchSummary",
] as const) {
  const message = kind === "working" ? "Working..." : `${kind} notice`;
  const indicator: any = {
    kind,
    renderInBorder: (width: number) =>
      `\x1b[33m${`⠋ ${message}`.slice(0, width)}\x1b[0m`,
    renderSpinnerInBorder: () => "\x1b[33m⠋\x1b[0m",
  };
  (editor as CustomEditor).setWorkingStatusIndicator(indicator);
  native.setWorkingStatusIndicator(indicator);
  const rendered = editor.render(81);
  assert.deepEqual(rendered.map(thin), native.render(81).map(thin));
  if (kind === "working") {
    assert(
      !rendered[0].includes(message),
      "normal Working text gets per-character gradient colors",
    );
    assert(
      !rendered[0].includes("\x1b[33m⠋"),
      "the native Working spinner shares the gradient",
    );
  } else {
    assert(
      rendered[0].includes(`\x1b[33m⠋ ${message}\x1b[0m`),
      "native notices retain their styling",
    );
  }
  for (const width of [1, 2, 3, 5, 12, 25, 81]) {
    for (const hidden of [0, 8]) {
      const row = (editor as any).renderTopBorder(width, hidden);
      assert.equal(
        thin(row),
        thin((native as any).renderTopBorder(width, hidden)),
      );
      assert.equal(visibleWidth(row), width);
    }
  }
}
(editor as CustomEditor).setWorkingStatusIndicator(undefined);
native.setWorkingStatusIndicator(undefined);
assert.deepEqual(editor.render(81).map(thin), native.render(81).map(thin));
console.log(
  "PASS thin gradient borders, Working colors, native notices and unchanged layout",
);
