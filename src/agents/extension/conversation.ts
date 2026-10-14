import {
  AssistantMessageComponent,
  UserMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { clean } from "./types";

/** Stock Pi message components, with no child extension renderers or inline images. */
export function nativeConversation(
  text: string,
  streaming: string,
  tui: TUI,
  cwd: string,
  thinking = "",
) {
  const components: Array<{ render(width: number): string[] }> = [];
  const calls = new Map<string, ToolExecutionComponent>();
  for (const line of text.split("\n")) {
    let record: any;
    try {
      record = JSON.parse(line, (_key, value) =>
        typeof value === "string" ? clean(value) : value,
      );
    } catch {
      continue;
    }
    if (record.type !== "message" || !record.message) continue;
    const message = record.message;
    if (message.role === "user") {
      const body =
        typeof message.content === "string"
          ? message.content
          : message.content
              ?.filter((block: any) => block.type === "text")
              .map((block: any) => block.text)
              .join("\n");
      components.push(new UserMessageComponent(body ?? ""));
    } else if (message.role === "assistant") {
      components.push(new AssistantMessageComponent(message));
      for (const block of message.content ?? [])
        if (block.type === "toolCall") {
          const component = new ToolExecutionComponent(
            block.name,
            block.id,
            block.arguments,
            { showImages: false },
            undefined,
            tui,
            cwd,
          );
          component.setArgsComplete();
          calls.set(block.id, component);
          components.push(component);
        }
    } else if (message.role === "toolResult") {
      const component = calls.get(message.toolCallId);
      if (component) component.updateResult(message);
      else
        components.push(
          new UserMessageComponent(
            `Tool · ${message.toolName}\n${
              message.content
                ?.filter((block: any) => block.type === "text")
                .map((block: any) => block.text)
                .join("\n") ?? ""
            }`,
          ),
        );
    }
  }
  if (streaming || thinking) {
    const component = new AssistantMessageComponent();
    component.updateContent(
      {
        role: "assistant",
        content: [
          ...(thinking
            ? [{ type: "thinking", thinking: clean(thinking) }]
            : []),
          ...(streaming ? [{ type: "text", text: clean(streaming) }] : []),
        ],
        stopReason: "stop",
      } as any,
      true,
    );
    components.push(component);
  }
  return components;
}
