// Product behavior through the official durable scheduler, events and SQLite storage.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineTool,
  Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "@/shared/contracts/attachment";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import type { ApprovalService } from "./approvals";
import { type ChatRuntime, createChatRuntime } from "./runtime";
import { createSessionStore, type SessionStore } from "./session-store";
import { createSubagentExtension, createSubagentRunner } from "./subagent-runner";
import { createToolTestApi } from "./tools/tool-test-api";

const providerState = vi.hoisted(() => ({ current: undefined as FauxProviderHandle | undefined }));
const preprocessing = vi.hoisted(() => ({
  wait: undefined as Promise<void> | undefined,
  entered: false,
}));
vi.mock("./attachments", async (load) => {
  const actual = await load<typeof import("./attachments")>();
  return {
    ...actual,
    buildUserContent: async (sessionId: string, text: string, attachments?: ChatAttachment[]) => {
      preprocessing.entered = true;
      await preprocessing.wait;
      return actual.buildUserContent(sessionId, text, attachments);
    },
  };
});
vi.mock("./providers", () => ({
  buildProviders: () => {
    if (providerState.current === undefined) throw new Error("Missing test provider");
    const models = createModels();
    models.setProvider(providerState.current.provider);
    return { models, providers: new Map([["svc", providerState.current.provider]]) };
  },
  resolveModel: (_settings: unknown, ref?: { modelId: string } | null) =>
    providerState.current?.getModel(ref?.modelId ?? "test"),
}));
const pluginHost = vi.hoisted(() => ({
  dispatch: vi.fn(
    async (
      _name: string,
      _payload: unknown,
    ): Promise<{ block?: string; additionalContext?: string; failures: [] }> => ({ failures: [] }),
  ),
}));
vi.mock("@/main/plugins/process-host", async () => {
  const { defineExtension, hook, ToolTask, GenerationTask } = await import(
    "@earendil-works/pi-durable"
  );
  let pendingContext: string | undefined;
  const extension = defineExtension({
    name: "test-plugin",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          const result = await pluginHost.dispatch("beforeTool", call);
          return result.block ? { block: result.block } : undefined;
        },
        afterTool: async (call, result) => {
          const response = await pluginHost.dispatch("afterTool", { call, result });
          pendingContext = response.additionalContext;
        },
      }),
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => {
          const content = pendingContext;
          pendingContext = undefined;
          return content
            ? { messages: [...messages, { role: "user", content, timestamp: Date.now() }] }
            : undefined;
        },
      }),
    ],
  });
  return {
    pluginExtensions: () => [{ pluginId: "test-plugin", extension }],
    subscribePluginExtensions: () => () => {},
  };
});
vi.mock("@/main/plugins/contributions", () => ({
  ensurePluginWorkspace: async () => {},
  pluginContributionDirs: () => ({ skills: [], prompts: [], subagents: [] }),
}));
vi.mock("./resources", async (load) => ({
  ...(await load<Record<string, unknown>>()),
  loadSkills: async () => ({ skills: [], diagnostics: [] }),
  loadPromptTemplates: async () => ({ promptTemplates: [], diagnostics: [] }),
}));

let directory: string;
let store: SessionStore;
let runtime: ChatRuntime;
let sessionId: string;
let settings: Settings;
let faux: FauxProviderHandle;
let events: ChatEventEnvelope[];
let mcpTools: ToolRegistration[];
let mcpListeners: Set<() => void>;
let approvals: ApprovalService;

const toolResponse = (call: ReturnType<typeof fauxToolCall>) =>
  fauxAssistantMessage(call, { stopReason: "toolUse" });

function textOf(context: TranscriptContext): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
    );
}

