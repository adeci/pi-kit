import { expect, test } from "bun:test";
import {
  eventDescription,
  jobNotice,
  jobResultObserved,
  relevantLines,
} from "./completions";
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
test("terminal status, wait or log receipts suppress; commands and running states do not", () => {
  // pi-jobs status HANDLE, with or without --tail.
  expect(jobResultObserved(job, [entry(header + "\nresult line\n")])).toBe(
    true,
  );
  expect(jobResultObserved(job, [entry(header)])).toBe(true);
  // pi-jobs wait / log print the receipt on stderr after the output.
  expect(
    jobResultObserved(job, [
      entry(`older output\njob=${handle} success exit=0\n`),
    ]),
  ).toBe(true);
  expect(jobResultObserved(job, [entry("result line")])).toBe(false);
  expect(jobResultObserved(job, [entry(`pi-jobs log ${handle}`)])).toBe(false);
  expect(
    jobResultObserved(job, [
      entry(
        `job=${handle} running; still running/queued. Continue with \`pi-jobs wait ${handle}\`.`,
      ),
    ]),
  ).toBe(false);
  expect(
    jobResultObserved(job, [
      entry(header.replace("success exit=0", "running") + "\nresult line"),
    ]),
  ).toBe(false);
  expect(jobResultObserved(job, [entry(`job=${handle} success exit=00`)])).toBe(
    false,
  );
  expect(
    jobResultObserved(job, [entry(header + "\nresult line", "read")]),
  ).toBe(false);
  expect(
    jobResultObserved({ ...job, handle: `12:${"b".repeat(32)}` }, [
      entry(header + "\nresult line"),
    ]),
  ).toBe(false);
  expect(
    jobResultObserved({ ...job, exit_code: null, state: "running" }, [
      entry(header),
    ]),
  ).toBe(false);
});
test("JSON receipts require terminal identity; shell error is not job-result loss", () => {
  const row = { ...job, tail: "result line" };
  expect(jobResultObserved(job, [entry(JSON.stringify([row]))])).toBe(true);
  expect(
    jobResultObserved(job, [entry(JSON.stringify([{ ...row, tail: "" }]))]),
  ).toBe(true);
  expect(
    jobResultObserved(job, [
      entry(JSON.stringify([{ ...row, owner: "other" }])),
    ]),
  ).toBe(false);
  expect(
    jobResultObserved(job, [
      entry(JSON.stringify([{ ...row, state: "running", exit_code: null }])),
    ]),
  ).toBe(false);
  const failure = {
    ...job,
    state: "failed",
    exit_code: 1,
    text: job.text.replace("success exit=0", "failed exit=1"),
  };
  const failed = entry(`job=${handle} failed exit=1`);
  (failed.message as any).isError = true;
  expect(jobResultObserved(failure, [failed])).toBe(true);
});
const noisy = [
  "warning: Git tree '/home/alex/git/pi-kit' has uncommitted changes",
  "   Compiling serde v1.0.200",
  "   Compiling pi-jobs v0.2.0 (/build)",
  "",
  "error[E0425]: cannot find value `x` in this scope",
  "  --> src/main.rs:3:5",
  "some context",
  'error: could not compile `pi-jobs` (bin "pi-jobs") due to 1 previous error',
].join("\n");
test("relevant lines drop build noise and favour errors", () => {
  expect(relevantLines(noisy, 3)).toEqual([
    "error[E0425]: cannot find value `x` in this scope",
    "some context",
    'error: could not compile `pi-jobs` (bin "pi-jobs") due to 1 previous error',
  ]);
  expect(relevantLines("a\n   Compiling x v1\nb\nb\n", 5)).toEqual([
    "a",
    "b",
    "b",
  ]);
});
test("job notice is concise, noise-free and keeps the handle", () => {
  const failed = {
    ...job,
    state: "failed",
    exit_code: 1,
    text: `job=${handle} (build) failed exit=1 elapsed=44s\n${noisy}\nFull output: pi-jobs log ${handle}`,
  };
  const notice = jobNotice(failed)!;
  expect(notice).not.toContain("Compiling");
  expect(notice).not.toContain("uncommitted");
  expect(notice.split("\n")[0]).toBe(
    `job=${handle} (build) failed exit=1 elapsed=44s`,
  );
  expect(notice).toContain("could not compile");
  expect(notice.endsWith(`Full output: pi-jobs log ${handle}`)).toBe(true);
  expect(jobNotice({ ...job, exit_code: null, state: "running" })).toBe(
    undefined,
  );
});
test("job card: status glyph and tone, name as title, dimmed metadata", () => {
  const card = eventDescription(
    {
      topic: "job.completed",
      source: "pi-jobs",
      payload: {
        ...job,
        state: "failed",
        exit_code: 1,
        elapsed_seconds: 44,
        text: `job=${handle} (build) failed exit=1 elapsed=44s\n${noisy}\nFull output: pi-jobs log ${handle}`,
      },
    },
    "",
  );
  expect(card).toMatchObject({ tone: "error", glyph: "✗", title: "build" });
  expect(card.meta).toEqual(["failed", "exit 1", "44s", handle]);
  expect(card.preview).toHaveLength(4);
  expect(card.preview!.join("\n")).not.toContain("Compiling");
  expect(card.body).toContain("Compiling");
  expect(card.body!.endsWith(`pi-jobs log ${handle}`)).toBe(true);
  expect(
    eventDescription(
      {
        topic: "job.completed",
        payload: { ...job, state: "killed", exit_code: 137 },
      },
      "",
    ),
  ).toMatchObject({ tone: "warning", glyph: "■" });
  expect(
    eventDescription({ topic: "job.completed", payload: job }, ""),
  ).toMatchObject({
    tone: "success",
    glyph: "✓",
    meta: [undefined, "exit 0", "3s", handle],
  });
  expect(
    eventDescription(
      { topic: "session.message", source: "alice" },
      "[external event: session.message; source: alice]\nhello",
    ),
  ).toMatchObject({ title: "session.message", preview: ["hello"] });
});
