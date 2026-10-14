---
name: kit-agents
description: Delegate work to parent-owned Pi agents, inspect results, steer reusable agents, and integrate isolated changes.
---

# Pi agents

Use named agent roles for independent investigation, implementation, mechanical changes and review. Supply a self-contained assignment and only the context needed for it. Never copy the parent's full conversation.

`agent_roles` shows model routing, capabilities and limits. Model roles require explicit configuration; an assignment may override the model with an exact available identity. There is no silent fallback. Roles define maximum tools and skills; assignments may narrow them.

## Delegate and supervise

- `agent_spawn`: start one asynchronous assignment. Task-scoped is the default; request `lifetime: "reusable"` when continuity matters.
- `agent_list` and `agent_status`: inspect the accessible tree, actual model, activity, usage, results, transcript, prompt and diff.
- `agent_wait`: wait on a fixed set of direct children with a finite timeout. Cancellation and timeout stop only the wait.
- `agent_send`: steer a running child, send a question to your parent, or start a new assignment on an idle reusable child. Siblings communicate through their parent.
- `agent_assign`: give an idle/parked reusable agent another task while retaining its own conversation and workspace.
- `agent_resume`: explicitly continue interrupted work. Reopening Pi never starts it automatically.
- `agent_stop`: stop an agent and its branch by default. Partial artifacts remain.

Unread completions notify the parent after result persistence. In the main session, reading the same completed report with `agent_status` suppresses its pending notification; waits and running-status checks do not. Pending unread reports share one continuation when Pi would settle. Progress does not wake the model. Receipt acknowledgment does not prove completion. After an ambiguous startup/message acknowledgment, inspect state before retrying; do not duplicate work blindly.

Nested agents use their own per-session concurrency limit. The default is 32 per session and depth two. This is not a global process or spending limit. Request budgets apply per assignment, including reused-agent assignments: normally 200, scout/sonic 100. At the budget, wrap up; at 1.5 times the budget, stop implementation and submit partial findings. Five additional assistant requests are allowed for reporting before abort. The default wall-clock limit is unlimited. A new assignment gets a new budget; these limits do not cap total autonomous spending.

All model workers are owned by the parent Pi process. Parent shutdown stops execution and preserves resumable state. Reusable idle agents park after seven minutes by default. No agent runs through Pueue or survives Pi exit as an executing worker. Commands deliberately submitted to `pi-jobs` have their separate durable-job semantics.

## Writer workspaces and results

Writers use isolated Git worktrees by default. Their baseline includes the caller's working files, staged and unstaged changes, and non-ignored untracked files. Ignored files are excluded; tracked files remain included even if an ignore rule matches them. Snapshot failure or size overflow refuses the launch rather than omitting files. A shared-checkout override is explicit.

Use `agent_yield` to submit outcome, summary, artifacts, actual validation and unresolved issues. Delegates must settle first. Crashes, budget stops, cancellation and missing reports retain partial results; process exit is never treated as proof of success.

The parent autonomously reviews results, runs appropriate validation and calls `agent_integrate` for accepted isolated diffs. Integration changes working files without committing or changing the index. Conflicts fail without partial application; inspect and resolve them deliberately. The returned patch excludes pre-existing caller changes. Resuming interrupted work retains its original diff baseline.

`/agents` opens Active and History tabs with a bordered agent-list/live-stream view, plus Settings. Up/Down selects an agent; PgUp/PgDn scrolls its stream; End follows output again. Narrow terminals stack the panes. Tab/Shift-Tab cycles between Active, History and Settings, where the user can select exact authenticated models and role thinking/budgets. Delegate with `n`; keys 1–5 switch the stream to conversation/result/diff/prompt/status using stock Pi components. `agent_forget` explicitly deletes a settled leaf agent's conversation, artifacts and isolated workspace. Forget descendants first. Cleanup is never automatic.

## Boundaries

Role controls and worktrees are not OS sandboxes. Bash and trusted extensions can bypass filesystem intentions or launch independent processes. Do not give untrusted agents or extensions credentials or permissions they must not possess. This is same-user cooperation, not hostile-code containment.

Agent communication uses a private session-owned control socket and Pi RPC. `pi-events` is optional live observation; it is not a mailbox, task controller or source of authoritative results. There is no automatic notification replay, automatic recovery assignment, or automatic model fallback. The parent decides recovery within the configured policies. Deployment and other protected actions keep their existing boundaries.
