import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineTask,
  type Extension,
  Harness,
  type Storage,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { createToolTestApi } from "./tools/tool-test-api";

/** Real Harness scheduler/storage fixture, with only the model invocation replaced by a callback. */
export async function openNativeStateTest(
  tasks: NonNullable<Extension["tasks"]> = [],
  storage: Storage = new MemoryStorage(),
) {
  const callbacks = new Map<
    number,
    (api: ToolExecutionApi, context: Context) => Promise<unknown>
  >();
  let next = 0;
  const owner = defineTask<{ key: number }, { phase: "run" }, JsonValue>({
    name: "test.state-owner",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(task, runtime, context) {
        const callback = callbacks.get(task.input.key);
        if (!callback) throw new Error("Missing invocation callback");
        const api = createToolTestApi({
          taskId: runtime.taskId,
          conversationId: runtime.conversationId,
          callId: `call-${task.input.key}`,
          registry: runtime.registry,
          memo: runtime.memo.bind(runtime),
          snapshot: runtime.snapshot.bind(runtime),
          snapshotAsOf: runtime.snapshotAsOf.bind(runtime),
          watchDoc: runtime.watchDoc.bind(runtime),
          getTask: runtime.getTask.bind(runtime),
          waitForTask: runtime.waitForTask.bind(runtime),
          commit: async (change, ctx) => {
            let result: unknown;
            await runtime.commit(async (tx) => {
              result = await change(tx);
            }, ctx);
            return result as never;
          },
        });
        const result = JSON.parse(JSON.stringify(await callback(api, context))) as JsonValue;
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result } }),
          context,
        );
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result: null } }),
        context,
      );
    },
  });
  const registry = createRegistry();
  registry.install({ name: "test.state", tasks: [owner, ...tasks] });
  const harness = await Harness.open(storage, { models: createModels(), registry }, context);
  const root = await harness.root(context);
  async function invoke(
    callback: (api: ToolExecutionApi, context: Context) => Promise<unknown>,
    conversationId = root.id,
  ) {
    const key = ++next;
    callbacks.set(key, callback);
    const id = await harness.commit(
      (tx) =>
        tx.createTask(owner, { key }, { conversationId, ownership: { kind: "conversation" } }),
      context,
    );
    const result = harness.waitForTask(id, context).then((receipt) => {
      if (receipt.state.outcome.status !== "completed")
        throw new Error(JSON.stringify(receipt.state.outcome));
      return receipt.state.outcome.result;
    });
    void result.catch(() => {});
    return { id, result };
  }
  return {
    harness,
    root,
    registry,
    invoke,
    attachment: { harness, conversationId: root.id, sessionId: "s1", displaySessionId: "s1" },
    close: () => harness.close(context),
  };
}
