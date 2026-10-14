import { stripVTControlCharacters } from "node:util";

export function clean(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Recorded price estimate for the active branch, including tools and compaction once. */
export function sessionCost(entries: readonly unknown[]): number {
  return entries.reduce<number>((total, value) => {
    const entry = record(value);
    const usage = record(
      entry.type === "message" ? record(entry.message).usage : entry.usage,
    );
    const cost = record(usage.cost).total;
    return (
      total +
      (typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? cost
        : 0)
    );
  }, 0);
}