beforeEach(async () => {
  preprocessing.wait = undefined;
  preprocessing.entered = false;
  directory = await mkdtemp(path.join(tmpdir(), "oint-native-runtime-"));
  vi.stubEnv("OINT_HOME", directory);
  store = createSessionStore(directory);
  sessionId = (await store.create({ cwd: directory })).id;
  faux = fauxProvider({
    provider: "svc",
    models: [
      { id: "test", contextWindow: 128_000, input: ["text", "image"] },
      { id: "second", contextWindow: 128_000, reasoning: true },
    ],
    tokensPerSecond: 100_000,
  });
  providerState.current = faux;
  settings = {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [
      {
        id: "svc",
        name: "test",
        baseUrl: "https://unused.invalid",
        apiKey: "",
        wireFormat: "openai-completions",
        models: [{ id: "test" }],
      },
    ],
    defaultModel: { serviceId: "svc", modelId: "test" },
    thinkingLevel: "off",
    permissionMode: "default",
    agentMode: "standard",
    disabledSkillNames: [],
    disabledSubagentNames: [],
    mcpServers: [],
    systemMcpServerEnabled: {},
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
  };
  events = [];
  mcpTools = [];
  mcpListeners = new Set();
  approvals = {
    attach: async () => () => {},
    taskDefinitions: [],
    request: vi.fn(async () => "allow_once" as const),
    respond: vi.fn(),
    pending: async () => [],
    cancelSession: vi.fn(),
    history: async () => [],
  };
  pluginHost.dispatch.mockReset();
  pluginHost.dispatch.mockResolvedValue({ failures: [] });
  runtime = createChatRuntime({
    getSettings: async () => settings,
    sessionStore: store,
    approvals,
    resolveWorkingDir: async () => directory,
    emit: (event) => {
      events.push(structuredClone(event));
    },
    mcp: {
      tools: () => mcpTools,
      subscribe: (listener) => {
        mcpListeners.add(listener);
        return () => {
          mcpListeners.delete(listener);
        };
      },
    },
  });
});

