import { expect, test } from "bun:test";
import {
  BILLING_HEADER_PREFIX,
  billingHeader,
  firstUserText,
  signBody,
} from "./cch";

test("billing header names the pinned version, the CLI entrypoint and a placeholder", () => {
  expect(billingHeader("hello world, this is a prompt")).toBe(
    "x-anthropic-billing-header: cc_version=2.1.280.2f6; cc_entrypoint=cli; cch=00000;",
  );
});

test("version suffix hashes message characters 4, 7 and 20, padding short messages", () => {
  expect(billingHeader("abcdefghijklmnopqrstuvwxyz")).toBe(
    "x-anthropic-billing-header: cc_version=2.1.280.c6d; cc_entrypoint=cli; cch=00000;",
  );
  // Shorter than index 20: every missing position contributes "0".
  expect(billingHeader("")).toBe(
    "x-anthropic-billing-header: cc_version=2.1.280.d7b; cc_entrypoint=cli; cch=00000;",
  );
});

test("first user turn is read from string and block content, system turns ignored", () => {
  expect(
    firstUserText([
      { role: "user", content: "plain" },
      { role: "assistant", content: "later" },
    ]),
  ).toBe("plain");
  expect(
    firstUserText([
      {
        role: "user",
        content: [{ type: "text", text: "blk" }, { type: "image" }],
      },
    ]),
  ).toBe("blk");
  expect(firstUserText([{ role: "assistant", content: "no user turn" }])).toBe(
    "",
  );
  expect(firstUserText(undefined)).toBe("");
});

// The body below is hashed by Bun's XXH64 under the billing seed to produce
// `106bc`, so this pins placement *and* the digest end to end.
const signed =
  '{"model":"claude-opus-4-8","max_tokens":64000,"stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"hello there"}]}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=cli; cch=00000;"},{"type":"text","text":"You are Claude Code, Anthropic\'s official CLI for Claude."}]}';

test("signBody stamps the digest of the body carrying the placeholder", () => {
  const result = signBody(signed);
  expect(result).toContain("cch=106bc;");
  expect(result).not.toContain("cch=00000");
  expect(result.replace("cch=106bc", "cch=00000")).toBe(signed);
});

test("signBody leaves bodies without a billing header untouched", () => {
  expect(signBody('{"messages":[{"role":"user","content":"cch=00000"}]}')).toBe(
    '{"messages":[{"role":"user","content":"cch=00000"}]}',
  );
  expect(signBody("{}")).toBe("{}");
});

test("a placeholder far from the sentinel is not signed", () => {
  const body = `{"system":[{"type":"text","text":"${BILLING_HEADER_PREFIX} ${"x".repeat(200)} cch=00000;"}]}`;
  expect(signBody(body)).toBe(body);
});
