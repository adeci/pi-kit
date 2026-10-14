import { createHash } from "node:crypto";
import { parse, record, type Card, type Provider, type Report } from "./state";

export type Auth =
  { token: string; accountId?: string } | { notice: string; hidden?: boolean };
export type Resolve = (provider: Provider) => Promise<Auth>;
const endpoints: Record<Provider, string> = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  anthropic: "https://api.anthropic.com/api/oauth/usage",
};
const TTL = 60_000;
const MAX_BYTES = 1_048_576;
type Cached = {
  identity: string;
  next: number;
  report?: Report;
  notice?: string;
};

export function accountId(token: string): string | undefined {
  try {
    const part = token.split(".")[1];
    if (!part || part.length > 32768) return undefined;
    const claims = record(
      JSON.parse(Buffer.from(part, "base64url").toString("utf8")),
    );
    const id = record(claims["https://api.openai.com/auth"]).chatgpt_account_id;
    return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
      ? id
      : undefined;
  } catch {
    return undefined;
  }
}

async function body(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) throw new Error("large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** No background polling, disk cache, credential storage, or account mutation. */
export class UsageService {
  private cache = new Map<Provider, Cached>();
  constructor(
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  clear() {
    this.cache.clear();
  }
  async get(
    provider: Provider,
    resolve: Resolve,
    signal: AbortSignal,
  ): Promise<Card> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    // SDK credential refresh has no AbortSignal API. Stop awaiting it on close;
    // never start a quota request with a late credential result.
    let abort: (() => void) | undefined;
    let auth: Auth;
    try {
      deadline.throwIfAborted();
      auth = await Promise.race([
        resolve(provider),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("cancelled"));
          deadline.addEventListener("abort", abort, { once: true });
        }),
      ]);
      deadline.throwIfAborted();
    } catch {
      return {
        provider,
        notice: "Authentication unavailable or timed out. Check /login.",
      };
    } finally {
      if (abort) deadline.removeEventListener("abort", abort);
    }
    if ("notice" in auth) {
      this.cache.delete(provider);
      return { provider, notice: auth.notice, hidden: auth.hidden };
    }
    const identity = createHash("sha256")
      .update(auth.token)
      .update(auth.accountId ?? "")
      .digest("hex");
    const old = this.cache.get(provider);
    const cached = old?.identity === identity ? old : undefined;
    if (cached && cached.next > this.now())
      return {
        provider,
        report: cached.report,
        notice: cached.notice,
        stale: !!cached.notice && !!cached.report,
        cached: true,
      };
    let report = cached?.report;
    let notice: string | undefined;
    let delay = TTL;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
      };
      if (provider === "anthropic")
        headers["anthropic-beta"] = "oauth-2025-04-20";
      else if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
      const response = await this.request(endpoints[provider], {
        headers,
        signal: deadline,
        redirect: "error",
      });
      if (!response.ok) {
        if (response.status === 429) {
          const raw = response.headers.get("retry-after");
          const seconds = raw ? Number(raw) : NaN;
          const until = raw ? Date.parse(raw) : NaN;
          delay = Math.max(
            TTL,
            Math.min(
              3_600_000,
              Number.isFinite(seconds)
                ? seconds * 1000
                : Number.isFinite(until)
                  ? until - this.now()
                  : TTL,
            ),
          );
        }
        notice =
          response.status === 401 || response.status === 403
            ? "Access refused. Check /login."
            : response.status === 429
              ? "Rate limited; refresh is temporarily paused."
              : `Usage unavailable (HTTP ${response.status}).`;
        await response.body?.cancel().catch(() => {});
      } else {
        const result = parse(provider, await body(response), this.now());
        if (result) report = result;
        else notice = "Provider did not report recognizable usage.";
      }
    } catch {
      notice = deadline.aborted
        ? "Usage request cancelled or timed out."
        : "Usage request failed. Try again later.";
    }
    if (!deadline.aborted)
      this.cache.set(provider, {
        identity,
        next: this.now() + delay,
        report,
        notice,
      });
    return { provider, report, notice, stale: !!notice && !!report };
  }
}
