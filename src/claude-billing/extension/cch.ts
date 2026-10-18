/**
 * Claude Code's `x-anthropic-billing-header` attestation.
 *
 * An Anthropic OAuth (Claude Pro/Max subscription) bearer token is only
 * accepted on a request that also carries Claude Code's billing header as the
 * first system block:
 *
 *   x-anthropic-billing-header: cc_version=<v>.<suffix>; cc_entrypoint=cli; cch=<hash>;
 *
 * `cc_version`'s 3-hex suffix is a digest of the first user message, and `cch`
 * is an XXH64 of the serialized request body, so both must be computed per
 * request. Pi sends the identity block ("You are Claude Code, ..."), the
 * `claude-cli/<v>` user agent and the `oauth-2025-04-20` beta, but not this
 * header — which is the whole difference between a request Anthropic bills to
 * a subscription and one it refuses.
 *
 * Algorithm and constants are taken from oh-my-pi's
 * `providers/claude-code-fingerprint.ts` and `providers/anthropic.ts`
 * (`createClaudeBillingHeader`, `patchCch`), which are the implementation this
 * was verified against. See NOTICE.
 */

import { createHash } from "node:crypto";
import { cchDigest } from "./xxhash64.ts";

/**
 * Claude Code CLI version advertised on the wire. Must match the
 * `claudeCodeVersion` constant in Pi's `api/anthropic-messages.ts`, which is
 * what Pi already puts in its `claude-cli/<v>` user agent; a mismatch between
 * the user agent and the billing header is a fingerprint divergence.
 */
export const CLAUDE_CODE_VERSION = "2.1.280";

/** Salt for the `cc_version` suffix digest, extracted from Claude Code's JS. */
const VERSION_SALT = "59cf53e54c78";

/** Positions in the first user message that seed the version suffix. */
const SUFFIX_INDEXES = [4, 7, 20];

/**
 * XXH64 seed baked into the Claude Code build this version advertises. Claude
 * Code rotates the seed between releases; `cch` is only recomputable by
 * Anthropic if it matches the version named in the same header.
 */
const CCH_SEED = 0x4d659218e32a3268n;

/** Placeholder replaced with the real `cch` digest just before the body ships. */
export const CCH_PLACEHOLDER = "cch=00000";

/** Opening of the sentinel, including the quote that precedes it in JSON. */
export const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

/**
 * How far after the sentinel the placeholder may sit. The header text is ~60
 * bytes; anything further means we matched the wrong occurrence.
 */
const PLACEHOLDER_WINDOW = 150;

/** The billing header block for a conversation's first user turn. */
export function billingHeader(firstUserText: string): string {
  const suffix = SUFFIX_INDEXES.map(
    (index) => firstUserText[index] ?? "0",
  ).join("");
  const digest = createHash("sha256")
    .update(`${VERSION_SALT}${suffix}${CLAUDE_CODE_VERSION}`)
    .digest("hex")
    .slice(0, 3);
  return `${BILLING_HEADER_PREFIX} cc_version=${CLAUDE_CODE_VERSION}.${digest}; cc_entrypoint=cli; ${CCH_PLACEHOLDER};`;
}

/** Text of a serialized content block, or "" for blocks that carry none. */
function blockText(block: unknown): string {
  if (typeof block !== "object" || block === null) return "";
  if (!("text" in block)) return "";
  return typeof block.text === "string" ? block.text : "";
}

/** Text of the first user turn in a serialized Anthropic `messages` array. */
export function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    if (!("role" in message) || message.role !== "user") continue;
    if (!("content" in message)) return "";
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map(blockText).join("");
  }
  return "";
}

/**
 * Replace the `cch` placeholder in a serialized request body with the digest
 * of that same body. Bodies without a billing header are returned unchanged,
 * so this is safe to install on every request. The digest is computed over the
 * body *with the placeholder still in place*, which is what Claude Code hashes.
 */
export function signBody(body: string): string {
  const marker = body.indexOf(`"${BILLING_HEADER_PREFIX}`);
  if (marker === -1) return body;
  const from = marker + BILLING_HEADER_PREFIX.length + 1;
  const at = body.indexOf(CCH_PLACEHOLDER, from);
  if (at === -1 || at - from > PLACEHOLDER_WINDOW) return body;
  const digest = cchDigest(new TextEncoder().encode(body), CCH_SEED);
  return `${body.slice(0, at)}cch=${digest}${body.slice(at + CCH_PLACEHOLDER.length)}`;
}
