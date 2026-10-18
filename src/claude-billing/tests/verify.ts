/**
 * Recompute the Claude Code billing attestation from a captured request body
 * and report whether it matches what pi put on the wire.
 *
 *   bun run verify.ts <captured-body.json>
 *
 * Used by `smoke.sh`; see that script for the full check.
 */

import { createHash } from "node:crypto";
import { cchDigest } from "../extension/xxhash64";

const path = process.argv[2];
if (!path) throw new Error("usage: verify.ts <captured-body.json>");

const raw = await Bun.file(path).text();
const body = JSON.parse(raw);

const SEED = 0x4d659218e32a3268n;
const expected = cchDigest(
  new TextEncoder().encode(raw.replace(/cch=[0-9a-f]{5}/, "cch=00000")),
  SEED,
);
const actual = /cch=([0-9a-f]{5})/.exec(raw)?.[1];
if (!actual) throw new Error("no cch value in body");
if (actual !== expected) {
  throw new Error(`cch mismatch: wire=${actual} recomputed=${expected}`);
}
console.log(`cch ${actual} recomputes`);

const version = /cc_version=([0-9.]+)\.([0-9a-f]{3})/.exec(raw);
if (!version) throw new Error("no cc_version in body");
const first = body.messages.find(
  (message: { role: string }) => message.role === "user",
);
const text =
  typeof first.content === "string"
    ? first.content
    : first.content
        .map((block: { text?: string }) => block.text ?? "")
        .join("");
const chars = [4, 7, 20].map((index) => text[index] ?? "0").join("");
const suffix = createHash("sha256")
  .update(`59cf53e54c78${chars}${version[1]}`)
  .digest("hex")
  .slice(0, 3);
if (suffix !== version[2]) {
  throw new Error(
    `version suffix mismatch: wire=${version[2]} recomputed=${suffix}`,
  );
}
console.log(`cc_version ${version[1]}.${version[2]} recomputes`);

const { CLAUDE_CODE_VERSION } = await import("../extension/cch");
if (version[1] !== CLAUDE_CODE_VERSION) {
  throw new Error(
    `advertised version ${version[1]} != extension constant ${CLAUDE_CODE_VERSION}`,
  );
}
console.log(`version matches the extension constant ${CLAUDE_CODE_VERSION}`);
