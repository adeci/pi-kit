# Shared Pi UI

Presentation primitives for independently loadable pi-kit extensions:

- `menu.ts`: bordered overlays, joined pane dividers and searchable selectors.
- `layout.ts`: tree continuation gutters and responsive split-pane geometry.
- `style.ts`: theme adapters, safe single-line labels and working-spinner frames.

Use stock Pi components for messages, tools and input. Measure terminal columns with Pi's width helpers. This library owns no session state, task execution, event subscriptions or background workers. Consumers own and dispose repaint timers.

Source imports use `../../ui/...` from each extension directory. Each independent Nix package ships the same library under `share/pi-kit/ui`; installing one component does not require another. The combined package merges identical shared files. Keep this library small and extract only genuinely shared presentation behavior.
