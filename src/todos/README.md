# Pi todos

Independent stock-Pi extension for a session-branch task plan. Load `extension/index.ts`, install `pi-kit-todos`, or import the NixOS/Darwin `todos` module. It does not require agents, jobs or events.

The `todo` tool supports phases and `init`, `append`, `start`, `done`, `block`, `unblock`, `drop`, `rm` and `view`. Address a task by its exact content; duplicate task text is refused. `init` replaces the plan explicitly. `block` accepts a reason. Multiple tasks may be in progress for parallel work. Nothing auto-starts or auto-completes; the parent verifies agent/job results before marking work done.

`/todos` opens the shared bordered list. Up/Down selects; `s` starts, `d` completes, `u` unblocks, `-` abandons. The model can add tasks or record blockers through the tool. A compact tree above the editor shows active and open work; when every task is completed or abandoned, its summary stays for five seconds and then the widget hides. The plan remains available in `/todos`. Pending or blocked tasks keep the widget visible. Reopening a task shows the widget again; loading an already-closed plan does not show it again. Tool results are compact by default and expandable.

Changes are stored in custom session entries and reconstructed only from the active branch on session load or tree navigation. No repository task file or separate database is written. A view does not persist a change. Each mutation validates the complete next state before committing; failed operations leave the plan unchanged. Limits: 32 phases, 200 tasks, 1000 characters per single-line field. UI edits are reflected in the next model turn's current-plan guidance, even when skills are disabled.

This follows OMP's phase/status vocabulary and anchored tree presentation, not its runtime. Unlike OMP's automatic next-task selection, state transitions here are explicit. Todos do not schedule execution, wake models or imply approval to act.
