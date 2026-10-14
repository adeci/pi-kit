# pi-kit

Extensions and command-line tools for [Pi](https://github.com/earendil-works/pi).
Delegate work to child agents, run long commands through Pueue, and receive
completion notifications in your conversation. Pi itself stays unmodified.

![Pi delegates to Agents and Jobs. Local scripts and service hooks publish Events to named Pi sessions or fan out by topic to multiple live Pi sessions and terminal subscribers. Publishers connect directly to subscriber sockets, without a broker.](docs/overview.svg)

Local scripts and service hooks can publish topics too. One broadcast can reach
multiple live Pi sessions or terminal subscribers; named sends target one Pi.

Agents stop when Pi exits. Jobs can continue; live watches end with Pi and missed
notifications are not replayed. Reopen the original session to inspect or rewatch jobs.

Nix packages and NixOS/nix-darwin modules are included. Components are enabled
individually. Linux is tested; native Darwin validation is pending.

[Setup](docs/usage.md) · [MIT license](LICENSE)
