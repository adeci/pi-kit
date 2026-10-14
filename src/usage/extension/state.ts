import { stripVTControlCharacters } from "node:util";

export type Provider = "openai-codex" | "anthropic";
export type Meter = {
  label: string;
  used?: number;
  reset?: number;
  detail?: string;
};
export type Report = {
  provider: Provider;
  fetchedAt: number;
  plan?: string;
  meters: Meter[];
};
export type Card = {
  provider: Provider;
  report?: Report;
  notice?: string;
  stale?: boolean;
  hidden?: boolean;
  cached?: boolean;
};
export function clean(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function percent(value: unknown): number | undefined {
  const n = finite(value);
  return n === undefined ? undefined : Math.min(n, 100);
}
function date(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" ? clean(value) : undefined;
}

/** Adapted from OMP v18.9.0 usage providers; see ../NOTICE. */
export function parse(
  provider: Provider,
  payload: unknown,
  now = Date.now(),
): Report | undefined {
  const body = record(payload);
  const meters: Meter[] = [];
  if (provider === "openai-codex") {
    const add = (raw: unknown, prefix = "") => {
      const limits = record(raw);
      for (const [key, fallback] of [
        ["primary_window", "Primary"],
        ["secondary_window", "Secondary"],
      ]) {
        const w = record(limits[key]);
        const used = percent(w.used_percent);
        const seconds = finite(w.limit_window_seconds);
        const label = seconds
          ? seconds >= 86400
            ? `${Math.round(seconds / 86400)}d`
            : `${Math.round(seconds / 3600)}h`
          : fallback;
        const at = finite(w.reset_at);
        const after = finite(w.reset_after_seconds);
        const reset =
          at !== undefined
            ? at > 1e12
              ? at
              : at * 1000
            : after === undefined
              ? undefined
              : now + after * 1000;
        if (used !== undefined || reset !== undefined)
          meters.push({ label: prefix + label, used, reset });
      }
    };
    add(body.rate_limit);
    if (Array.isArray(body.additional_rate_limits))
      for (const item of body.additional_rate_limits) {
        const extra = record(item);
        add(
          extra.rate_limit,
          `${text(extra.limit_name) || text(extra.metered_feature) || "Additional"} · `,
        );
      }
    const credit = record(body.credits);
    if (credit.unlimited === true)
      meters.push({ label: "Credits", detail: "unlimited" });
    else if (
      typeof credit.balance === "string" ||
      typeof credit.balance === "number"
    )
      meters.push({
        label: "Credit balance",
        detail: clean(String(credit.balance)),
      });
  } else {
    const add = (label: string, raw: unknown) => {
      const w = record(raw);
      const used = percent(w.utilization);
      const reset = date(w.resets_at);
      if (used !== undefined || reset !== undefined)
        meters.push({ label, used, reset });
    };
    add("5h", body.five_hour);
    add("7d", body.seven_day);
    add("7d · Opus", body.seven_day_opus);
    add("7d · Sonnet", body.seven_day_sonnet);
    if (Array.isArray(body.limits))
      for (const item of body.limits) {
        const w = record(item);
        const family = text(record(record(w.scope).model).display_name);
        const label =
          w.kind === "session"
            ? "5h"
            : w.kind === "weekly_all"
              ? "7d"
              : w.kind === "weekly_scoped" && family
                ? `7d · ${family}`
                : undefined;
        if (
          label &&
          !meters.some((m) => m.label.toLowerCase() === label.toLowerCase())
        )
          add(label, { utilization: w.percent, resets_at: w.resets_at });
      }
    const spend = record(body.spend);
    const extra = record(body.extra_usage);
    const money = (raw: unknown): number | undefined => {
      const v = record(raw),
        n = finite(v.amount_minor),
        exponent = finite(v.exponent);
      return n !== undefined &&
        Number.isSafeInteger(n) &&
        exponent !== undefined &&
        Number.isInteger(exponent) &&
        exponent <= 6 &&
        v.currency === "USD"
        ? n / 10 ** exponent
        : undefined;
    };
    let used: number | undefined,
      limit: number | undefined,
      uncapped = false;
    if (body.spend != null) {
      if (spend.enabled === true) {
        used = money(spend.used);
        limit = money(spend.limit);
        uncapped = spend.limit === null;
      }
    } else if (
      extra.is_enabled === true &&
      (extra.currency === undefined || extra.currency === "USD")
    ) {
      const exponent = finite(extra.decimal_places ?? 2);
      if (
        exponent !== undefined &&
        Number.isInteger(exponent) &&
        exponent <= 6
      ) {
        const u = finite(extra.used_credits),
          l = finite(extra.monthly_limit);
        used = u === undefined ? undefined : u / 10 ** exponent;
        limit = l === undefined ? undefined : l / 10 ** exponent;
        uncapped = extra.monthly_limit === null;
      }
    }
    if (used !== undefined && (uncapped || (limit !== undefined && limit > 0)))
      meters.push({
        label: "Extra usage",
        detail: `$${used.toFixed(2)} / ${uncapped ? "uncapped" : `$${limit!.toFixed(2)}`}`,
      });
  }
  return meters.length
    ? { provider, fetchedAt: now, plan: text(body.plan_type), meters }
    : undefined;
}

export function resetText(reset: number | undefined, now = Date.now()): string {
  if (reset === undefined) return "reset not reported";
  const seconds = Math.ceil((reset - now) / 1000);
  if (seconds <= 0) return "reset due; refresh";
  if (seconds < 60) return `resets in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `resets in ${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `resets in ${hours}h ${minutes % 60}m`
    : `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
