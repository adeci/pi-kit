# Director mode

`/director` opens the shared settings menu. Enable the mode and select roles for
fast and strong workers. Defaults are `sonic` and `task`. **Agent model settings**
opens `/agents`; exact models, thinking levels, tools, isolation and request
limits remain in the existing role configuration.

The status line shows **Director ON** and the active-worker count. Detailed
worker activity remains in the existing agent HUD and `/agents` inspector.
Changes take effect immediately, but toggling director mode requires an idle
parent. Role choices and the enabled state follow the current session branch.
Reopening does not restart workers. Disabling restores the parent's prior active
tool set and does not stop existing workers.

## Execution policy

The parent may read files, manage goals/todos, direct agents and inspect results.
It must delegate edits, commands, searches, builds and tests. The mode filters
model-visible tools and blocks disallowed `tool_call` events, including nested
calls. This is a workflow policy, **not an OS sandbox or a defense against a
malicious extension**. It does not restrict explicit human shell commands.

Workers use existing `agent_*` tools and must be spawned with an explicit role
and `lifetime: reusable`. Reuse the same worker for follow-up assignments.
Workers receive self-contained briefs, not implicit parent history. Existing
agent ownership, permissions, nesting, parking and shutdown rules remain intact.

The sole parent write exception is `agent_integrate`, which applies a reviewed,
settled worker diff through the existing conflict-safe integration mechanism.
Isolation defaults remain unchanged. The parent must inspect the diff and
verification evidence before integration; a worker's completion report is not
proof. The mode does not automatically commit, integrate, discard work or kill
workers.

## OMP relationship

The director instructions closely adapt OMP 18.4.10's
`src/prompts/system/vibe-mode-active.md`. [OMP-LICENSE](OMP-LICENSE) retains its
MIT notice. OMP calls this mode `/vibe`; this component uses `/director` to name
its function.

OMP drives persistent `fast` and `good` worker CLIs with `vibe_*` tools. Pi-kit
instead uses its existing parent-owned agents, configurable roles and isolated
workspaces. No second worker runtime is added. The reviewed-integration exception
is specific to pi-kit. Unlike OMP, director and goal modes can be enabled together:
goal controls pursuit and stopping; director controls who executes.

## Installation and validation

```nix
pi-kit.agents.enable = true;
pi-kit.director.enable = true;
# Optional autonomous objective pursuit:
pi-kit.goal.enable = true;
```

Suite switches default off, and the director policy starts off until enabled in
its menu. Standalone installations must load both the agents and director
components. The module export is `director`; the package
is `pi-kit-director`. No credentials or Pi settings files are changed.

Unit tests cover the tool policy. Offline stock-Pi integration checks menus,
tool restriction/restoration, persistent-workstream tool calls and composition
with goal mode. These policy tests use stub worker tools; actual agents have
separate runtime tests. Native Darwin runtime still needs separate validation.
