import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Supervisor } from "./supervisor";
import { registerTools } from "./tools";
import { installUI } from "./ui";
import { installKit } from "./kit";
import { completionDelivery } from "../../shared/completions";
import { completionRenderer } from "../../shared/completion-renderer";
import { agentResultDescription } from "./notifications";

export default function agents(pi: ExtensionAPI) {
  // Workers inherit the parent's extensions, including this one. Their agent
  // tools come from child.ts and route to the owning supervisor instead.
  if (process.argv.includes("--pi-agents-child")) return;
  let claimed = false;
  pi.events.emit("pi-kit:claim:agents", () => {
    claimed = true;
  });
  if (claimed) return;
  const unclaim = pi.events.on("pi-kit:claim:agents", (callback: unknown) => {
    if (typeof callback === "function") callback();
  });
  pi.on("session_shutdown", () => {
    unclaim();
  });
  const delivery = completionDelivery(pi);
  completionRenderer(pi, "pi-agents-result", agentResultDescription);
  let notification = 0;
  let supervisor: Supervisor | undefined;
  let generation = 0;
  let failure: string | undefined;
  // Read-only in-process observation for optional goal/director extensions.
  // Assignment and control still go through the existing agent tools.
  const unquery = pi.events.on("pi-kit:agents:query", (reply: unknown) => {
    if (typeof reply !== "function") return;
    reply({
      ready: Boolean(supervisor),
      active:
        supervisor
          ?.list()
          .filter((agent) =>
            ["queued", "starting", "running", "settling"].includes(agent.state),
          ).length ?? 0,
      roles: Object.keys(supervisor?.config.roles ?? {}),
    });
  });
  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit" || event.reason === "reload") unquery();
  });
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const publishers = new Set<ReturnType<typeof spawn>>();
  const publish = (topic: string, payload: unknown) => {
    if (
      !supervisor ||
      !process.env.PI_EVENTS_SUBSCRIPTION ||
      publishers.size >= 8
    )
      return;
    const publisher = spawn(
      process.env.PI_EVENTS_BIN || "pi-events",
      [
        "publish",
        "--topic",
        topic,
        "--source",
        "pi-agents",
        "--to",
        supervisor.ctx.sessionManager.getSessionId(),
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    publishers.add(publisher);
    publisher.on("error", () => {});
    publisher.stdin!.on("error", () => {});
    publisher.stdin!.end(JSON.stringify(payload));
    const timer = setTimeout(() => publisher.kill(), 5000);
    publisher.once("close", () => {
      clearTimeout(timer);
      publishers.delete(publisher);
    });
  };
  const ui = installUI(pi, () => supervisor);
  installKit(pi, () => supervisor);
  registerTools(
    pi,
    async (operation, args, signal) => {
      if (!supervisor)
        throw new Error(
          failure ?? "Agents are not attached to an active Pi session",
        );
      return supervisor.dispatch("main", operation, args, signal);
    },
    () => supervisor?.list() ?? [],
  );
  const close = async () => {
    generation++;
    const previous = supervisor;
    supervisor = undefined;
    pi.events.emit("pi-kit:agents:changed", undefined);
    ui.close();
    clearTimeout(progressTimer);
    progressTimer = undefined;
    for (const publisher of publishers) publisher.kill();
    await previous?.close();
  };
  pi.on("session_shutdown", close);
  pi.on("session_start", async (_event, ctx) => {
    await close();
    const current = generation;
    let started: Supervisor | undefined;
    try {
      started = new Supervisor(ctx, {
        changed: () => {
          ui.changed();
          pi.events.emit("pi-kit:agents:changed", undefined);
          if (
            generation !== current ||
            progressTimer ||
            !process.env.PI_EVENTS_SUBSCRIPTION
          )
            return;
          progressTimer = setTimeout(() => {
            progressTimer = undefined;
            if (generation !== current || !supervisor) return;
            const all = supervisor.list();
            publish("agents.progress", {
              total: all.length,
              agents: all
                .filter((agent) =>
                  ["queued", "starting", "running", "settling"].includes(
                    agent.state,
                  ),
                )
                .slice(0, 16)
                .map((agent) => ({
                  id: agent.id,
                  parent: agent.parent,
                  state: agent.state,
                  model: agent.model,
                  requests: agent.requests,
                  cost: agent.cost,
                  activity: agent.activity.slice(0, 128),
                })),
            });
          }, 1000);
        },
        notify: (_parent, result) => {
          if (generation !== current || !supervisor) return;
          const { assignment, kind } = (result ?? {}) as {
            assignment?: unknown;
            kind?: unknown;
          };
          // Results are keyed by assignment so agent_status/agent_wait can
          // withdraw them; messages from agents are never consumed that way.
          delivery.add(
            kind !== "agent-message" && typeof assignment === "string"
              ? `agent:${assignment}`
              : `agent-message:${++notification}`,
            {
              message: {
                customType: "pi-agents-result",
                content: `[Agent message/result — inspect authoritative artifacts before accepting work]\n${JSON.stringify(result, null, 2).slice(0, 12288)}`,
                display: true,
                details: result,
              },
              wake: true,
            },
          );
        },
        consumed: (assignment) => {
          if (generation === current) delivery.consume(`agent:${assignment}`);
        },
        observe: (topic, payload) => {
          // Optional observer publication, never the assignment/control channel.
          // These topics are not pi-events' automatic agent.result follow-up topics.
          if (generation !== current) return;
          publish(topic, {
            ...(payload as object),
            report: undefined,
            partial: undefined,
          });
        },
      });
      await started.start();
      if (generation !== current) {
        await started.close();
        return;
      }
      supervisor = started;
      pi.events.emit("pi-kit:agents:changed", undefined);
      failure = undefined;
      ui.attach(ctx);
    } catch (error) {
      failure = `Agent initialization failed: ${String(error)}`;
      if (started) await started.close().catch(() => {});
      if (ctx.hasUI) ctx.ui.notify(failure, "error");
      else process.stderr.write(failure + "\n");
    }
  });
}
