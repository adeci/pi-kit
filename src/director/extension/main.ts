import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { choose } from "../../ui/menu";
import {
  activePrompt,
  allowedTools,
  blockTool,
  defaults,
  entryType,
  validState,
  type DirectorState,
} from "./state";

export default function install(pi: ExtensionAPI) {
  let claimed = false;
  pi.events.emit("pi-kit:claim:director", () => {
    claimed = true;
  });
  if (claimed) return;
  const unclaim = pi.events.on("pi-kit:claim:director", (reply: unknown) => {
    if (typeof reply === "function") reply();
  });
  let state: DirectorState = { ...defaults };
  let ctx: ExtensionContext | undefined, priorTools: string[] | undefined;
  let menuOpen = false;
  let epoch = 0;
  const workers = () => {
    let snapshot = { ready: false, active: 0, roles: [] as string[] };
    pi.events.emit("pi-kit:agents:query", (value: typeof snapshot) => {
      snapshot = value;
    });
    return snapshot;
  };
  const display = () => {
    if (!ctx) return;
    const snapshot = workers();
    ctx.ui.setStatus(
      "pi-kit-director",
      state.enabled
        ? `Director ON · ${snapshot.ready ? `${snapshot.active} active workers` : "agents unavailable"}`
        : undefined,
    );
  };
  const restrict = () => {
    if (!priorTools) priorTools = pi.getActiveTools();
    pi.setActiveTools(priorTools.filter((name) => allowedTools.has(name)));
  };
  const restore = () => {
    if (priorTools) pi.setActiveTools(priorTools);
    priorTools = undefined;
  };
  const save = () => {
    pi.appendEntry(entryType, state);
    display();
  };
  const unobserve = pi.events.on("pi-kit:agents:changed", () => {
    if (state.enabled) display();
  });
  pi.on("session_start", (_event, context) => {
    epoch++;
    menuOpen = false;
    ctx = context;
    priorTools = undefined;
    state = { ...defaults };
    for (const entry of context.sessionManager.getBranch())
      if (
        entry.type === "custom" &&
        entry.customType === entryType &&
        validState(entry.data)
      )
        state = { ...entry.data };
    if (state.enabled) restrict();
    display();
  });
  pi.on("before_agent_start", () => {
    if (state.enabled) restrict();
  });
  // Agent reports can start turns without before_agent_start.
  pi.on("context", (event) => {
    if (!state.enabled) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: "pi-kit:director:current",
          content: activePrompt(state),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
  // Enforce the policy for nested/deferred tools too, not just declarations.
  pi.on("tool_call", (event) => {
    if (!state.enabled) return;
    const reason = blockTool(event.toolName, event.input);
    if (reason) return { block: true, reason };
  });
  pi.registerCommand("director", {
    description:
      "Director settings: delegation-only mode and fast/strong worker roles",
    handler: async (_args, context) => {
      if (context.mode !== "tui") {
        context.ui.notify(
          "Director settings require the terminal UI.",
          "warning",
        );
        return;
      }
      if (menuOpen) return;
      const generation = epoch;
      ctx = context;
      menuOpen = true;
      let selected = "enabled";
      try {
        for (;;) {
          const snapshot = workers();
          const field = await choose(
            context,
            "Director",
            [
              {
                value: "enabled",
                label: `Director: ${state.enabled ? "On" : "Off"}`,
                description:
                  "Parent reads and directs; existing agents execute. Reviewed integration is allowed.",
              },
              {
                value: "fast",
                label: "Fast worker role",
                description: state.fast,
              },
              {
                value: "strong",
                label: "Strong worker role",
                description: state.strong,
              },
              {
                value: "agents",
                label: "Agent model settings",
                description:
                  "Open /agents → Settings to configure each role's exact model, thinking and limits",
              },
              {
                value: "status",
                label: "Workers",
                description: snapshot.ready
                  ? `${snapshot.active} active · details in /agents`
                  : "Agents component is unavailable",
              },
            ],
            selected,
          );
          if (!field || generation !== epoch) return;
          selected = field;
          if (field === "enabled") {
            if (!context.isIdle() || context.hasPendingMessages()) {
              context.ui.notify(
                "Wait for the current parent turn before changing director mode.",
                "warning",
              );
              continue;
            }
            if (
              !state.enabled &&
              (!snapshot.ready ||
                ![state.fast, state.strong].every((role) =>
                  snapshot.roles.includes(role),
                ))
            ) {
              context.ui.notify(
                "Enable agents and configure both selected roles in /agents first.",
                "error",
              );
              continue;
            }
            state = { ...state, enabled: !state.enabled };
            if (state.enabled) restrict();
            else restore();
            save();
            pi.sendMessage(
              {
                customType: "pi-kit:director:mode",
                content: state.enabled
                  ? activePrompt(state)
                  : "Director mode OFF. Normal tool access is restored; the earlier director restriction no longer applies.",
                display: false,
              },
              { triggerTurn: false },
            );
          } else if (field === "fast" || field === "strong") {
            const role = await choose(
              context,
              `Director ${field} role`,
              snapshot.roles.map((value) => ({ value, label: value })),
              state[field],
            );
            if (generation !== epoch) return;
            if (role) {
              state = { ...state, [field]: role };
              save();
              if (state.enabled)
                pi.sendMessage(
                  {
                    customType: "pi-kit:director:roles",
                    content: activePrompt(state),
                    display: false,
                  },
                  { triggerTurn: false },
                );
            }
          } else if (field === "agents") {
            pi.sendUserMessage("/agents", {
              expandPromptTemplates: true,
              deliverAs: "followUp",
            });
            return;
          }
        }
      } finally {
        if (generation === epoch) menuOpen = false;
      }
    },
  });
  pi.on("session_shutdown", (event) => {
    epoch++;
    restore();
    ctx?.ui.setStatus("pi-kit-director", undefined);
    ctx = undefined;
    if (event.reason === "quit" || event.reason === "reload") {
      unclaim();
      unobserve();
    }
  });
}
