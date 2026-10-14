import { createHash, timingSafeEqual } from "node:crypto";

export const FRAME_BYTES = 16384;
export const EVENT_BYTES = 15360;
export const TOPICS = 64;
export const DUPLICATES = 256;
// JavaScript's $ also matches before a trailing newline; use an absolute end.
export const TOPIC = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}(?![\s\S])/;
const ID = /^[a-f0-9]{32}(?![\s\S])/;
export interface Event {
  version: 1;
  id: string;
  topic: string;
  source: string;
  payload: unknown;
}
export const matches = (pattern: string, topic: string) =>
  pattern === topic ||
  (pattern.endsWith(".*") && topic.startsWith(pattern.slice(0, -1)));

export function validate(event: any): asserts event is Event {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    event.version !== 1 ||
    typeof event.id !== "string" ||
    !ID.test(event.id) ||
    typeof event.topic !== "string" ||
    !TOPIC.test(event.topic) ||
    typeof event.source !== "string" ||
    !TOPIC.test(event.source) ||
    !("payload" in event)
  )
    throw new Error("Invalid event");
  const encoded = JSON.stringify(event, (key, value) => {
    if (
      /[\uD800-\uDFFF]/u.test(key) ||
      (typeof value === "string" && /[\uD800-\uDFFF]/u.test(value))
    )
      throw new Error("Lone Unicode surrogate");
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)))
    )
      throw new Error(
        "Event numbers must be finite; large integers must be strings",
      );
    if (["undefined", "function", "symbol", "bigint"].includes(typeof value))
      throw new Error("Invalid JSON value");
    return value;
  });
  if (Buffer.byteLength(encoded) > EVENT_BYTES)
    throw new Error("Event exceeds size limit");
}
export function decodeFrame(bytes: Uint8Array): unknown {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
}

export function validateFrame(
  frame: any,
  subscription: string,
  token: string,
): Event {
  const supplied = Buffer.from(
    typeof frame?.token === "string" ? frame.token : "",
  );
  const expected = Buffer.from(token);
  if (
    frame?.version !== 1 ||
    frame.subscription !== subscription ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new Error("Invalid subscription capability");
  validate(frame.event);
  return frame.event;
}
export function fingerprint(event: Event): string {
  const canonical = JSON.stringify(event, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, value[key]]),
      );
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}
