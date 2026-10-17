# Agents

Integrated subagents for stock Pi 1.0.0 or newer. Load the extension for one launch:

```sh
pi -e ./result/share/pi-kit/agents
```

The main Pi process owns the supervisor and all agent workers. Each worker runs stock Pi in RPC mode, with a small parent-owned cleanup helper. A private pipe binds the helper to Pi's lifetime, including abrupt parent exit. The helper stops the worker and its observed tool process groups; Linux child-subreaper adoption also catches newly orphaned descendants. This is process cleanup, not an OS sandbox. Native Darwin runtime behavior still needs validation.

No agent daemon, external broker, Pueue-hosted model worker, notification spool or automatic restart is added. `pi-events` is optional observation. Agents work without it or `pi-jobs`. Commands deliberately submitted through `pi-jobs` retain their independent durable-job semantics.

## Configure roles and models

`XDG_RUNTIME_DIR` must name a private runtime directory; NixOS normally supplies it. For a manual Darwin trial, create a private temporary directory and export it before starting Pi. No launch agent is installed to run model workers.

Configuration is user-owned at `~/.config/pi-kit/agents.json`, or the file named by `PI_AGENTS_CONFIG`. Open `/agents`, press Tab to reach Settings, open each agent type and select its Model. The picker saves an exact available/authenticated `provider/model-id` for that role. Models start unconfigured, which means each worker inherits the model of the agent that delegated to it; choose an exact identity to pin a role. The menu creates or atomically updates this file only when you save a setting; it never edits Pi settings. Model/role defaults apply to future assignments without changing active workers. Reusable workers keep their existing model unless an assignment explicitly overrides it. You can also edit `agents.example.json` manually.

```json
{
  "version": 1,
  "maxConcurrency": 32,
  "maxDepth": 2,
  "idleTtlMs": 420000,
  "roles": {
    "task": { "model": "provider/model-id" },
    "reviewer": { "model": "provider/model-id" },
    "sonic": { "model": "provider/model-id" },
    "scout": {
      "model": "provider/model-id",
      "tools": ["read", "grep", "find", "ls", "bash"],
      "skills": ["~/.agents/skills/browser-cli/SKILL.md"]
    }
  }
}
```

