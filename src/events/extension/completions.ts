import { object, text, toolMessages } from "../../shared/completions";

export function jobResultObserved(
  payload: unknown,
  entries: readonly unknown[],
): boolean {
  const job = object(payload);
  if (
    !job ||
    typeof job.handle !== "string" ||
    !/^\d+:[a-f0-9]{32}$/.test(job.handle) ||
    (job.exit_code === null && job.state !== "unavailable") ||
    typeof job.text !== "string"
  )
    return false;
  const lines = job.text.split("\n");
  if (lines.pop() !== `Full output: pi-jobs log ${job.handle}`) return false;
  lines.shift();
  const body = lines.join("\n");
  const header = `job=${job.handle} ${job.state}${job.exit_code === null ? "" : ` exit=${job.exit_code}`}${job.name ? ` (${job.name})` : ""} elapsed=${job.elapsed_seconds}s`;
  return toolMessages(entries, "bash").some((message) => {
    const output = text(message.content);
    // A command string or a running/elapsed status is not a receipt. Require
    // the terminal snapshot AND all of the notification's retained output.
    if (output.split("\n").includes(header) && (!body || output.includes(body)))
      return true;
    try {
      const parsed = JSON.parse(output);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.some(
        (row) =>
          row?.handle === job.handle &&
          row.owner === job.owner &&
          row.state === job.state &&
          row.exit_code === job.exit_code &&
          row.name === job.name &&
          row.elapsed_seconds === job.elapsed_seconds &&
          [row.error?.slice(0, 256), row.tail?.slice(-4096)]
            .filter(Boolean)
            .join("\n") === body,
      );
    } catch {
      return false;
    }
  });
}
export function eventDescription(details: unknown, content: string) {
  const event = object(details);
  const job =
    event?.topic === "job.completed" ? object(event.payload) : undefined;
  if (job)
    return {
      title: `Job ${job.name || "job"} (${job.handle}) · ${job.state}${job.exit_code == null ? "" : ` exit=${job.exit_code}`}`,
      summary:
        String(job.text ?? content)
          .split("\n")
          .slice(1)
          .filter((line) => !line.startsWith("Full output:"))
          .join(" ") ||
        "No output. Full logs remain available with pi-jobs log.",
    };
  // Text-only events have no structured job metadata. Expansion retains the
  // original text for every topic.
  return {
    title: `Event ${event?.topic || "notification"} · ${event?.source || "external"}`,
    summary: content.split("\n").slice(1).join(" ") || content,
  };
}
