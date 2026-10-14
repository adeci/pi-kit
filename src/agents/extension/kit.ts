import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Supervisor } from "./supervisor";
import { singleLine } from "../../ui/style";
interface Jobs {
  inspect(): Promise<{
    jobs: unknown[];
    watched: string[];
    health: { callback_verified: boolean; error?: string };
  }>;
}
interface Events {
  attached: boolean;
  controls: string[];
}
/** Diagnostic report only. Recovery belongs to the component that owns the work. */
export function installKit(
  pi: ExtensionAPI,
  get: () => Supervisor | undefined,
) {
  pi.registerCommand("kit", {
    description: "pi-kit health report (read-only)",
    handler: async (_args, ctx) => {
      let jobs: Jobs | undefined, events: Events | undefined;
      pi.events.emit("pi-kit:inspect:jobs", (value: Jobs) => {
        jobs = value;
      });
      pi.events.emit("pi-kit:inspect:events", (value: Events) => {
        events = value;
      });
      const supervisor = get();
      const rows = [
        "pi-kit health",
        `Agents: ${supervisor ? "attached" : "unavailable — check extension errors"}`,
        `Events: ${events ? (events.attached ? "live attachment" : "detached — check startup errors") : "not loaded"}`,
        `Jobs: ${jobs ? "loaded" : "not loaded"}`,
      ];
      if (supervisor) {
        const available = new Set(
          ctx.modelRegistry
            .getAvailable()
            .map((model) => `${model.provider}/${model.id}`),
        );
        const missing = Object.entries(supervisor.config.roles)
          .filter(([, role]) => !role.model || !available.has(role.model))
          .map(([name]) => name);
        rows.push(
          missing.length
            ? `Unavailable role models: ${missing.join(", ")} — /agents Settings or /login`
            : "Role models: available",
        );
      }
      if (pi.getSettings().skills?.includes("!**"))
        rows.push(
          "Skills: discovery excludes all; explicit --skill paths may still load",
        );
      if (jobs) {
        try {
          const snapshot = await jobs.inspect();
          rows.push(
            `Daemon: responding · ${snapshot.jobs.length} owned jobs · ${snapshot.watched.length} watches`,
            `Callback: ${snapshot.health.callback_verified ? "verified for current socket" : "unverified — run pi-jobs doctor explicitly"}`,
          );
          if (snapshot.health.error)
            rows.push(singleLine(snapshot.health.error));
        } catch (error) {
          rows.push(`Jobs query failed: ${singleLine(String(error))}`);
        }
      }
      if (events && jobs && !events.controls.includes("job.changed"))
        rows.push("Job completion handler missing — check extension errors");
      rows.push(
        "Recovery: /agents → select agent → r; /jobs → select job → Watch.",
        "This report submits no work and changes no watches.",
      );
      ctx.ui.notify(rows.join("\n"), "info");
    },
  });
}
