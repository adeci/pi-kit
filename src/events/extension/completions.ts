import { object } from "../../shared/completions";
import type { CompletionCard } from "../../shared/completion-renderer";

const HANDLE = /^\d+:[a-f0-9]{32}$/;
export function terminalJob(payload: unknown) {
  const job = object(payload);
  return job &&
    typeof job.handle === "string" &&
    HANDLE.test(job.handle) &&
    typeof job.state === "string" &&
    (job.exit_code !== null || job.state === "unavailable")
    ? job
    : undefined;
}

// Build and fetch chatter that says nothing about the result.
const NOISE = [
  /^\s*$/,
  /^\s*(Compiling|Checking|Fresh|Downloading|Downloaded|Updating|Locking|Adding|Blocking|Building|Documenting|Packaging|Verifying|Unpacking|Installing|Removing)\s/,
  /^warning: Git tree '.*' (is dirty|has uncommitted changes)/,
  /^(copying path|building '|fetching |evaluating |these \d+ (derivations|paths) will be)/,
  /^\s*(\/nix\/store\/[^\s]+\.drv|\/nix\/store\/[^\s]+)\s*$/,
];
const IMPORTANT = /\b(error|failed|failure|panicked|FAIL|fatal|assert)/i;

/** The last `limit` lines that are not build noise, favouring error lines. */
export function relevantLines(output: string, limit: number): string[] {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/\s+$/, "").replace(/^.*\r/, ""))
    .filter((line) => !NOISE.some((pattern) => pattern.test(line)));
  const important = lines.flatMap((line, index) =>
    IMPORTANT.test(line) ? [index] : [],
  );
  if (!important.length) return lines.slice(-limit);
  // Keep the last error lines and the closing lines, in their original order.
  const tail = Math.floor(limit / 2);
  const keep = new Set(important.slice(-(limit - tail)));
  for (let index = lines.length - 1; index >= 0 && keep.size < limit; index--)
    keep.add(index);
  return lines.filter((_, index) => keep.has(index)).slice(-limit);
}

function jobParts(job: Record<string, any>) {
  const lines = String(job.text ?? "").split("\n");
  const footer = lines.at(-1)?.startsWith("Full output:") ? lines.pop() : "";
  lines.shift();
  return {
    body: lines.join("\n"),
    footer: footer || `Full output: pi-jobs log ${job.handle}`,
  };
}

/** Concise model-facing text for a finished job. Keeps the handle. */
export function jobNotice(payload: unknown, limit = 12): string | undefined {
  const job = terminalJob(payload);
  if (!job || typeof job.text !== "string") return undefined;
  const header = job.text.split("\n")[0];
  const { body, footer } = jobParts(job);
  return [header, ...relevantLines(body, limit), footer].join("\n");
}

function jobTone(
  job: Record<string, any>,
): Pick<CompletionCard, "tone" | "glyph"> {
  if (job.state === "success") return { tone: "success", glyph: "✓" };
  if (job.state === "killed") return { tone: "warning", glyph: "■" };
  return { tone: "error", glyph: "✗" };
}

function elapsed(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

export function eventDescription(
  details: unknown,
  content: string,
): CompletionCard {
  const event = object(details);
  const job =
    event?.topic === "job.completed" ? object(event.payload) : undefined;
  if (job) {
    const { body } = jobParts(job);
    return {
      ...jobTone(job),
      title: String(job.name || "job"),
      meta: [
        job.state === "success" ? undefined : String(job.state),
        job.exit_code == null ? undefined : `exit ${job.exit_code}`,
        elapsed(job.elapsed_seconds),
        // The full handle stays in the model-facing text and expanded body.
        typeof job.handle === "string"
          ? `job ${job.handle.split(":")[0]}`
          : undefined,
      ],
      preview: relevantLines(body, job.state === "success" ? 2 : 4),
      body: [
        body.trim() || "No output.",
        `Full output: pi-jobs log ${job.handle}`,
      ].join("\n"),
    };
  }
  // Text-only events have no structured metadata. Expansion keeps the text.
  const lines = content.split("\n");
  const rest = lines[0]?.startsWith("[external event:")
    ? lines.slice(1)
    : lines;
  return {
    tone: "accent",
    glyph: "●",
    title: String(event?.topic || "event"),
    meta: [String(event?.source || "external")],
    preview: relevantLines(rest.join("\n"), 2),
    body: rest.join("\n"),
  };
}
