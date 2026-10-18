# Claude billing

Use a Claude Pro/Max subscription (Anthropic OAuth) with stock Pi.

Pi already signs an OAuth request as Claude Code: the identity system block,
the `claude-cli/<version>` user agent, `x-app: cli`, and the
`oauth-2025-04-20` and `claude-code-20250219` betas all ship in Pi. Anthropic
still refuses the subscription token, because the request is missing the
`x-anthropic-billing-header` attestation that Claude Code puts in the first
system block:

```
x-anthropic-billing-header: cc_version=<v>.<suffix>; cc_entrypoint=cli; cch=<hash>;
```

`suffix` is a digest of characters 4, 7 and 20 of the first user message, and
`cch` is XXH64 of the serialized request body. Both are computed per request,
so this cannot be a static header.

Enable `pi-kit.claude-billing.enable = true`. Package:
`pi-kit-claude-billing`; discovery: `kit-claude-billing`. Requires stock Pi
1.2.0 or newer. No other pi-kit component is required.

## Use

```sh
/login anthropic-sub          # Anthropic (Claude Pro/Max)
/model anthropic-sub/claude-opus-4-8
```

The provider is registered as `anthropic-sub` rather than as an override of
`anthropic`, so it composes with whatever already owns `anthropic` — an API
key, or a proxy that re-registers the provider for its own endpoint. Signing in
to `anthropic-sub` does not disturb it. `/usage` reports the subscription's
quota, because the credential is stored under that provider name.

API-key requests through `anthropic-sub` are sent unchanged; the attestation is
added only when the resolved credential is an OAuth token (`sk-ant-oat…`).

## Verify after a Pi upgrade

```sh
./tests/smoke.sh "$(command -v pi)"
```

Drives the given Pi against a local capture server with a fake subscription
token and checks the request Pi actually put on the wire: the billing header is
`system[0]`, `cch` and the version suffix recompute, the advertised version
still matches this extension's constant, and neither the stock `anthropic`
provider nor an API-key request is attested. Run it against the Pi you use —
a Pi that already routes `anthropic` through a proxy fails the stock control by
design, because that control needs a stock `anthropic` provider.

The check exists because two of the failure modes below are silent: if Pi stops
plumbing `onPayload`/`fetch` through the Anthropic transport, or if Pi bumps its
advertised Claude Code version, requests still go out — just without a valid
attestation.

## Caveats

- `CLAUDE_CODE_VERSION` in `extension/cch.ts` must match the `claudeCodeVersion`
  constant in Pi's `api/anthropic-messages.ts`, which is what Pi puts in its
  user agent. A Pi bump that changes the version without a matching change here
  makes the header disagree with the user agent.
- The `cch` seed belongs to that version. Claude Code rotates it between
  releases, so the pinned pair has to move together.
- The billing block is `system[0]` and its `cch` changes every turn, while Pi
  marks the following identity block as the cache breakpoint. This mirrors
  Claude Code's own layout, which Anthropic's cache excludes.
