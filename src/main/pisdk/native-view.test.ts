import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type ConversationView,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatLiveSnapshot, ChatViewFrame } from "@/shared/contracts/chat";
import type { SubagentRun } from "@/shared/contracts/subagent";
import { AppSessionHandle } from "./durable-session";
import { JobsDoc } from "./jobs";
import { compactionReceipt } from "./native-operations";
import { ApprovalDoc } from "./native-state";
import { type NativeSubagent, SubagentsDoc } from "./native-subagents";
import { createNativeView } from "./native-view";

const close: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const end of close.splice(0).reverse()) await end();
});
async function fixture(tools: ToolRegistration[] = []) {
  const provider = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: 100000 });
  const models = createModels();
  models.setProvider(provider.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test", tools }));
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { retry: { enabled: false } } },
    context,
  );
  const conversation = await harness.root(context, {
    agent: { model: { provider: provider.provider.id, modelId: "test" } },
  });
  const session = new AppSessionHandle(
    storage,
    { id: "fixture", createdAt: 1 },
    conversation.id,
    () => {},
  );
  await session.bindHarness(async () => harness);
  close.push(() => session.close());
  await conversation.commit(async (tx) => {
    await tx.doc(SubagentsDoc, conversation.id);
    await tx.doc(JobsDoc, conversation.id);
    await tx.doc(ApprovalDoc, conversation.id);
  }, context);
  const frames: ChatViewFrame[] = [];
  const view = await createNativeView({
    harness,
    conversation,
    session,
    emit: (event) => {
      if (event.type === "view") frames.push(structuredClone(event.frame));
    },
  });
  close.push(() => view.stop());
  return { provider, registry, storage, harness, conversation, session, view, frames };
}
function replay(frames: ChatViewFrame[]): ChatLiveSnapshot | undefined {
  let result: ChatLiveSnapshot | undefined;
  for (const frame of frames) {
    if ("state" in frame) result = frame;
    else {
      if (!result || frame.previousRevision !== result.revision) throw new Error("Revision gap");
      result = {
        generation: frame.generation,
        revision: frame.revision,
        state: applyImmutable(result.state, frame.ops),
      };
    }
  }
  return result;
}

