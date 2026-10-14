import { expect, test } from "bun:test";
import { jobResultObserved } from "./completions";
const handle = `12:${"a".repeat(32)}`;
const job = {
  handle,
  owner: "session",
  name: "build",
  state: "success",
  exit_code: 0,
  elapsed_seconds: 3,
  text: `job=${handle} (build) success exit=0 elapsed=3s\nresult line\nFull output: pi-jobs log ${handle}`,
};
const header = `job=${handle} success exit=0 (build) elapsed=3s`;
const entry = (output: string, toolName = "bash") => ({
  type: "message",
  message: {
    role: "toolResult",
    toolName,
    content: [{ type: "text", text: output }],
  },
});
test("terminal status plus the retained output is a receipt, not a command or running status", () => {
  expect(jobResultObserved(job, [entry(header + "\nresult line\n")])).toBe(
    true,
  );
  expect(jobResultObserved(job, [entry(header)])).toBe(false);
  expect(jobResultObserved(job, [entry("result line")])).toBe(false);
  expect(jobResultObserved(job, [entry(`pi-jobs log ${handle}`)])).toBe(false);
  expect(
    jobResultObserved(job, [
      entry(header.replace("success exit=0", "running") + "\nresult line"),
    ]),
  ).toBe(false);
  expect(
    jobResultObserved(job, [entry(header + "\nresult line", "read")]),
  ).toBe(false);
  expect(
    jobResultObserved({ ...job, handle: `12:${"b".repeat(32)}` }, [
      entry(header + "\nresult line"),
    ]),
  ).toBe(false);
});
test("JSON receipts require terminal identity and matching output; shell error is not job-result loss", () => {
  const row = { ...job, tail: "result line" };
  expect(jobResultObserved(job, [entry(JSON.stringify([row]))])).toBe(true);
  expect(
    jobResultObserved(job, [
      entry(JSON.stringify([{ ...row, tail: "older" }])),
    ]),
  ).toBe(false);
  expect(
    jobResultObserved(job, [
      entry(JSON.stringify([{ ...row, owner: "other" }])),
    ]),
  ).toBe(false);
  const failure = {
    ...job,
    state: "failed",
    exit_code: 1,
    text: job.text.replace("success exit=0", "failed exit=1"),
  };
  const failed = entry(
    header.replace("success exit=0", "failed exit=1") + "\nresult line",
  );
  (failed.message as any).isError = true;
  expect(jobResultObserved(failure, [failed])).toBe(true);
});
