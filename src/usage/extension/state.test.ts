import { expect, test } from "bun:test";
import { parse, resetText } from "./state";
import { accountId, UsageService } from "./service";
const payload = {
  rate_limit: {
    primary_window: {
      used_percent: 25,
      limit_window_seconds: 18000,
      reset_after_seconds: 60,
    },
  },
};
const signal = () => new AbortController().signal;
test("Codex windows, absent values, additional meters and sanitization", () => {
  expect(parse("openai-codex", payload, 1000)?.meters[0]).toEqual({
    label: "5h",
    used: 25,
    reset: 61000,
  });
  expect(parse("openai-codex", { error: "no" })).toBeUndefined();
  const report = parse("openai-codex", {
    additional_rate_limits: [
      {
        limit_name: "\x1b[2JSpark",
        rate_limit: { secondary_window: { reset_at: 1000 } },
      },
    ],
  });
  expect(report?.meters[0]).toEqual({
    label: "Spark · Secondary",
    used: undefined,
    reset: 1_000_000,
  });
});
test("Claude old and new buckets coexist without hiding inactive limits", () => {
  const report = parse("anthropic", {
    five_hour: { utilization: 0 },
    limits: [
      { kind: "session", percent: 20 },
      {
        kind: "weekly_scoped",
        percent: 75,
        is_active: false,
        scope: { model: { display_name: "Opus" } },
      },
    ],
  });
  expect(report?.meters).toHaveLength(2);
  expect(report?.meters[0].used).toBe(0);
  expect(report?.meters[1].used).toBe(75);
  expect(
    parse("anthropic", { five_hour: { utilization: -1 } }),
  ).toBeUndefined();
});
test("money only displays known units and valid limits", () => {
  expect(
    parse("anthropic", {
      extra_usage: {
        is_enabled: true,
        used_credits: 1234,
        monthly_limit: 5000,
      },
    })?.meters[0].detail,
  ).toBe("$12.34 / $50.00");
  expect(
    parse("anthropic", {
      spend: {
        enabled: true,
        used: { amount_minor: 150, exponent: 2, currency: "USD" },
        limit: null,
      },
    })?.meters[0].detail,
  ).toBe("$1.50 / uncapped");
  expect(
    parse("anthropic", {
      extra_usage: {
        is_enabled: true,
        used_credits: 1234,
        monthly_limit: 5000,
        currency: "EUR",
      },
    }),
  ).toBeUndefined();
  expect(resetText(undefined)).toBe("reset not reported");
  expect(resetText(1, 2)).toBe("reset due; refresh");
});
test("account id parser rejects malformed and header-injection claims", () => {
  const jwt = (id: string) =>
    `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.x`;
  expect(accountId(jwt("account-1"))).toBe("account-1");
  expect(accountId(jwt("bad\r\nheader"))).toBeUndefined();
  expect(accountId("secret")).toBeUndefined();
});
test("cache expires, preserves stale results and respects rate limit backoff", async () => {
  let now = 0,
    calls = 0;
  const service = new UsageService(
    (async (_url, init) => {
      expect(init?.redirect).toBe("error");
      calls++;
      return calls === 1
        ? Response.json(payload)
        : new Response("secret must not reach UI", {
            status: 429,
            headers: { "retry-after": "120" },
          });
    }) as typeof fetch,
    () => now,
  );
  const auth = async () => ({ token: "private" });
  expect(
    (await service.get("openai-codex", auth, signal())).report,
  ).toBeDefined();
  await service.get("openai-codex", auth, signal());
  expect(calls).toBe(1);
  now = 61000;
  const failed = await service.get("openai-codex", auth, signal());
  expect(failed.stale).toBe(true);
  expect(JSON.stringify(failed)).not.toContain("secret");
  now = 130000;
  await service.get("openai-codex", auth, signal());
  expect(calls).toBe(2);
});
test("account changes and logout never reuse another credential's data", async () => {
  let calls = 0;
  const service = new UsageService((async () => {
    calls++;
    return Response.json(payload);
  }) as typeof fetch);
  await service.get("openai-codex", async () => ({ token: "one" }), signal());
  await service.get("openai-codex", async () => ({ token: "two" }), signal());
  expect(calls).toBe(2);
  expect(
    (
      await service.get(
        "openai-codex",
        async () => ({ notice: "Not logged in" }),
        signal(),
      )
    ).report,
  ).toBeUndefined();
});
test("cancel during auth starts no late request", async () => {
  let release!: (value: { token: string }) => void;
  const auth = new Promise<{ token: string }>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const service = new UsageService((async () => {
    calls++;
    return Response.json(payload);
  }) as typeof fetch);
  const controller = new AbortController();
  const pending = service.get("openai-codex", () => auth, controller.signal);
  controller.abort();
  await pending;
  release({ token: "private" });
  await Promise.resolve();
  expect(calls).toBe(0);
});
test("invalid and oversized responses become sanitized notices", async () => {
  for (const response of [
    new Response("not JSON secret"),
    new Response("x".repeat(1_048_577)),
  ]) {
    const service = new UsageService((async () => response) as typeof fetch);
    const card = await service.get(
      "anthropic",
      async () => ({ token: "private" }),
      signal(),
    );
    expect(card.report).toBeUndefined();
    expect(card.notice).toBe("Usage request failed. Try again later.");
  }
});
