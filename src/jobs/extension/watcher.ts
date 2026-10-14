export interface Job {
  handle: string;
  owner: string;
  name: string;
  state: string;
  exit_code: number | null;
  elapsed_seconds: number;
  tail?: string;
  error?: string;
}

// Leave space for the event envelope and routing frame within the 16 KiB limit.
export function jobEvent(job: Job) {
  const { tail = "", error, ...metadata } = job;
  const summary = { ...metadata, error, tail };
  const event = { ...metadata, text: formatJob(summary) };
  while (
    Buffer.byteLength(JSON.stringify(event)) > 12288 &&
    summary.tail.length
  ) {
    const keep = Math.floor(summary.tail.length / 2);
    summary.tail = keep ? summary.tail.slice(-keep) : "";
    event.text = formatJob(summary);
  }
  return event;
}

export function formatJob(job: Job): string {
  return [
    `job=${job.handle}${job.name ? ` (${job.name.slice(0, 120)})` : ""} ${job.state}${job.exit_code === null ? "" : ` exit=${job.exit_code}`} elapsed=${job.elapsed_seconds}s`,
    job.error?.slice(0, 256),
    job.tail?.slice(-4096),
    `Full output: pi-jobs log ${job.handle}`,
  ]
    .filter(Boolean)
    .join("\n");
}
