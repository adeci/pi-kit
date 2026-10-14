import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

type Message = Parameters<ExtensionAPI["sendMessage"]>[0];
export interface Completion {
  message: Message;
  observed?: (entries: readonly unknown[]) => boolean;
  suppressed?: () => void;
}

// Keep ownership until the last actionable boundary, rather than putting an
// irrevocable follow-up in Pi's queue while tools can still read the result.
export function completionDelivery(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let allowSettlement = false;
  const pending = new Map<string, Completion>();
  const reset = () => {
    pending.clear();
    context = undefined;
    allowSettlement = false;
  };
  pi.on("session_shutdown", reset);
  pi.on("session_start", (_event, ctx) => {
    reset();
    context = ctx;
  });
  const take = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getBranch();
    const messages: Message[] = [];
    for (const [key, completion] of pending) {
      if (completion.observed?.(entries)) completion.suppressed?.();
      else messages.push(completion.message);
      pending.delete(key);
    }
    return messages;
  };
  pi.on("agent_before_settle", (event, ctx) => {
    allowSettlement = event.outcome === "completed" && !ctx.signal?.aborted;
    if (!allowSettlement) return;
    const messages = take(ctx);
    if (messages.length)
      return {
        entries: messages.map((message) => ({
          type: "custom_message",
          ...message,
        })) as SessionBoundaryDraft[],
        continue: true,
      };
  });
  // Cover arrivals between the final boundary and settlement. Pi defers these
  // prompts until its settlement callbacks have finished. Never restart on Escape.
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted || !allowSettlement) return;
    for (const message of take(ctx))
      pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
  });
  return {
    add(key: string, completion: Completion) {
      if (!context) return;
      pending.set(key, completion);
      if (context.isIdle()) {
        for (const message of take(context))
          pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
      }
    },
  };
}

export function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}
export function object(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}
export function toolMessages(entries: readonly unknown[], tool: string) {
  return entries.flatMap((entry) => {
    const item = object(entry);
    const message = object(item?.message);
    return item?.type === "message" &&
      message?.role === "toolResult" &&
      message.toolName === tool
      ? [message]
      : [];
  });
}
