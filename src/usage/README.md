# Usage

`/usage` shows logged-in OpenAI Codex and Anthropic Claude subscriptions. Each
provider keeps its own meters, reset times, credits and extra-usage fields;
percentages are never added together. Logged-out and API-key-only providers are
omitted; configured subscriptions with failed requests still show an error.

Enable `pi-kit.usage.enable = true`. Package: `pi-kit-usage`; discovery:
`kit-usage`. Requires stock Pi 1.1.0 and an OAuth login through `/login` for each
provider you want to query. No other pi-kit component is required.

The centered panel gives each provider the full width. OMP-style solid/hatched
bars show used quota; labels show both the percentage remaining and used. Labels
stack around the wide bars on narrow terminals. Credit balances retain their
reported units and are rounded to two decimal places for display. No activity
history is collected.

Elapsed/reset times redraw every second while open without fetching new data.
Use arrow keys or Page Up/Down to scroll, `r` to refresh, and Escape to close.
Successful responses are cached for 60 seconds. Pressing `r` briefly acknowledges
cached results without resetting their age. Failures also pause refreshing;
429 responses respect a bounded Retry-After delay. A failed refresh labels any
previous result stale. Unreported values never appear as zero usage.

Requests only run while this view is open. They use Pi's credential API and the
providers' first-party OAuth usage endpoints; custom endpoints are not queried.
Each refresh is limited to 15 seconds and 1 MiB per response. Redirects are
rejected. Closing the view cancels quota requests; an SDK credential refresh
already in progress cannot be cancelled, but its late result starts no request.
No credentials or quota responses are written to disk or added to model context.

API-key billing is separate and is not supported here. Provider endpoint/schema
changes can make quota information unavailable. This view does not switch
accounts, redeem resets, change subscriptions, or block model requests.

Provider parsing and quota-bar layout are adapted from OMP v18.9.0; see
[NOTICE](NOTICE). Offline tests cover parsing, rendering and failure handling. Live quota availability depends on provider
access and is not established by those tests.
