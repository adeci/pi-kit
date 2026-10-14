# Setup

Pi must be installed and authenticated separately. pi-kit does not change Pi
settings or provision credentials.

## NixOS and nix-darwin

With `pi-kit` in your flake inputs, import its module and enable the components
you want. All components default off.

```nix
imports = [ inputs.pi-kit.nixosModules.default ];

pi-kit = {
  agents.enable = true;
  events.enable = true;
  jobs = {
    enable = true;
    daemon.enable = true;
  };
};
```

On Darwin, use `inputs.pi-kit.darwinModules.default`. Native Darwin runtime
validation is pending.

The module installs selected tools and discovery links under `~/.agents/` and
`~/.pi/agent/extensions/`. Start a fresh Pi session after activation. Configure
agent models through `/agents` Settings before delegating work.

`jobs.daemon.enable` runs a separate Pueue daemon through systemd on NixOS or
launchd on Darwin. It requires `jobs.enable`. Neither the CLI nor extension
starts a daemon implicitly. See [Jobs](../src/jobs/README.md#daemon-setup) for
callback verification, scheduling, and daemon setup without a module.

Disabled components' links are removed only when they point to known pi-kit
store resources. Unrelated links and regular files are preserved. User-managed
explicit extension and skill paths remain your responsibility.

Standalone modules such as `nixosModules.agents` and `darwinModules.agents`
enable their component on import. Use either those or the configurable default
module, not both.

## From a checkout

Packages are available for x86_64 Linux, aarch64 Linux, and aarch64 Darwin.

```sh
nix build .#pi-kit
export PATH="$PWD/result/bin:$PATH"
```

Load the core extensions and skills for one launch:

```sh
pi -e ./result/share/pi-kit/events \
  -e ./result/share/pi-kit/jobs \
  -e ./result/share/pi-kit/agents \
  --skill ./result/share/skills/kit-agents \
  --skill ./result/share/skills/kit-jobs
```

If these extensions are already discovered through module-installed links, use
`pi` without the extra arguments. Extension discovery names are `kit-agents`,
`kit-jobs`, and `kit-events`; commands remain `/agents`, `/jobs`, and `/events`.

Individual packages use `pi-kit-<component>`. The combined
`pi-kit` package also includes the optional components below. For manual persistent
setup, link selected extensions under `~/.pi/agent/extensions/` and skills under
`~/.agents/skills/`. A Pi setting of `"skills": ["!**"]` disables normal skill
discovery; explicit `--skill` arguments still work.

## Use and recovery

- [Agents](../src/agents/README.md): configure roles, delegate work, review reports and integrate changes.
- [Jobs](../src/jobs/README.md): run commands, inspect logs, watch completion and stop or forget jobs.
- [Events](../src/events/README.md): friendly session addresses, `pi-events send NAME`, and live topic subscriptions.

`/kit` reports loaded components, role models, skill exclusions, daemon response,
and callback verification. It is provided by Agents and does not submit work or
change watches.

In `/agents`, select an interrupted agent and press `r` to resume it. In `/jobs`,
inspect a job or attach a new watch. Watching never resubmits the command;
watching a finished job can queue a completion follow-up. These views cover the
current session. Nothing automatically resumes agents or replays missed events.

## Optional components

Enable these with `pi-kit.<component>.enable = true`. Each has a separate package
and module.

- [Status](../src/status/README.md): a compact footer with model, directory, Git changes and context usage.
- [Usage](../src/usage/README.md): OpenAI and Anthropic subscription allowances in one view.
- [Todos](../src/todos/README.md): a branch-local task list.
- [Handoff](../src/handoff/README.md): automatic context summaries and summarizer settings.
- [Goal](../src/goal/README.md): an objective, budget and continuation controls.
- [Director](../src/director/README.md): parent delegation policy; requires Agents.
- [Ask](../src/ask/README.md): structured questions with explicit submission.
