import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DUPLICATES,
  EVENT_BYTES,
  FRAME_BYTES,
  TOPICS,
  fingerprint,
  matches,
  validate,
  validateFrame,
} from "./protocol";
const fixtures = JSON.parse(
  readFileSync(new URL("../protocol.json", import.meta.url), "utf8"),
);

test("shared protocol limits", () => {
  expect(fixtures.limits).toEqual({
    frameBytes: FRAME_BYTES,
    eventBytes: EVENT_BYTES,
    topics: TOPICS,
    duplicates: DUPLICATES,
  });
});
test("events require a complete object", () => {
  for (const value of [null, [], { version: 1 }])
    expect(() => validate(value)).toThrow();
});
for (const item of fixtures.events)
  test(`shared event: ${item.name}`, () => {
    const event = { ...fixtures.event, ...item.changes };
    for (const key of item.remove ?? []) delete event[key];
    if (item.rawPayload) event.payload = JSON.parse(item.rawPayload);
    if (item.valid) validate(event);
    else expect(() => validate(event)).toThrow();
  });
for (const item of fixtures.sizes)
  test(`shared event bytes: ${item.character} × ${item.count}`, () => {
    const event = {
      ...fixtures.event,
      payload: item.character.repeat(item.count),
    };
    if (item.valid) validate(event);
    else expect(() => validate(event)).toThrow();
  });
for (const item of fixtures.patterns)
  test(`shared topic: ${item.pattern} / ${item.topic}`, () => {
    expect(matches(item.pattern, item.topic)).toBe(item.matches);
  });
for (const item of fixtures.frames)
  test(`shared frame: ${item.name}`, () => {
    const frame = {
      version: 1,
      subscription: "a".repeat(32),
      token: "a".repeat(32),
      event: fixtures.event,
      ...item.changes,
    };
    for (const key of item.remove ?? []) delete frame[key];
    if (item.valid) validateFrame(frame, "a".repeat(32), "a".repeat(32));
    else
      expect(() =>
        validateFrame(frame, "a".repeat(32), "a".repeat(32)),
      ).toThrow();
  });
for (const [index, item] of fixtures.duplicates.entries())
  test(`shared duplicate identity: ${index}`, () => {
    expect(
      fingerprint({ ...fixtures.event, payload: item.first }) ===
        fingerprint({ ...fixtures.event, payload: item.second }),
    ).toBe(item.same);
  });
