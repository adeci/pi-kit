/**
 * Claude Pro/Max subscription support for Pi.
 *
 * Pi already signs an Anthropic OAuth request as Claude Code: the identity
 * system block, the `claude-cli/<v>` user agent, `x-app: cli` and the
 * `oauth-2025-04-20` beta all ship in stock Pi. What it does not send is the
 * `x-anthropic-billing-header` attestation, so Anthropic does not accept the
 * subscription token. This component registers a second Anthropic provider
 * that adds that header.
 *
 * It is registered as a separate provider (`anthropic-sub`) rather than as an
 * override of `anthropic` so it composes with whatever already owns
 * `anthropic` — an API key, or a proxy that re-registers the provider for its
 * own endpoint. Sign in with `/login anthropic-sub`, then pick a model with
 * `/model anthropic-sub/<model>`.
 */

import type { Model, ProviderRequestOptions } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BILLING_HEADER_PREFIX,
  billingHeader,
  firstUserText,
  signBody,
} from "./cch";

const PROVIDER_ID = "anthropic-sub";
const PROVIDER_NAME = "Anthropic (Claude Pro/Max)";

/** Pi's Anthropic OAuth access tokens carry this marker; API keys never do. */
const OAUTH_TOKEN_MARKER = "sk-ant-oat";

/**
 * Prepend the billing header as system[0], which is where Claude Code puts it.
 * A body that already carries one is returned untouched, so a caller's
 * `onPayload` cannot cause a double block.
 */
function withBillingBlock(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const system =
    "system" in payload && Array.isArray(payload.system) ? payload.system : [];
  for (const block of system) {
    if (typeof block !== "object" || block === null) continue;
    if (!("text" in block) || typeof block.text !== "string") continue;
    if (block.text.startsWith(BILLING_HEADER_PREFIX)) return payload;
  }
  const messages = "messages" in payload ? payload.messages : undefined;
  return {
    ...payload,
    system: [
      { type: "text", text: billingHeader(firstUserText(messages)) },
      ...system,
    ],
  };
}

/**
 * Attach the billing attestation to an OAuth request. API-key requests are
 * returned unchanged: Anthropic requires the header only for subscription
 * tokens, and Pi's own API-key path must stay byte-identical.
 *
 * `cch` is a digest of the serialized body, so the header goes in through
 * `onPayload` and the digest is stamped into the body by the wrapped `fetch`
 * once the SDK has serialized it.
 */
function withBilling<T extends ProviderRequestOptions>(
  options: T | undefined,
): T | undefined {
  const apiKey = options?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.includes(OAUTH_TOKEN_MARKER)) {
    return options;
  }
  const send = options.fetch ?? fetch;
  const caller = options.onPayload;
  // Spread of a generic request-options type cannot be proven to the compiler;
  // every field except the two above is carried through as-is.
  return {
    ...options,
    onPayload: async (payload, model) =>
      withBillingBlock(
        caller ? ((await caller(payload, model)) ?? payload) : payload,
      ),
    fetch: (input, init) => {
      if (typeof init?.body !== "string") return send(input, init);
      const signed = signBody(init.body);
      return signed === init.body
        ? send(input, init)
        : send(input, { ...init, body: signed });
    },
  } as T;
}

export default function install(pi: ExtensionAPI): void {
  // Pi aliases only `pi-ai`, `pi-ai/compat`, `pi-ai/oauth` and
  // `pi-ai/providers/all` for extensions, so the built-in provider is looked
  // up from the aggregate entry rather than imported from its own module.
  const base = builtinProviders().find(
    (provider) => provider.id === "anthropic",
  );
  if (!base)
    throw new Error("claude-billing: Anthropic provider is unavailable");
  pi.registerProvider({
    ...base,
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    // Anthropic's built-in catalog is chat-only, so both accessors return the
    // same list; retagging it with our provider id is what routes a model to
    // this registration.
    getModels: () => base.getModels().map(retag),
    getAllModels: () => base.getModels().map(retag),
    stream: (model, context, options) =>
      base.stream(model, context, withBilling(options)),
    streamSimple: (model, context, options) =>
      base.streamSimple(model, context, withBilling(options)),
  });
}

function retag(model: Model<"anthropic-messages">) {
  return { ...model, provider: PROVIDER_ID };
}