describe("committed native conversation projection", () => {
  it("streams the native view and produces the same final messages as paged history", async () => {
    const f = await fixture();
    f.provider.setResponses([fauxAssistantMessage("complete reply")]);
    await (
      await f.conversation.submit(
        { type: "input", content: "hello", requestId: "optimistic" },
        context,
      )
    ).wait(context);
    await f.view.flush();
    expect(f.view.snapshot.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(f.view.snapshot.state.admittedRequestIds).toContain("optimistic");
    expect(f.view.snapshot.state.running).toBe(false);
    expect(f.view.snapshot.state.usage.outputTokens).toBeGreaterThan(0);
    expect(replay(f.frames)).toEqual(f.view.snapshot);
    expect(f.view.snapshot.state.messages.every((message) => message.id === message.entryId)).toBe(
      true,
    );
  });
  it("reconnects during a running tool with retained output, details and no replayed user input", async () => {
    let release = () => {};
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = defineTool({
      name: "hold",
      parameters: Type.Object({}),
      description: "hold",
      execute: async (_args, api, context) => {
        api.output("retained output");
        await api.details({ stage: "waiting" }, context);
        entered = true;
        await gate;
        return { content: [{ type: "text", text: "finished" }], details: { stage: "done" } };
      },
    });
    const f = await fixture([tool]);
    f.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}, { id: "hold-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const running = await f.conversation.submit({ type: "input", content: "work" }, context);
    try {
      await expect.poll(() => entered).toBe(true);
      const connected = await createNativeView({
        harness: f.harness,
        conversation: f.conversation,
        session: f.session,
        emit: () => {},
      });
      close.push(() => connected.stop());
      expect(
        connected.snapshot.state.messages
          .flatMap((message) => message.parts)
          .find((part) => part.type === "tool-call"),
      ).toMatchObject({
        partialOutput: "retained output",
        details: { stage: "waiting" },
        status: "running",
      });
      expect(
        connected.snapshot.state.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
    } finally {
      release();
    }
    await running.wait(context);
    await f.view.flush();
    expect(
      f.view.snapshot.state.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool-call"),
    ).toMatchObject({ status: "done", result: "finished", details: { stage: "done" } });
  });
  it("observes native bounded-watch reset and catches up without reconstructing missing events", async () => {
    const f = await fixture();
    const delayed = await f.conversation.watch(context);
    close.push(() => delayed.stop());
    for (let index = 0; index < 125; index++)
      await f.conversation.commit(
        (tx) =>
          tx.appendEntry(f.conversation.id, {
            kind: "pi.user",
            model: [{ role: "user", content: `message ${index}`, timestamp: index }],
          }),
        context,
      );
    let recovered: ConversationView | undefined;
    let reset = false;
    delayed.start(async (value, ops) => {
      recovered = value;
      reset ||= ops[0]?.[0] === "r";
    });
    await expect.poll(() => recovered?.entries.length).toBe(125);
    expect(reset).toBe(true);
    await f.view.flush();
    expect(f.view.snapshot.state.messages).toHaveLength(125);
    expect(replay(f.frames)).toEqual(f.view.snapshot);
  });
  it("publishes durable reports after the original tool entry leaves active context without a model wake", async () => {
    const run: SubagentRun = {
      delegationId: "delegate",
      parentToolCallId: "delegate",
      sessionId: "root",
      childSessionId: "root~child",
      agentName: "reader",
      agentSource: "builtin",
      description: "read",
      task: "read",
      status: "running",
      startedAt: 1,
      model: null,
      modelId: "test",
      thinkingLevel: "off",
      turns: 0,
      toolCalls: 0,
    };
    const tool = defineTool({
      name: "Task",
      description: "delegate",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "started" }] }),
    });
    const f = await fixture([tool]);
    f.provider.setResponses([
      fauxAssistantMessage(fauxToolCall("Task", {}, { id: "delegate" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("parent done"),
    ]);
    await (await f.conversation.submit({ type: "input", content: "delegate" }, context)).wait(
      context,
    );
    await f.conversation.commit(
      (tx) =>
        tx.appendEntry(f.conversation.id, {
          kind: "pi.compaction",
          head: "self",
          model: [{ role: "user", content: "summary", timestamp: 9 }],
        }),
      context,
    );
    await f.view.flush();
    expect(f.view.snapshot.state.messages).toEqual([]);
    const calls = f.provider.state.callCount;
    await f.conversation.commit(async (tx) => {
      (await tx.doc(SubagentsDoc, f.conversation.id)).runs.delegate = {
        run: { ...run, status: "completed", report: "durable report" },
      } as unknown as NativeSubagent;
    }, context);
    await f.view.flush();
    expect(f.view.snapshot.state.reports.delegate?.text).toContain("durable report");
    expect(f.view.snapshot.state.running).toBe(false);
    expect(f.provider.state.callCount).toBe(calls);
    const reopened = await createNativeView({
      harness: f.harness,
      conversation: f.conversation,
      session: f.session,
      emit: () => {},
    });
    close.push(() => reopened.stop());
    expect(reopened.snapshot.state.reports.delegate).toEqual(
      f.view.snapshot.state.reports.delegate,
    );
  });
  it("projects native failed submission receipts and declined manual compaction", async () => {
    const f = await fixture();
    const compact = await f.conversation.compact(undefined, context);
    expect((await compactionReceipt(f.harness, compact)).status).toBe("declined");
    f.provider.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
    ]);
    await (await f.conversation.submit({ type: "input", content: "fail" }, context)).wait(context);
    await f.view.flush();
    expect(f.view.snapshot.state.running).toBe(false);
    expect(f.view.snapshot.state.messages.some((message) => message.status === "error")).toBe(true);
    expect(f.view.snapshot.state.compaction?.phase).toBe("cancelled");
  });
});
