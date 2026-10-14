# Ask

Optional structured questions for stock Pi. Discovery name: `kit-ask`; model tool: `ask`.

Enable `pi-kit.ask.enable = true`, or load the standalone extension. No service,
credentials, model calls, skills, or other pi-kit components are required.

The model supplies 1–8 questions, each with a unique ID and up to 12 options.
Options have stable IDs, labels, and optional descriptions. `multi` enables
multiple selections; `recommended` names an option ID without selecting it.
Omit options for a free-text question. Every question permits a custom answer.

In the terminal, use arrows to navigate, Space to toggle choices, Enter to
advance, and left/right or Tab to revisit questions. The final review requires
explicit submission. Text answers use Enter to save and Shift-Enter for a newline.
Page Up/Down scroll long forms. Escape leaves the text editor or cancels the form.

Results retain the questions and submitted answers in the transcript. Cancellation
returns no answers, including partially filled drafts. There is no timeout and
no automatic acceptance of a recommended option. A cancelled/unavailable form
requests that the current tool batch terminate; goal mode also pauses pursuit.
It does not undo other tools or provide a security/permission boundary.

RPC uses standard select/input/confirm dialogs, without the custom tabbed UI.
Print/JSON modes and supervised workers return `unavailable`; workers should ask
their parent through `agent_send`. Session replacement, reload, and tool abort
cancel the old form; it cannot submit answers into the new session.

Use questions for material decisions, not routine progress checks. No separate
question database or automatic re-opening of interrupted forms is maintained.