The bundled roles are `task`, `scout`, `reviewer` and `sonic`. Roles define `description`, `prompt` or `promptFile`, `model`, `thinking`, `tools`, `skills`, `extensions`, `writable`, `requestBudget`, `maxRuntimeMs` and `maxConcurrency`. Relative resource paths resolve beside the configuration file. Set each role's `model` to an exact `provider/model-id`, or `null` to inherit the delegating agent's model (the root session's current model at depth 1). Custom roles require a prompt. Assignments may override the model or thinking level and narrow the role's tools/skills. Unavailable models fail without fallback.

`skills` selects individual skill packages or `SKILL.md` files, not a directory containing many packages. Selected packages are privately copied before queueing. Links inside packages and special files are rejected; managed top-level links are resolved. Selected skills must load in the worker, either from the snapshot or as an inherited skill of the same name. `extensions` lists additional supporting extensions. Workers inherit the parent's resources: discovered extensions and skills (for example `~/.pi/agent/extensions`, project `.pi` resources and settings packages), the parent's explicit `-e`/`--extension` and `--skill` arguments, and its `--no-extensions`/`--no-skills` choices. Provider extensions therefore supply the same credentials to workers as to the parent. Tools are still narrowed per role. Interactive extension dialogs are cancelled in workers; the agent must report the blocker rather than wait for an unseen prompt.

`writable` chooses the default workspace isolation policy. It does not enforce read-only Bash or contain extension code. A reviewer has Bash for scoped validation; its prompt forbids editing. Use an OS sandbox or another UID for hostile code.

## Execution and results

Task-scoped agents are the default. They exit after settlement. Reusable agents retain their own conversation and workspace across assignments; after seven idle minutes they park to disk. `agent_assign` starts another reusable assignment. `agent_resume` explicitly continues interrupted work. Parent exit stops execution and preserves state; reopening the same Pi session does not run agents or replay completion notifications.

A new agent receives its role, normal project instructions, explicit assignment and selected context. It never receives the parent's conversation automatically. Reusable agents retain their own history. Parent-session linkage records lineage, not inherited context.

Concurrency is per delegating session, default 32, not tree-wide. Every nested agent uses its role's concurrency limit. `0` disables that limit. Depth defaults to two: main Pi, child, grandchild. The supervisor retains at most 256 agent handles by default (`maxAgents`); forget settled leaves explicitly when needed. These limits do not establish a global spending budget.

Request budgets apply to every assignment, including reusable continuations. Defaults are 200 assistant requests, or 100 for scout/sonic. The agent receives a wrap-up notice at its budget. At 1.5 times the budget, ordinary work tools are blocked and the agent must settle delegates and yield a partial report. Five further assistant requests are allowed before abort. `0` disables the request guard. Wall-clock limits (`maxRuntimeMs`) default to `0`, unlimited. Retries or new assignments receive new budgets; the parent controls recovery autonomously.

`agent_yield` requires an outcome (`completed`, `blocked`, `failed`), summary, artifacts, validation and unresolved issues; optional `data` carries structured task-specific output. Descendants must settle first. A crash, missing report, cancellation, timeout or budget stop retains partial results with its actual supervisor status. `completed` remains the agent's report, not an independent correctness verdict.

Results settle after artifact writes and diff capture. Unread results notify their parent; progress only changes the UI. In the main Pi session, busy-session notifications stay pending until Pi would settle, then share one continuation. If `agent_status` already returned the same assignment's complete report, its pending notification is suppressed. Running status, waits, truncated reports and persistence failures do not count as reading the result. Escape or an error does not restart the model; pending notices can be delivered on a later successful turn. Reload and session replacement discard pending notices without replay. Nested workers retain their existing RPC follow-up delivery. RPC acknowledgment means receipt, not correctness; on an ambiguous timeout inspect state before retrying.

Messages use `agent_send`. A running agent receives guidance; an idle reusable child receives a new assignment. Children may address their ancestors and their own descendants; siblings communicate through their parent. The supervisor's private socket routes commands to worker RPC connections. It is session-owned, not an external broker or mailbox.

## Writer isolation and integration

Writer roles use isolated Git worktrees by default. The repository must have a commit, and the agent state directory must be outside it. Snapshots include the caller's current working state, with staged/unstaged changes and non-ignored untracked files. Tracked files remain included even when ignored. The caller's index and branch remain unchanged. Snapshot failures, concurrent caller edits during capture, and oversized dirty state refuse launch. Git hooks/signing are disabled for supervisor operations; repositories using submodules or external filters are refused rather than running filters or returning incomplete workspaces. `snapshotBytes` defaults to 16 MiB of changed content; no files are silently dropped.

Returned diffs contain changes after the assignment baseline. `agent_integrate` applies a settled diff to its caller's working files, without committing, stashing, resetting or changing the index. Conflicts leave the patch unapplied. The parent inspects evidence, integrates autonomously, resolves conflicts deliberately, and validates the combined result. Existing deployment/secret boundaries still apply.

A reusable writer keeps its private workspace; it does not automatically synchronize later caller edits. Start a fresh agent for a fresh baseline, or explicitly reconcile changes. Resuming interrupted work retains its original baseline so earlier unfinished edits stay in the returned diff. `isolated: false` explicitly opts into shared-checkout editing; shared edits cannot be rolled back by stopping an agent.

## Inspect and clean up

`/agents` is the single interactive entry point. It opens a centered, bordered overlay with a title, tab strip, content viewport and pinned keyboard footer. Tab/Shift-Tab cycles through Active, History and Settings. Active contains queued, starting, running and settling agents; History contains this session's inactive agents, including completed, failed, stopped and parked work. Both work tabs use one split view: the agent list on the left and the selected agent's stream on the right, with a joined border between them. Narrow terminals stack the two panes. Settings uses stock Pi's searchable settings list, with aligned labels/values and descriptions; model pickers search across model IDs and providers. Each agent type opens its own submenu for model, thinking, limits and role configuration. The list viewport is sized from the terminal height, without a six-row cap. Settings submenus stay in one overlay: Escape returns to the parent list without closing/reopening the card. The agent list shows names, state, model and usage. The stream uses stock Pi message/tool components with their default collapsed tool output, including streamed assistant text and provider-supplied thinking. An animated working/thinking indicator remains visible while the selected agent is active; its repaint timer stops when the inspector closes. No private reasoning is inferred when a provider supplies none; keys 1–5 select conversation, result, diff, prompt or status. Up/Down changes agent independently of PgUp/PgDn stream scrolling. Conversations follow the latest output; PgUp/PgDn scroll, End resumes following. Press `n` to delegate, `m` to send guidance, `a` to assign, `r` to resume, `x` to stop a branch, `i` to integrate or `f` to forget. Request guards are under the role's Limits submenu, not the main settings list; they count assistant requests, not currency, and `0` disables them. Role configuration is a JSON editor for tools, skill paths, explicitly trusted supporting extensions, prompt/promptFile, workspace policy and other role defaults. It does not edit Pi authentication/settings or provide an OS sandbox. The anchored Subagents widget sits above the editor and shows readable agent names, aligned short model/usage labels and separate activity lines with continuous tree gutters. It keeps one component mounted across progress updates, adapts to terminal width/height and shows an overflow count with `/agents` for the full list. Full handles and provider identities remain in the inspector and tool results. Tool equivalents work in RPC mode.

Agent tool entries show names and roles alongside full handles. Wait results show each agent's state; Ctrl+O expands the original result. Names in saved results remain readable after the agent is gone. Automatic messages also use a compact preview; Ctrl+O expands the original message, including retained artifact paths. The widget's name column grows with terminal width instead of stopping at 28 columns.

The NixOS/Darwin modules link each enabled extension into stock Pi's `~/.pi/agent/extensions` discovery directory, as well as the managed resource directory. Fresh Pi sessions load them unless resource exclusions or `--no-extensions` disable discovery. Explicit paths to the same pi-kit extension do not register a second supervisor, and workers never start one. A custom `PI_CODING_AGENT_DIR` needs links or explicit paths in that profile.

Full artifacts live under `~/.local/state/pi-kit/agents/<parent-session>/`, or `PI_AGENTS_STATE_DIR`. They include tasks, selected context, prompts, Pi sessions, reports, patches and bounded diagnostics. They may contain sensitive model/tool output. Older assignment prose remains in sidecar files rather than duplicated in live metadata. There is no automatic deletion. `agent_forget` deletes a settled leaf and its workspace/artifacts; forget descendants first. Do not forget a workspace while durable jobs still use it. Keep Nix generations used by preserved extension/skill paths until that state is no longer needed.

Live observers can subscribe to `agents.progress` and `agents.assignment.completed` with `pi-events`, using the parent Pi session ID. Results and commands remain authoritative in the agents extension and artifacts. These observer topics do not use pi-events' automatic `agent.result` routing; do not add a second completion follow-up subscription unless you deliberately want duplicate model notifications.

## Validation

```sh
nix develop -c bun test src/agents/extension
nix develop -c python3 -m unittest discover -s src/agents -p test_guard.py
nix develop -c python3 src/agents/tests/integration.py
nix develop -c python3 src/agents/tests/ui.py
nix develop -c python3 src/agents/tests/completions.py
```

The integration fixture uses real stock Pi with an offline scripted provider and a private profile. It verifies orchestration, not authenticated model quality. It never loads real credentials or modifies an active profile. Linux runtime tests and Darwin output evaluation are separate evidence; Darwin needs native testing.