afterEach(async () => {
  await runtime?.dispose();
  await store?.close();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function seedPendingChild(modelId?: string) {
  const opened = await store.open(sessionId);
  if (!opened) throw new Error("Missing fixture session");
  const registry = createRegistry();
  const models = createModels();
  models.setProvider(faux.provider);
  const tasks = createSubagentExtension(async () => {});
  registry.install(tasks.extension);
  const harness = await opened.session.bindHarness(() =>
    Harness.open(opened.storage, { models, registry }, BACKGROUND_CONTEXT),
  );
  const root = await harness.conversation(opened.conversationId, BACKGROUND_CONTEXT);
  if (!root) throw new Error("Missing fixture root");
  await root.configure({ model: { provider: "svc", modelId: "test" } }, BACKGROUND_CONTEXT);
  const runner = createSubagentRunner({
    harness,
    conversation: () => root,
    familyId: sessionId,
    tasks,
    parent: async () => ({ sessionId, cwd: directory, parentModelId: "test" }),
  });
  const run = await runner.start(
    {
      toolCallId: "cold-child",
      description: "recover child",
      task: "recover-work",
      definition: {
        name: "reader",
        description: "reader",
        prompt: "Report findings",
        source: "temp",
        tools: ["read"],
        ...(modelId ? { model: { serviceId: "svc", modelId } } : {}),
      },
    },
    createToolTestApi({ conversationId: root.id, commit: root.commit.bind(root) }),
    BACKGROUND_CONTEXT,
  );
  await harness.close(BACKGROUND_CONTEXT);
  await opened.session.unbindHarness(harness);
  return run;
}

describe("native durable chat runtime", () => {
  it("persists messages, authoritative entry links and system instructions", async () => {
    let request: TranscriptContext | undefined;
    faux.setResponses([
      (context) => {
        request = context;
        return fauxAssistantMessage("native answer");
      },
    ]);
    await runtime.send(sessionId, "first question", [], "optimistic-user");
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
    const messages = (await store.loadMessages(sessionId)).messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const opened = await store.open(sessionId);
    const parentId = messages[1]?.parentId;
    if (opened == null || parentId === undefined || parentId === null)
      throw new Error("Missing native parent");
    expect(await opened.session.getEntry(parentId, BACKGROUND_CONTEXT)).toMatchObject({
      record: { kind: "pi.system" },
    });
    expect(request?.messages.some((message) => message.role === "system")).toBe(true);
    expect((await runtime.liveSnapshot(sessionId))?.state.admittedRequestIds).toContain(
      "optimistic-user",
    );
    expect(
      (await runtime.liveSnapshot(sessionId))?.state.messages.every((message) => message.entryId),
    ).toBe(true);
    expect(runtime.isRunning(sessionId)).toBe(false);
  });

  it("admits concurrent sends in order without aborting the first run", async () => {
    const requests: string[][] = [];
    faux.setResponses([
      (context) => {
        requests.push(textOf(context));
        return fauxAssistantMessage("one");
      },
      (context) => {
        requests.push(textOf(context));
        return fauxAssistantMessage("two");
      },
    ]);
    await Promise.all([runtime.send(sessionId, "first"), runtime.send(sessionId, "second")]);
    await expect
      .poll(
        async () =>
          (await store.loadMessages(sessionId)).messages.filter(
            (message) => message.role === "assistant",
          ).length,
      )
      .toBe(2);
    expect(requests[0]).toEqual(["first"]);
    expect(requests[1]).toEqual(["first", "second"]);
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
  });

  it("runs plugin then host permission hooks and preserves tool result details", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "tool value" }],
      details: { source: "native" },
    }));
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "test",
        parameters: Type.Object({}),
        execute,
      }),
    ];
    faux.setResponses([
      toolResponse(fauxToolCall("mcp__test__call", {}, { id: "tool-1" })),
      fauxAssistantMessage("done"),
    ]);
    await runtime.send(sessionId, "use tool");
    expect(execute).toHaveBeenCalledOnce();
    expect(approvals.request).toHaveBeenCalledOnce();
    expect(approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(pluginHost.dispatch.mock.calls.map(([name]) => name)).toEqual([
      "beforeTool",
      "afterTool",
    ]);
    const parts = (await store.loadMessages(sessionId)).messages.flatMap(
      (message) => message.parts,
    );
    expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
      result: "tool value",
      details: { source: "native" },
      status: "done",
    });
  });

  it("a plugin block never executes the tool or requests host approval", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
    }));
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "test",
        parameters: Type.Object({}),
        execute,
      }),
    ];
    pluginHost.dispatch.mockImplementation(async (name) =>
      name === "beforeTool" ? { block: "plugin denial", failures: [] } : { failures: [] },
    );
    faux.setResponses([
      toolResponse(fauxToolCall("mcp__test__call", {})),
      fauxAssistantMessage("blocked acknowledged"),
    ]);
    await runtime.send(sessionId, "use tool");
    expect(execute).not.toHaveBeenCalled();
    expect(approvals.request).not.toHaveBeenCalled();
    const parts = (await store.loadMessages(sessionId)).messages.flatMap(
      (message) => message.parts,
    );
    expect(parts.find((part) => part.type === "tool-call")).toMatchObject({ isError: true });
  });

  it("injects plugin context only into the next provider request", async () => {
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "test",
        parameters: Type.Object({}),
        execute: async () => ({ content: [] }),
      }),
    ];
    pluginHost.dispatch.mockImplementation(async (name) =>
      name === "afterTool"
        ? { additionalContext: "private follow-up", failures: [] }
        : { failures: [] },
    );
    let request: TranscriptContext | undefined;
    faux.setResponses([
      toolResponse(fauxToolCall("mcp__test__call", {})),
      (context) => {
        request = context;
        return fauxAssistantMessage("done");
      },
    ]);
    await runtime.send(sessionId, "use tool");
    if (request === undefined) throw new Error("Missing model request");
    expect(textOf(request)).toContain("private follow-up");
    expect(
      (await store.loadMessages(sessionId)).messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("withdraws queued input and propagates cancellation into a running tool", async () => {
    let entered = false;
    let aborted = false;
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "test",
        parameters: Type.Object({}),
        execute: async (_args, _api, context) => {
          entered = true;
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return { content: [] };
        },
      }),
    ];
    faux.setResponses([toolResponse(fauxToolCall("mcp__test__call", {}))]);
    const sending = runtime.send(sessionId, "hold tool");
    await expect.poll(() => entered).toBe(true);
    await runtime.queue(sessionId, "remove me", "followUp");
    await expect
      .poll(async () =>
        (await runtime.liveSnapshot(sessionId))?.state.queue.some((item) => /^\d+$/.test(item.id)),
      )
      .toBe(true);
    const queue = (await runtime.liveSnapshot(sessionId))?.state.queue;
    const queuedId = queue?.[0]?.id;
    if (!queuedId) throw new Error("Missing queued input");
    await runtime.cancelQueued(sessionId, queuedId);
    await runtime.stop(sessionId);
    await sending;
    expect(aborted).toBe(true);
    expect(runtime.isRunning(sessionId)).toBe(false);
    expect(
      (await store.loadMessages(sessionId)).messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
  });

  it("stop during queued attachment preprocessing cannot admit another native run", async () => {
    let entered = false;
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "hold",
        parameters: Type.Object({}),
        execute: async (_args, _api, context) => {
          entered = true;
          await new Promise<void>((resolve) =>
            context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return { content: [] };
        },
      }),
    ];
    faux.setResponses([
      toolResponse(fauxToolCall("mcp__test__call", {})),
      fauxAssistantMessage("must not start"),
    ]);
    const original = runtime.send(sessionId, "original");
    await expect.poll(() => entered).toBe(true);
    let release = () => {};
    preprocessing.entered = false;
    preprocessing.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = runtime.send(
      sessionId,
      "cancel this attachment",
      [
        {
          kind: "text",
          name: "note.txt",
          mimeType: "text/plain",
          size: 4,
          data: Buffer.from("note").toString("base64"),
        },
      ],
      "queued-optimistic",
    );
    try {
      await expect.poll(() => preprocessing.entered).toBe(true);
      await runtime.stop(sessionId);
    } finally {
      release();
    }
    await Promise.all([original, queued]);
    expect(faux.state.callCount).toBe(1);
    expect(
      (await store.loadMessages(sessionId)).messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
    expect(
      events.some(
        ({ event }) => event.type === "input-cancelled" && event.messageId === "queued-optimistic",
      ),
    ).toBe(true);
  });

  it("stop during preprocessing prevents any later native submission or model call", async () => {
    let release = () => {};
    preprocessing.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const sending = runtime.send(sessionId, "delayed input");
    try {
      await expect.poll(() => preprocessing.entered).toBe(true);
      await runtime.stop(sessionId);
      expect(runtime.isRunning(sessionId)).toBe(false);
    } finally {
      release();
    }
    await sending;
    expect(faux.state.callCount).toBe(0);
    expect((await store.loadMessages(sessionId)).messages).toEqual([]);
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
  });

  it("forks and selects the edited native conversation", async () => {
    faux.setResponses([fauxAssistantMessage("old"), fauxAssistantMessage("edited")]);
    await runtime.send(sessionId, "original");
    await runtime.send(sessionId, "replacement", [], undefined, { rewindToEntryId: null });
    const messages = (await store.loadMessages(sessionId)).messages;
    expect(messages.map((message) => message.parts[0])).toEqual([
      { type: "text", text: "replacement" },
      { type: "text", text: "edited" },
    ]);
    expect(messages[0]?.parentId).toBeNull();
  });

  it("keeps observing events after an invalid rewind target", async () => {
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("still streaming")]);
    await runtime.send(sessionId, "first");
    await runtime.send(sessionId, "invalid", [], undefined, { rewindToEntryId: "entry:999999" });
    events = [];
    await runtime.send(sessionId, "valid after failure");
    expect((await runtime.liveSnapshot(sessionId))?.state.messages.at(-1)?.parts[0]).toEqual({
      type: "text",
      text: "still streaming",
    });
    expect((await runtime.liveSnapshot(sessionId))?.state.running).toBe(false);
  });

  it("reapplies current model, thinking and tools after native historical fork", async () => {
    faux.setResponses([fauxAssistantMessage("first")]);
    await runtime.send(sessionId, "first");
    const cutoff = (await store.loadMessages(sessionId)).messages.at(-1)?.entryId;
    if (cutoff === undefined) throw new Error("Missing cutoff");
    settings.services[0]?.models.push({ id: "second", reasoning: true });
    settings.thinkingLevel = "high";
    expect(await runtime.setModel(sessionId, { serviceId: "svc", modelId: "second" })).toEqual({
      ok: true,
    });
    mcpTools = [
      defineTool({
        name: "mcp__new__call",
        description: "new",
        parameters: Type.Object({}),
        execute: async () => ({ content: [] }),
      }),
    ];
    for (const notify of mcpListeners) notify();
    let actualModel: string | undefined;
    let actualThinking: string | undefined;
    let offered: string[] = [];
    faux.setResponses([
      (context, options, _state, model) => {
        actualModel = model.id;
        actualThinking = options?.reasoning;
        offered = context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
        );
        return fauxAssistantMessage("second");
      },
    ]);
    // Null creates a fresh native conversation; a non-tip old cutoff forces a historical native fork.
    await runtime.send(sessionId, "new tail");
    faux.setResponses([
      (context, options, _state, model) => {
        actualModel = model.id;
        actualThinking = options?.reasoning;
        offered = context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
        );
        return fauxAssistantMessage("fork answer");
      },
    ]);
    await runtime.send(sessionId, "retry with current choices", [], undefined, {
      rewindToEntryId: cutoff,
    });
    expect(actualModel).toBe("second");
    expect(actualThinking).toBe("high");
    expect(offered).toContain("mcp__new__call");
  });

  it("restores todo state at a retry cutoff instead of retaining the abandoned branch", async () => {
    faux.setResponses([
      toolResponse(fauxToolCall("todo", { todos: [{ text: "first task", status: "pending" }] })),
      fauxAssistantMessage("first plan"),
    ]);
    await runtime.send(sessionId, "plan one");
    const cutoff = (await store.loadMessages(sessionId)).messages.at(-1)?.entryId;
    if (cutoff === undefined) throw new Error("Missing todo cutoff");
    faux.setResponses([
      toolResponse(fauxToolCall("todo", { todos: [{ text: "abandoned task", status: "active" }] })),
      fauxAssistantMessage("second plan"),
    ]);
    await runtime.send(sessionId, "plan two");
    faux.setResponses([
      toolResponse(fauxToolCall("todo", { todos: [{ text: "first task", status: "done" }] })),
      fauxAssistantMessage("restored plan"),
    ]);
    await runtime.send(sessionId, "retry first plan", [], undefined, { rewindToEntryId: cutoff });
    const parts = (await store.loadMessages(sessionId)).messages.flatMap(
      (message) => message.parts,
    );
    expect(
      parts.filter((part) => part.type === "tool-call" && part.toolName === "todo").at(-1),
    ).toMatchObject({ details: { revision: 2, todos: [{ text: "first task", status: "done" }] } });
  });

  it("returns nothing for native manual compaction with no history", async () => {
    expect(await runtime.compact(sessionId)).toMatchObject({ ok: false, code: "nothing" });
  });

  it("keeps attachment envelopes and their images together through native submit and history", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=";
    let request: TranscriptContext | undefined;
    faux.setResponses([
      (context) => {
        request = context;
        return fauxAssistantMessage("image received");
      },
    ]);
    await runtime.send(sessionId, "look", [
      {
        kind: "image",
        name: "pixel.png",
        mimeType: "image/png",
        size: Buffer.from(png, "base64").length,
        data: png,
        images: [{ mimeType: "image/png", data: png }],
      },
    ]);
    const content = request?.messages.find((message) => message.role === "user")?.content;
    expect(Array.isArray(content) && content.map((block) => block.type)).toEqual([
      "text",
      "text",
      "image",
    ]);
    const message = (await store.loadMessages(sessionId)).messages[0];
    expect(message?.parts[1]).toMatchObject({
      type: "attachment",
      kind: "image",
      name: "pixel.png",
      frames: [{ mimeType: "image/png" }],
    });
  });

  it("refreshes native MCP registrations only once the current work is idle", async () => {
    let release: (() => void) | undefined;
    let entered = false;
    mcpTools = [
      defineTool({
        name: "mcp__test__call",
        description: "hold",
        parameters: Type.Object({}),
        execute: async () => {
          entered = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { content: [] };
        },
      }),
    ];
    const requests: TranscriptContext[] = [];
    faux.setResponses([
      toolResponse(fauxToolCall("mcp__test__call", {})),
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("first done");
      },
      (context) => {
        requests.push(context);
        return fauxAssistantMessage("second done");
      },
    ]);
    const first = runtime.send(sessionId, "use original tools");
    await expect.poll(() => entered).toBe(true);
    mcpTools = [
      defineTool({
        name: "mcp__added__call",
        description: "added",
        parameters: Type.Object({}),
        execute: async () => ({ content: [] }),
      }),
    ];
    for (const notify of mcpListeners) notify();
    release?.();
    await first;
    // The native registry update completes on the idle boundary; an extra notify is harmless.
    for (const notify of mcpListeners) notify();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await runtime.send(sessionId, "use refreshed tools");
    const offered = (context: TranscriptContext | undefined) =>
      context?.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
      ) ?? [];
    expect(offered(requests[0])).not.toContain("mcp__added__call");
    expect(offered(requests[1])).toContain("mcp__added__call");
    expect(offered(requests[1])).toContain("ask_user");
    expect(offered(requests[1])).toContain("Task");
  });
  it("runs a child in the shared native family with the dispatch model and exact whitelist", async () => {
    let childModel: string | undefined;
    let childTools: string[] = [];
    faux.setResponses(
      Array.from({ length: 8 }, () => (context, _options, _state, model) => {
        const last = context.messages.filter((message) => message.role !== "system").at(-1);
        if (last?.role === "user" && textOf(context).at(-1) === "delegate")
          return toolResponse(
            fauxToolCall(
              "Task",
              {
                definition: {
                  name: "reader",
                  description: "read",
                  prompt: "Report your findings.",
                  tools: ["read"],
                },
                description: "read one file",
                task: "child-work",
              },
              { id: "native-child" },
            ),
          );
        if (last?.role === "user" && textOf(context).at(-1) === "child-work") {
          childModel = model.id;
          childTools = context.messages.flatMap((message) =>
            message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
          );
          return fauxAssistantMessage("child-complete");
        }
        return fauxAssistantMessage("parent-complete");
      }),
    );
    await runtime.send(sessionId, "delegate");
    await vi.waitFor(async () =>
      expect((await runtime.listSubagents(sessionId))[0]?.status).toBe("completed"),
    );
    const [run] = await runtime.listSubagents(sessionId);
    expect(childModel).toBe("test");
    expect(childTools).toEqual(["read"]);
    if (!run) throw new Error("Missing child run");
    const childSession = await store.open(run.childSessionId);
    const rootSession = await store.open(sessionId);
    expect(childSession?.storage).toBe(rootSession?.storage);
    const messages = (await store.loadMessages(sessionId)).messages;
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(
      messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool-call" && part.toolCallId === "native-child"),
    ).toMatchObject({ status: "done", details: { status: "completed", report: "child-complete" } });
  });

  it("cold direct child opening restores its family without a creation-promise cycle", async () => {
    const run = await seedPendingChild();
    faux.setResponses([fauxAssistantMessage("recovered child")]);
    await runtime.prepareSubagent(run.childSessionId);
    await vi.waitFor(async () =>
      expect((await runtime.listSubagents(sessionId))[0]?.status).toBe("completed"),
    );
    expect(
      (await store.loadMessages(run.childSessionId)).messages.filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(1);
  });

  it("a child preparation failure leaves the root usable and child preparation can be retried", async () => {
    const run = await seedPendingChild("unavailable");
    const service = settings.services[0];
    if (!service) throw new Error("Missing fixture provider");
    service.models.push({ id: "unavailable" });
    await runtime.prepareSubagent(sessionId);
    expect((await runtime.listSubagents(sessionId))[0]?.status).toBe("failed");
    service.models = service.models.filter((model) => model.id !== "unavailable");
    await runtime.prepareSubagent(run.childSessionId);
    faux.setResponses([fauxAssistantMessage("root still usable")]);
    await runtime.send(sessionId, "continue");
    expect((await store.loadMessages(sessionId)).messages.at(-1)?.parts[0]).toEqual({
      type: "text",
      text: "root still usable",
    });
  });
});
