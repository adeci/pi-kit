import { randomUUID } from "node:crypto";
import {
  convertToLlm,
  findCutPoint,
  type ExtensionContext,
  type ProjectedSessionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Settings } from "./settings";

const instructions = `Write a continuity handoff for the next turn of this session, not a response to the historical conversation. Do not execute tasks or call tools.
The handoff is a lossy record, not proof that work is complete. Preserve the full objective, user constraints, decisions and their reasons, unfinished work, observed failures, exact paths and commands, validation evidence and its limits, active job/agent handles, and next steps. Distinguish verified facts from assumptions. Do not invent missing details. Do not copy credentials or secret values; preserve only their names and locations. Preserve unresolved requests; do not redefine success as an easier subset.
Use these exact headings:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked / Pending
## Key Decisions
## Critical Context
## Next Steps
Return only the handoff document. Do not count writing this document as task progress. Recent messages remain available after the handoff; earlier details may not. Include references to files and saved evidence needed to recover detail, and note important information that could not be preserved.`;
const headings = [
  "Goal",
  "Constraints & Preferences",
  "Progress",
  "Key Decisions",
  "Critical Context",
  "Next Steps",
];

/** Run Pi's public cut selector over the visible projection, not obsolete raw history.
 * Synthetic message entries are only inputs to the selector; never persisted.
 * Their IDs point back to real source entries, including edited messages.
 */
export function retainedBoundary(
  projected: ProjectedSessionEntry[],
  keepRecentTokens: number,
): string | undefined {
  const entries: SessionEntry[] = projected.flatMap((entry) =>
    entry.messages
      .filter((message) => message.role !== "compactionSummary")
      .map((message) => ({
        ...entry.sourceEntry,
        type: "message" as const,
        message,
      })),
  );
  const cut = findCutPoint(
    entries,
    0,
    entries.length,
    keepRecentTokens,
  ).firstKeptEntryIndex;
  // Nothing older can be replaced; don't pay for a non-reducing handoff.
  return cut > 0 ? entries[cut]?.id : undefined;
}

export function selectedModel(ctx: ExtensionContext, settings: Settings) {
  const model = settings.model
    ? ctx.modelRegistry.find(settings.model.provider, settings.model.id)
    : ctx.model;
  if (!model)
    throw new Error(
      "The configured handoff model is unavailable. Choose a model in /handoff.",
    );
  if (
    !ctx.modelRegistry
      .getAvailable()
      .some(
        (available) =>
          available.provider === model.provider && available.id === model.id,
      )
  )
    throw new Error(
      "The handoff model is not authenticated. Check /login or choose a model in /handoff.",
    );
  return model;
}

export async function summarize(
  ctx: ExtensionContext,
  messages: Parameters<typeof convertToLlm>[0],
  settings: Settings,
  signal: AbortSignal,
) {
  const model = selectedModel(ctx, settings);
  const response = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: instructions,
      messages: [
        ...convertToLlm(messages),
        { role: "user", content: instructions, timestamp: Date.now() },
      ],
    },
    {
      signal,
      maxTokens: Math.min(8192, model.maxTokens),
      cacheRetention: "none",
      sessionId: randomUUID(),
    },
  );
  if (signal.aborted) throw new Error("Handoff cancelled.");
  const summary = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const sections = new Map(
    summary
      .split(/^## /m)
      .slice(1)
      .map((section) => {
        const [title, ...body] = section.split("\n");
        return [
          title.trim(),
          body
            .join("\n")
            .replace(/^#+.*$/gm, "")
            .trim(),
        ];
      }),
  );
  if (
    response.stopReason !== "stop" ||
    !headings.every((heading) => sections.get(heading))
  )
    throw new Error("Incomplete handoff document.");
  return {
    summary,
    usage: response.usage,
    details: {
      piKitHandoff: 1,
      model: { provider: model.provider, id: model.id },
    },
  };
}
