# Goal mode

`/goal` opens the shared settings menu. Save an objective, optionally set a token
budget, then select **Start**. The menu also pauses, resumes, replaces and drops
a goal. `/goal <objective>` starts directly without a token budget.

**Guided setup** opens an interview about success criteria, verification, scope,
attempt limits and stop conditions. `/guided-goal [rough idea]` starts the same
interview directly. The model asks questions before proposing a goal; creation
requires confirmation. Reopening a session does not re-arm an unfinished
interview: use `/guided-goal` again to continue setup.

The status line shows the goal state and parent-token usage. The menu also shows
active elapsed time. The status line indicates when continuation is waiting for workers, input or a settings
menu. Settings apply to the current goal. Each session branch owns its goal;
there is no global objective or background goal worker.

## Pursuit and stopping

Goal mode keeps the complete objective in model context. When the parent finishes
an ordinary run without declaring completion, it requests another turn through
stock Pi's `agent_before_settle` boundary. It does not create a polling loop,
second process or timer-based auto-submit controller.

Continuation is suppressed while input or a settings dialog is pending, another
continuation is queued, or pi-kit agents are active. Existing agent result
delivery wakes the parent after workers settle. A blocked-only todo list pauses
the goal. Errors at final settlement and user interruption also pause it.
**Escape stops the parent run.** Reopening or reloading a session restores an
active goal as paused; resumption requires an explicit action.

Pausing or dropping a goal does **not** stop workers or durable jobs. Review them
in `/agents` and `/jobs`; stop them explicitly when needed.

The `goal` tool supports `get`, `complete`, `pause`, `create`, `resume` and `drop`.
Creation is restricted to user-requested guided setup. Model-requested creation,
resume and drop require confirmation. Completion requires evidence text, but it
remains a **model declaration, not independent verification**. Inspect the
reported evidence before accepting the result. Goal mode does not weaken tool
permissions, project boundaries or approval requirements.

## Budget scope

Accounting follows OMP: new input tokens, output tokens and cache writes count;
cache reads do not. The counter includes usage recorded in the parent's session,
including handoff/compaction usage. Separate agent sessions are **not included**.
Worker usage and limits remain in `/agents`.

The token budget is not a currency cap or a global concurrency limit. Missing
provider usage cannot be metered. An
in-flight model response or tool batch can overshoot it. At the limit, the goal
becomes `budget-limited`, automatic continuation stops, and new substantive tool
calls are blocked. Increase the budget before resuming. Budget exhaustion never
means completion. Guided interview attempt limits are instructions in the
objective, not a separate machine-enforced turn counter.

## OMP relationship

The state machine, accounting and prompts are adapted closely from
[OMP 18.4.10](https://github.com/can1357/oh-my-pi), principally
`src/goals/runtime.ts` and `src/prompts/goals/` in its coding-agent package.
[OMP-LICENSE](OMP-LICENSE) retains the upstream MIT notice.

Stock Pi supplies persistence, tool execution and continuation. Differences:

- The shared `/goal` menu replaces OMP's built-in mode UI.
- A native settlement continuation replaces OMP's guarded 800 ms auto-submit.
- Creation/resume/drop through the model require confirmation.
- Completion requires evidence text; exhausted budgets cannot be bypassed by resume.
- Goal and director modes can operate independently or together.
- There is no hard spending cap or independent completion verifier.

## Installation and validation

```nix
pi-kit.goal.enable = true;
```

The NixOS/Darwin suite switch defaults off. The standalone module export is `goal`;
the package is `pi-kit-goal`. Agents, todos and director are
optional. No credentials or Pi settings files are changed.

Unit tests cover the adapted state machine. Offline stock-Pi tests exercise
settings, guided approval, continuation, budget exhaustion, Escape, menu pause,
paused restoration, worker results arriving after pause, director composition and
handoff accounting. Their worker tools are explicit stubs;
the agents package has separate worker-runtime tests. Native Darwin runtime and
real-model completion quality need separate validation.
