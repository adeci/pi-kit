# Handoff

`/handoff` opens the shared settings popup. There are no focus or cancel
subcommands. Settings take effect immediately for the next handoff:

- **Automatic handoff:** on or off. Off restores stock Pi compaction.
- **Context threshold:** freeform whole percentage from 1–99%, default 80%.
  A trailing `%` is optional. Empty, cancelled or invalid input leaves the value unchanged.
- **Summarizer:** an authenticated, exact provider/model, or the current working
  model. Selecting a summarizer does not change the model doing the work.

The optional component is off in the Nix suite by default. Once installed,
automatic handoff defaults on, using the current working model at 80%.

## Automatic operation

After an assistant turn and its tools finish, the extension checks Pi's estimated
context usage. At the configured percentage, it generates a structured continuity
record and returns a compaction entry through Pi's supported turn-boundary API.
Pi persists the entry and continues its existing tool/steering workflow with the
summary and retained recent history. Handoff does not inject a continuation
prompt, add another worker, or force a finished task to keep running.

Checks happen between turns, not while streaming or immediately when a large
user message is submitted. Pi's native pre-prompt, threshold and overflow checks
remain safety nets and can run earlier than the chosen percentage. While handoff
is enabled, these native compactions and manual `/compact` use the selected
summarizer too. The percentage trigger does not change Pi's native settings.
Another extension's proposed context changes defer the percentage check until a
later eligible boundary.

**Escape cancels generation.** During automatic handoff it cancels the active
run; during `/compact` Pi handles cancellation. There is no separate cancellation
command. Failed, aborted, truncated or incomplete summaries are not committed.
Generation failure stops the active run rather than silently choosing another
model or repeatedly retrying. Check the model in `/handoff`, then explicitly
resume work. Pi's native overflow recovery may already have omitted a failed
assistant attempt before invoking the summarizer; those omission edits remain.

## What is retained

A handoff is **lossy**, not a memory guarantee or proof that work is complete.
The record covers the goal, constraints, progress, decisions, critical context
and next steps. The model sees Pi's projected context, including previous
summaries and recent messages. The extension does not separately truncate tool
output or flatten image blocks into a text transcript.

Pi's public cut selector and `compaction.keepRecentTokens` determine the retained
recent span. Tool calls stay paired with their results. Context edits are honored;
omitted history is not resurrected. Native compaction keeps its prepared cut
boundary. Original transcript entries remain stored. Generation usage is included
in session totals. Section validation checks shape, not factual completeness.

The summarizer must support the input and fit it in its context window. A smaller
summarizer may require a lower percentage. Very low percentages relative to the
retained-history budget can cause frequent compaction. Choose the model and
threshold together; the extension never silently substitutes another model.

## Settings and installation

Settings live in `~/.config/pi-kit/handoff.json`, respecting `XDG_CONFIG_HOME`.
`PI_HANDOFF_CONFIG` overrides the path. Writes preserve unknown fields, validate
values, use a private temporary file and atomic rename, and refuse symlinked
config files. No Pi settings or credentials are changed. External edits load on
session start or when `/handoff` is opened.

```json
{
  "enabled": true,
  "threshold": 80,
  "model": { "provider": "your-provider", "id": "exact-model-id" }
}
```

Use `"model": null` to follow the working model.

With the default NixOS or Darwin suite module:

```nix
pi-kit.handoff.enable = true;
```

The standalone module export is `handoff`; the package is
`pi-kit-handoff`. Discovery uses `kit-handoff`. No other pi-kit component is required.
From a source checkout: `pi -e ./src/handoff/extension/index.ts`.

Tested against stock Pi 1.0.0. Unit tests mock the SDK boundary; the offline
installed-Pi integration test checks the settings popup, model routing,
automatic tool-turn continuation, retained tool pairs, failures, Escape, native
compaction, discovery symlinks and reload. Native Darwin runtime still needs
separate validation.
