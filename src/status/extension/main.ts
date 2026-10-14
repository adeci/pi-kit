import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { gitCounts, statusLine, type GitCounts } from "./layout";
import { sessionCost } from "./state";
import { statusEditor } from "./editor";

const exec = promisify(execFile);

export default function status(pi: ExtensionAPI) {
  let enabled = true,
    icons = true;
  let ctx: ExtensionContext | undefined;
  let editorInstalled = false;
  let cost = 0;
  let sessionAddress: () => string | undefined = () => undefined;
  let started: number | undefined;
  let redraw: (() => void) | undefined;
  let refreshGit: (() => void) | undefined;
  const refresh = (next: ExtensionContext) => {
    ctx = next;
    cost = sessionCost(next.sessionManager.getBranch());
    redraw?.();
  };
  const install = (next: ExtensionContext) => {
    refresh(next);
    if (next.mode !== "tui") return;
    if (!enabled) {
      next.ui.setFooter(undefined);
      if (editorInstalled) next.ui.setEditorComponent(undefined);
      editorInstalled = false;
      return;
    }
    if (!editorInstalled) {
      next.ui.setEditorComponent(
        statusEditor(() => ({
          theme: next.ui.theme,
          name: sessionAddress(),
          elapsed: started === undefined ? undefined : Date.now() - started,
        })),
      );
      editorInstalled = true;
    }
    next.ui.setFooter((tui, _theme, footer) => {
      sessionAddress = () =>
        footer.getExtensionStatuses().get("pi-events:name");
      const controller = new AbortController();
      let git: GitCounts | undefined,
        pending = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const request = () => {
        if (controller.signal.aborted) return;
        if (started !== undefined && !timer) {
          timer = setInterval(() => tui.requestRender(), 1000 / 30);
          timer.unref();
        } else if (started === undefined && timer) {
          clearInterval(timer);
          timer = undefined;
        }
        tui.requestRender();
      };
      const updateGit = async () => {
        if (pending || controller.signal.aborted) return;
        pending = true;
        try {
          const { stdout } = await exec(
            "git",
            ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
            {
              cwd: next.cwd,
              signal: controller.signal,
              timeout: 2000,
              maxBuffer: 1024 * 1024,
              env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
            },
          );
          git = gitCounts(stdout);
        } catch {
          git = undefined;
        } finally {
          pending = false;
          if (!controller.signal.aborted) request();
        }
      };
      const checkGit = () => {
        void updateGit();
      };
      redraw = request;
      refreshGit = checkGit;
      const unsubscribe = footer.onBranchChange(() => {
        checkGit();
        request();
      });
      request();
      checkGit();
      return {
        dispose() {
          if (controller.signal.aborted) return;
          controller.abort();
          clearInterval(timer);
          unsubscribe();
          sessionAddress = () => undefined;
          if (redraw === request) redraw = undefined;
          if (refreshGit === checkGit) refreshGit = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          if (!ctx || width < 1) return [];
          const home = homedir();
          const path =
            ctx.cwd === home
              ? "~"
              : ctx.cwd.startsWith(home + "/")
                ? "~" + ctx.cwd.slice(home.length)
                : ctx.cwd;
          const usage = ctx.getContextUsage();
          return [
            statusLine(
              ctx.ui.theme,
              width,
              {
                model: ctx.model?.name || ctx.model?.id || "no model",
                thinking: ctx.model?.reasoning ? pi.getThinkingLevel() : "",
                path,
                branch: footer.getGitBranch() ?? undefined,
                git,
                percent: usage?.percent,
                window: usage?.contextWindow ?? ctx.model?.contextWindow,
                elapsed:
                  started === undefined ? undefined : Date.now() - started,
                cost,
                title: pi.getSessionName() || "",
                statuses: [...footer.getExtensionStatuses()]
                  .filter(([key]) => key !== "pi-events:name")
                  .map(([, value]) => value),
              },
              icons,
            ),
          ];
        },
      };
    });
  };
  pi.on("session_start", (_event, context) => {
    started = undefined;
    install(context);
  });
  pi.on("session_tree", (_event, context) => refresh(context));
  pi.on("session_info_changed", (_event, context) => refresh(context));
  pi.on("session_compact", (_event, context) => refresh(context));
  pi.on("message_end", (_event, context) => refresh(context));
  pi.on("model_select", (_event, context) => refresh(context));
  pi.on("thinking_level_select", (_event, context) => refresh(context));
  pi.on("turn_end", (_event, context) => {
    refresh(context);
    refreshGit?.();
  });
  pi.on("agent_start", (_event, context) => {
    started = Date.now();
    refresh(context);
  });
  pi.on("agent_settled", (_event, context) => {
    started = undefined;
    refresh(context);
    refreshGit?.();
  });
  pi.on("session_shutdown", (_event, context) => {
    context.ui.setFooter(undefined);
    if (editorInstalled) context.ui.setEditorComponent(undefined);
    editorInstalled = false;
    redraw = undefined;
    refreshGit = undefined;
    ctx = undefined;
    started = undefined;
  });
  pi.registerCommand("status", {
    description: "Status bar: on, off, icons or ascii (current runtime)",
    handler: async (args, context) => {
      let choice = args.trim();
      if (!choice && context.hasUI)
        choice =
          (await context.ui.select("Status bar", [
            "on",
            "off",
            "icons",
            "ascii",
          ])) ?? "";
      if (!choice) return;
      if (choice === "on" || choice === "off") enabled = choice === "on";
      else if (choice === "icons" || choice === "ascii")
        icons = choice === "icons";
      else {
        context.ui.notify("Use /status on|off|icons|ascii", "warning");
        return;
      }
      install(context);
    },
  });
}
