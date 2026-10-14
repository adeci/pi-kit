// Offline scripted provider for orchestration tests. Never load into a real profile.
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";

const childConfigurationPath = () => {
  const index = process.argv.indexOf("--pi-agents-child");
  return index < 0 ? undefined : process.argv[index + 1];
};
const string = (message: any) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n");
export default function fixture(pi: any) {
  let cwd = process.cwd();
  pi.registerProvider("pi-agents-fixture", {
    api: "pi-agents-fixture",
    baseUrl: "https://fixture.invalid",
    apiKey: "offline-fixture",
    models: ["scripted", "scripted-alt"].map((id) => ({
      id,
      name: "Offline orchestration fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    })),
    streamSimple: (model: any, context: any) => {
      const stream = new AssistantMessageEventStream();
      const messages = context.messages;
      let name: string | undefined,
        args: any,
        response = "Fixture acknowledgment";
      const childPath = childConfigurationPath();
      const child =
        typeof childPath === "string"
          ? JSON.parse(readFileSync(childPath, "utf8"))
          : undefined;
      if (child && process.env.PI_AGENTS_TEST_TRACE)
        appendFileSync(
          process.env.PI_AGENTS_TEST_TRACE,
          JSON.stringify({
            agent: child.id,
            assignment: child.assignment,
            cwd,
            messages,
            systemPrompt: context.systemPrompt,
          }) + "\n",
        );
      const last = messages.at(-1);
      if (
        !child &&
        last?.role === "user" &&
        string(last).startsWith("CONTROL ")
      ) {
        const control = JSON.parse(string(last).split("\n")[0].slice(8));
        name =
          control.operation === "todo" ? "todo" : `agent_${control.operation}`;
        args = control.args;
      } else if (child) {
        let start = messages.length - 1;
        while (
          start >= 0 &&
          !(
            messages[start].role === "user" &&
            string(messages[start]).startsWith("Assignment ")
          )
        )
          start--;
        const assignment = start >= 0 ? string(messages[start]) : "";
        const history = messages.slice(Math.max(0, start));
        const results = history.filter((m: any) => m.role === "toolResult");
        const completed = (tool: string) =>
          results.find((m: any) => m.toolName === tool);
        const finish = (summary: string, outcome = "completed") => {
          name = "agent_yield";
          args = {
            outcome,
            summary,
            artifacts: [],
            validation: ["Offline scripted orchestration fixture"],
            unresolved: [],
          };
        };
        if (assignment.includes("SCENARIO hang")) {
          name = "bash";
          args = {
            command: `printf '%s\\n' "$$" > ${JSON.stringify(join(cwd, "shell.pid"))}; sleep 60; true`,
          };
        } else if (assignment.includes("SCENARIO loop")) {
          if (
            history.some((m: any) => string(m).includes("Request budget stop:"))
          )
            finish("Partial findings at request budget", "blocked");
          else {
            name = "read";
            args = { path: "tracked.txt" };
          }
        } else if (assignment.includes("SCENARIO nested")) {
          if (!completed("agent_spawn")) {
            name = "agent_spawn";
            args = {
              role: "reviewer",
              task: assignment.includes("depth-test")
                ? "SCENARIO nested depth-test"
                : "SCENARIO delay",
              lifetime: "task",
            };
          } else if (completed("agent_spawn").isError)
            finish("Depth limit prevented further delegation", "blocked");
          else if (!completed("agent_wait")) {
            const spawned = JSON.parse(string(completed("agent_spawn")));
            name = "agent_wait";
            args = { ids: [spawned.id], timeoutSeconds: 30 };
          } else finish("Nested delegate settled and result inspected");
        } else if (assignment.includes("SCENARIO write")) {
          if (!completed("write")) {
            name = "write";
            args = { path: "tracked.txt", content: "agent change\n" };
          } else finish("Writer produced isolated change");
        } else if (assignment.includes("SCENARIO delay")) {
          if (!completed("bash")) {
            name = "bash";
            args = { command: "sleep 1" };
          } else finish("Delayed assignment complete");
        } else finish("Explicit fixture report");
      }
      const message: any = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: [],
        stopReason: name ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(async () => {
        stream.push({ type: "start", partial: message });
        if (child && process.env.PI_AGENTS_TEST_UI_LOG) {
          const thinking =
            "Inspecting the live agent stream before running a tool.";
          message.content.push({ type: "thinking", thinking });
          stream.push({
            type: "thinking_start",
            contentIndex: 0,
            partial: message,
          });
          stream.push({
            type: "thinking_delta",
            contentIndex: 0,
            delta: thinking,
            partial: message,
          });
          await new Promise((resolve) => setTimeout(resolve, 800));
          stream.push({
            type: "thinking_end",
            contentIndex: 0,
            content: thinking,
            partial: message,
          });
        }
        if (name) {
          const toolCall = {
            type: "toolCall",
            id: `fixture-${Date.now()}-${Math.random()}`,
            name,
            arguments: args,
          };
          message.content.push(toolCall);
          stream.push({
            type: "toolcall_start",
            contentIndex: message.content.length - 1,
            partial: message,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: message.content.length - 1,
            toolCall,
            partial: message,
          });
        } else {
          message.content.push({ type: "text", text: response });
          stream.push({
            type: "text_start",
            contentIndex: 0,
            partial: message,
          });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: response,
            partial: message,
          });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: response,
            partial: message,
          });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("session_start", (_event: any, ctx: any) => {
    cwd = ctx.cwd;
    if (!childConfigurationPath() && process.env.PI_AGENTS_TEST_UI_LOG) {
      const path = process.env.PI_AGENTS_TEST_UI_LOG;
      const custom = ctx.ui.custom.bind(ctx.ui);
      ctx.ui.custom = (...args: any[]) => {
        appendFileSync(path, "open\n");
        return custom(...args).finally(() => appendFileSync(path, "close\n"));
      };
    }
    if (
      !childConfigurationPath() &&
      process.env.PI_AGENTS_TEST_WIDGET_LOG &&
      !ctx.ui.piAgentsWidgetInstrumented
    ) {
      ctx.ui.piAgentsWidgetInstrumented = true;
      const path = process.env.PI_AGENTS_TEST_WIDGET_LOG;
      const setWidget = ctx.ui.setWidget.bind(ctx.ui);
      ctx.ui.setWidget = (key: string, content: any, options: any) => {
        if (key === "pi-todos")
          appendFileSync(
            path + ".todos",
            JSON.stringify({ event: content ? "mount" : "clear" }) + "\n",
          );
        if (key !== "pi-agents" || typeof content !== "function")
          return setWidget(key, content, options);
        appendFileSync(
          path,
          JSON.stringify({ event: "mount", placement: options?.placement }) +
            "\n",
        );
        return setWidget(
          key,
          (...args: any[]) => {
            const component = content(...args),
              render = component.render.bind(component);
            component.render = (width: number) => {
              const lines = render(width);
              appendFileSync(
                path,
                JSON.stringify({
                  event: "render",
                  width,
                  lines,
                  widths: lines.map(visibleWidth),
                }) + "\n",
              );
              return lines;
            };
            return component;
          },
          options,
        );
      };
    }
    const childPath = childConfigurationPath();
    if (childPath) {
      writeFileSync(
        join(
          JSON.parse(readFileSync(childPath, "utf8")).directory,
          "worker.pid",
        ),
        String(process.pid),
        { mode: 0o600 },
      );
      ctx.ui.setStatus("fixture", "Offline fixture loaded");
      ctx.ui.notify("Offline fixture child ready", "info");
    }
    if (!childConfigurationPath() && process.env.PI_AGENTS_TEST_READY)
      writeFileSync(
        process.env.PI_AGENTS_TEST_READY,
        JSON.stringify({
          session: ctx.sessionManager.getSessionFile(),
          id: ctx.sessionManager.getSessionId(),
        }),
        { mode: 0o600 },
      );
  });
}
