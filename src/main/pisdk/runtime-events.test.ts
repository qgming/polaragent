import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  CompactionTask,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  hook,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactionReceipt,
  createRuntimeEventBridge,
  type RuntimeEvent,
  updateRetainedOutput,
} from "./runtime-events";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(tools: ToolRegistration[] = []) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test", tools }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { retry: { enabled: false } } },
    context,
  );
  const conversation = await harness.root(context, {
    agent: { model: { provider: faux.provider.id, modelId: "test" } },
  });
  cleanups.push(() => harness.close(context));
  const bridge = await createRuntimeEventBridge({
    harness,
    conversationId: conversation.id,
    externalEntryId: (id) => `entry:${id}`,
    projectEntry: async (record) => {
      const previous = await conversation.entries({ maxEntryId: record.id }, 2, undefined, context);
      return {
        record,
        entryId: `entry:${record.id}`,
        parentId: previous.items[1] ? `entry:${previous.items[1].id}` : null,
      };
    },
  });
  cleanups.push(() => bridge.stop());
  return { faux, harness, conversation, bridge, registry };
}

describe("native durable event bridge", () => {
  it("applies native retained output trims, appends and replacements", () => {
    expect(updateRetainedOutput("abc", { trimStart: 2, append: "de" })).toBe("cde");
    expect(updateRetainedOutput("old", { set: "" })).toBe("");
    expect(updateRetainedOutput("same", undefined)).toBe("same");
  });

  it("bridges committed native messages, tool results, entry identities and completion", async () => {
    const tool = defineTool({
      name: "echo",
      description: "echo",
      parameters: Type.Object({ text: Type.String() }),
      execute: async ({ text }, api) => {
        api.output(text);
        return { content: [{ type: "text", text }], details: { preserved: true } };
      },
    });
    const { faux, conversation, bridge } = await fixture([tool]);
    const events: RuntimeEvent[] = [];
    for (const type of [
      "message_start",
      "message_end",
      "entry_added",
      "tool_end",
      "run_end",
    ] as const)
      bridge.on(type, (event) => {
        events.push(event);
      });
    await bridge.start();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "tool output" }, { id: "call-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("answer"),
    ]);
    await (await conversation.submit({ type: "input", content: "question" }, context)).wait(
      context,
    );
    await conversation.waitForIdle(context);
    await expect.poll(() => events.filter((event) => event.type === "run_end").length).toBe(1);
    expect(events.find((event) => event.type === "tool_end")).toMatchObject({
      type: "tool_end",
      toolCallId: "call-1",
      isError: false,
      result: { content: [{ type: "text", text: "tool output" }], details: { preserved: true } },
    });
    expect(
      events.filter((event) => event.type === "entry_added" && event.entry.type === "message"),
    ).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "completed" });
  });

  it("uses native unanswered receipts for a failed run", async () => {
    const { conversation, bridge } = await fixture();
    const events: RuntimeEvent[] = [];
    bridge.on("run_end", (event) => {
      events.push(event);
    });
    await bridge.start();
    await conversation.configure({ model: null }, context);
    await (await conversation.submit({ type: "input", content: "question" }, context)).wait(
      context,
    );
    await expect.poll(() => events.length).toBe(1);
    expect(events[0]).toMatchObject({ status: "failed", error: { message: "no_model" } });
  });

  it("maps a native compaction with no history to declined", async () => {
    const { harness, conversation, bridge } = await fixture();
    await bridge.start();
    const task = await conversation.compact(undefined, context);
    expect(await compactionReceipt(harness, task)).toEqual({ status: "declined" });
  });

  it("keeps native compaction and reset model context out of visible user messages", async () => {
    const { conversation, bridge } = await fixture();
    const messages: RuntimeEvent[] = [];
    bridge.on("message_start", (event) => {
      messages.push(event);
    });
    bridge.on("message_end", (event) => {
      messages.push(event);
    });
    await bridge.start();
    await (
      await conversation.submit(
        {
          type: "write",
          entry: {
            kind: "pi.compaction",
            head: "self",
            model: [{ role: "user", content: "internal summary", timestamp: Date.now() }],
            data: { reason: "manual" },
          },
        },
        context,
      )
    ).wait(context);
    await conversation.reset("internal handoff", context);
    await bridge.flush();
    expect(messages).toHaveLength(0);
  });

  it("attaches a native snapshot during a running tool without replaying saved messages", async () => {
    let running = false;
    let release: (() => void) | undefined;
    const tool = defineTool({
      name: "hold",
      description: "hold",
      parameters: Type.Object({}),
      execute: async (_args, api) => {
        api.output("retained output");
        running = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { content: [{ type: "text", text: "done" }] };
      },
    });
    const { faux, harness, conversation, bridge } = await fixture([tool]);
    await bridge.start();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const submission = await conversation.submit({ type: "input", content: "hold" }, context);
    await expect.poll(() => running).toBe(true);
    const late = await createRuntimeEventBridge({
      harness,
      conversationId: conversation.id,
      externalEntryId: (id) => String(id),
      projectEntry: (record) => ({ record, entryId: String(record.id), parentId: null }),
    });
    cleanups.push(() => late.stop());
    const snapshots: RuntimeEvent[] = [];
    const messages: RuntimeEvent[] = [];
    late.on("snapshot", (event) => {
      snapshots.push(event);
    });
    late.on("message_start", (event) => {
      messages.push(event);
    });
    try {
      await late.start();
      expect(snapshots[0]).toMatchObject({
        type: "snapshot",
        snapshot: {
          run: { inputs: [submission.id] },
          tools: [{ name: "hold", status: "running" }],
        },
      });
      expect(messages).toHaveLength(0);
    } finally {
      release?.();
      await submission.wait(context);
    }
  });

  it("joins an admitted asynchronous delivery before the native owner can close", async () => {
    const { faux, harness, conversation, bridge } = await fixture();
    let entered = false;
    let readCompleted = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bridge.on("message_start", async ({ message }) => {
      if (message.role !== "user") return;
      entered = true;
      await gate;
      await conversation.entries({}, 1, undefined, context);
      readCompleted = true;
    });
    await bridge.start();
    faux.setResponses([fauxAssistantMessage("finished")]);
    await (await conversation.submit({ type: "input", content: "question" }, context)).wait(
      context,
    );
    await expect.poll(() => entered).toBe(true);
    const warning = vi.spyOn(console, "warn");
    let stopCompleted = false;
    const stopping = bridge.stop().then(() => {
      stopCompleted = true;
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(stopCompleted).toBe(false);
    } finally {
      release();
      await stopping;
    }
    expect(readCompleted).toBe(true);
    await harness.close(context);
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("joins initial snapshot delivery when stopped before start finishes", async () => {
    const { harness, conversation, bridge } = await fixture();
    let entered = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bridge.on("snapshot", async () => {
      entered = true;
      await gate;
      await conversation.entries({}, 1, undefined, context);
    });
    const starting = bridge.start();
    await expect.poll(() => entered).toBe(true);
    let stopCompleted = false;
    const stopping = bridge.stop().then(() => {
      stopCompleted = true;
    });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(stopCompleted).toBe(false);
    } finally {
      release();
      await starting;
      await stopping;
    }
    await harness.close(context);
  });

  it("cancels detached compaction receipt observation without waiting for a queued summary", async () => {
    let running = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = defineTool({
      name: "hold",
      description: "hold",
      parameters: Type.Object({}),
      execute: async () => {
        running = true;
        await gate;
        return { content: [] };
      },
    });
    const { faux, harness, conversation, bridge, registry } = await fixture([tool]);
    registry.install(
      defineExtension({
        name: "summary",
        hooks: [hook(CompactionTask, { beforeCompact: () => ({ summary: "compressed history" }) })],
      }),
    );
    await conversation.commit(async (tx) => {
      for (let index = 0; index < 8; index += 1)
        await tx.appendEntry(conversation.id, {
          kind: "pi.user",
          model: [
            { role: "user", content: `past ${index}: ${"x".repeat(40_000)}`, timestamp: index },
          ],
        });
    }, context);
    await bridge.start();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const submission = await conversation.submit({ type: "input", content: "hold" }, context);
    const warning = vi.spyOn(console, "warn");
    try {
      await expect.poll(() => running).toBe(true);
      const observed = vi.spyOn(harness, "submission");
      const task = await conversation.compact(undefined, context);
      const receipt = await harness.waitForTask(task, context);
      if (
        receipt.state.outcome.status !== "completed" ||
        receipt.state.outcome.result.submissionId === undefined
      )
        throw new Error("Missing queued summary");
      const summaryId = receipt.state.outcome.result.submissionId;
      await expect.poll(() => observed.mock.calls.some(([id]) => id === summaryId)).toBe(true);
      let stopped = false;
      const stopping = bridge.stop().then(() => {
        stopped = true;
      });
      await expect.poll(() => stopped).toBe(true);
      await stopping;
      observed.mockRestore();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      release();
      await submission.wait(context);
      await bridge.stop();
      await harness.close(context);
      warning.mockRestore();
    }
  });
});
