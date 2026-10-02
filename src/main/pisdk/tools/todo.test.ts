import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { TodoDoc } from "../native-state";
import { openNativeStateTest } from "../native-state-test";
import { createTodoTool } from "./todo";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const test = await openNativeStateTest();
  cleanups.push(test.close);
  return test;
}
describe("native todo document", () => {
  it("atomically replaces the list, assigns stable ids, and replays a task only once", async () => {
    const test = await setup();
    const tool = createTodoTool();
    const first = await test.invoke(async (api, ctx) => {
      const params = { todos: [{ text: "实现功能", status: "active" as const }] };
      const before = await tool.execute(params, api, ctx);
      const replay = await tool.execute(params, api, ctx);
      expect(replay.details).toEqual(before.details);
      return before.details ?? null;
    });
    expect(await first.result).toMatchObject({
      revision: 1,
      todos: [{ id: "t1", text: "实现功能", status: "active" }],
    });
    const next = await test.invoke(
      async (api, ctx) =>
        (await tool.execute({ todos: [{ text: "实现功能", status: "done" }] }, api, ctx)).details ??
        null,
    );
    expect(await next.result).toMatchObject({ revision: 2, todos: [{ id: "t1", status: "done" }] });
  });
  it("fork uses the document at the selected transcript entry, not the latest list", async () => {
    const test = await setup();
    const tool = createTodoTool();
    await (
      await test.invoke(
        async (api, ctx) =>
          (
            await tool.execute({ todos: [{ text: "First", status: "pending" }] }, api, ctx)
          ).details ?? null,
      )
    ).result;
    const at = await test.harness.commit(
      (tx) => tx.appendEntry(test.root.id, { kind: "test.marker", data: {} }),
      context,
    );
    await (
      await test.invoke(
        async (api, ctx) =>
          (await tool.execute({ todos: [{ text: "Later", status: "done" }] }, api, ctx)).details ??
          null,
      )
    ).result;
    const fork = await test.root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
    expect((await test.harness.snapshot(TodoDoc, fork.id, context))?.todos[0]?.text).toBe("First");
    expect((await test.harness.snapshotAsOf(TodoDoc, test.root.id, at.id, context))?.revision).toBe(
      1,
    );
  });
  it("rejects blank entries without incrementing revision", async () => {
    const test = await setup();
    const invocation = await test.invoke(
      async (api, ctx) =>
        (await createTodoTool().execute({ todos: [{ text: " ", status: "done" }] }, api, ctx))
          .details ?? null,
    );
    expect(await invocation.result).toEqual({ revision: 0, todos: [] });
  });
});
