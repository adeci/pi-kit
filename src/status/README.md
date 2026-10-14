# Status

A single-row, theme-aware footer and prompt-border styling for stock Pi 1.1.0,
adapted from OMP's plain
compact layout. Shows a stationary lambda, the
model's display name and thinking glyph, directory, Git branch/change counts,
context percentage/window, and recorded cost when nonzero. Cost uses the theme's
success color and survives before secondary segments when space is tight. Session
titles and extension statuses occupy spare space on the right.

Pi owns the Working, retry and compaction indicators in their normal location.
The normal Working row shares the border gradient, including its native spinner.
Retry, compaction and branch-summary notices retain Pi's styling. No spinner or
status lifecycle is replaced.
The footer's `λ` stays stationary: muted when idle, accent-colored while working.
It has no spinner or elapsed-time display. A subtle OMP-style highlight sweeps
across the model name while working; it stops when the run settles. One column
of padding separates footer content from each terminal edge. Disabling or
unloading restores Pi's editor.

Prompt borders stay in the theme's accent color rather than changing with the
thinking level. While working, a simple two-color gradient drifts across the thin
`─` strokes on a six-second cycle. It uses the theme's keyword and type colors
(violet and cyan in Tokyo Night), with a short fade-in. No crests, thickness
changes, white highlights or additional wave layers.
The top and bottom share the same clock. A thin subclass of Pi's editor
changes border rendering only; input, shortcuts, completion and cursor behavior
remain inherited. The shell-mode warning color is preserved.
No personal theme files are modified.

When Events is enabled, its friendly session address sits inside the top border
at the right. The gradient passes through its stationary letters; the name
is not repeated in the footer. Native status and overflow labels take priority:
if there are not enough trailing border strokes for the full name, it is omitted
rather than covering them or showing a partial address. `/events` always shows it.

Enable `pi-kit.status.enable = true`. Package: `pi-kit-status`; discovery:
`kit-status`. No other pi-kit component is required.

`/status` selects `on`, `off`, `icons`, or `ascii`. Changes last until reload or
exit. Icons use ordinary Unicode, not Nerd Fonts. Colors follow Pi's active
theme. The footer shortens the path and model before dropping secondary
segments; it never wraps. `/status off` restores Pi's footer.

Git counts use OMP's notation: `*` unstaged, `+` staged, `?` untracked. A bounded,
read-only Git status runs at installation, branch changes and turn boundaries,
not on every animation frame. Unavailable counts are omitted. The directory
shrinks first; on narrow terminals, activity and price take priority.

Context usage is Pi's current estimate; unknown usage shows `?`. Cost is the
active branch's recorded price estimate, including tool and compaction usage,
not a subscription bill. Separate child sessions are not included. No provider
requests or credential access. See [NOTICE](NOTICE) for OMP attribution.
