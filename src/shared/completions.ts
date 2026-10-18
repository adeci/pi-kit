import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

type Message = Parameters<ExtensionAPI["sendMessage"]>[0];
export interface Completion {
  message: Message;
  /** Results and questions that need the model now. Job results are quiet:
   * they join the context without starting or extending a turn. */
  wake?: boolean;
  /** Called when the completion is withdrawn because its result was read. */
  withdrawn?: () => void;
}

/** In-process bus shared by every delivery: owners of a result (the jobs
 * extension, the supervisor) report reads structurally, by key. */
export const CONSUME = "pi-kit:completions:consume";
/** An explicit rewatch: the next completion for this key is wanted again. */
export const ARM = "pi-kit:completions:arm";
/** A quiet completion joined the session without a model turn. */
export const QUIET = "pi-kit:completions:quiet";

const TOMBSTONES = 1024;

// Hold completions until the next point where the model can read them, and
// withdraw any whose result was read in the meantime:
// - after a tool turn (turn_end with tool results), so it lands before the
//   final answer without an extra request;
// - quiet completions after a final answer join the context with no new turn;
// - wake completions pending at settlement continue the run once;
// - idle: quiet completions are appended, wake completions start a turn.
// Abort and errors never restart work; held completions are appended quietly.
export function completionDelivery(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let allowSettlement = false;
  const pending = new Map<string, Completion>();
  // Keys read before their completion arrived (the publisher can lag the read).
  const consumed = new Set<string>();
  const reset = () => {
    pending.clear();
    consumed.clear();
    context = undefined;
    allowSettlement = false;
  };
  const take = (wanted: (completion: Completion) => boolean = () => true) => {
    const taken: [string, Completion][] = [];
    for (const [key, completion] of pending)
      if (wanted(completion)) {
        pending.delete(key);
        taken.push([key, completion]);
      }
    return taken;
  };
  const announce = (taken: [string, Completion][]) => {
    for (const [key, completion] of taken)
      if (!completion.wake) pi.events.emit(QUIET, key);
  };
  // Pi replaces a boundary's accumulated entries with each handler's result,
  // so keep what earlier handlers (another delivery, say) already added.
  const boundary = (
    event: { entries?: SessionBoundaryDraft[] },
    taken: [string, Completion][],
  ) => {
    if (!taken.length) return;
    announce(taken);
    return {
      entries: [
        ...(event.entries ?? []),
        ...(taken.map(([, completion]) => ({
          type: "custom_message",
          ...completion.message,
        })) as SessionBoundaryDraft[]),
      ],
      // Only wake completions ask for a request. After a tool turn the loop
      // continues anyway, so this adds a turn only if the tools ended the run.
      continue: taken.some(([, completion]) => completion.wake) || undefined,
    };
  };
  // Outside a run: quiet completions are appended without a turn, before any
  // wake completion starts one.
  const send = (taken: [string, Completion][], wake: boolean) => {
    const ordered = [
      ...taken.filter(([, completion]) => !(wake && completion.wake)),
      ...taken.filter(([, completion]) => wake && completion.wake),
    ];
    for (const [key, completion] of ordered) {
      if (wake && completion.wake)
        pi.sendMessage(completion.message, {
          deliverAs: "followUp",
          triggerTurn: true,
        });
      else {
        pi.sendMessage(completion.message);
        pi.events.emit(QUIET, key);
      }
    }
  };
  const consume = (key: unknown) => {
    if (typeof key !== "string") return;
    consumed.delete(key);
    consumed.add(key);
    if (consumed.size > TOMBSTONES)
      consumed.delete(consumed.values().next().value!);
    const completion = pending.get(key);
    if (!completion) return;
    pending.delete(key);
    completion.withdrawn?.();
  };
  const arm = (key: unknown) => {
    if (typeof key === "string") consumed.delete(key);
  };
  const unconsume = pi.events.on(CONSUME, consume);
  const unarm = pi.events.on(ARM, arm);
  pi.on("session_shutdown", (event) => {
    reset();
    if (event?.reason === "quit" || event?.reason === "reload") {
      unconsume();
      unarm();
    }
  });
  pi.on("session_start", (_event, ctx) => {
    reset();
    context = ctx;
  });
  pi.on("turn_end", (event, ctx) => {
    if (event.outcome !== "completed" || ctx.signal?.aborted) return;
    // A tool turn is followed by another request: everything lands before the
    // final answer. After a final answer only quiet completions are appended;
    // wake completions wait for settlement, which continues the run once.
    const tools = event.toolResults.length > 0;
    return boundary(
      event,
      take((completion) => tools || !completion.wake),
    );
  });
  pi.on("agent_before_settle", (event, ctx) => {
    allowSettlement = event.outcome === "completed" && !ctx.signal?.aborted;
    if (allowSettlement) return boundary(event, take());
  });
  // Arrivals between the final boundary and settlement, and completions held
  // through an abort or error. Pi defers triggered prompts until settlement
  // callbacks finish. Never restart on Escape.
  pi.on("agent_settled", (event) => {
    send(take(), !event.aborted && allowSettlement);
  });
  return {
    add(key: string, completion: Completion) {
      if (!context || consumed.has(key)) {
        if (context) completion.withdrawn?.();
        return;
      }
      // A newer completion for the same key (an explicit rewatch) replaces
      // the held one; release the old one so its owner stops tracking it.
      pending.get(key)?.withdrawn?.();
      pending.set(key, completion);
      if (context.isIdle()) send(take(), true);
    },
    consume,
    arm,
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
