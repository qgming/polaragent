import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { createInteractionService } from "./interactions";
import { InteractionDoc } from "./native-state";
import { openNativeStateTest } from "./native-state-test";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const questions = [{ id: "q1", header: "选择", question: "用哪个方案？", options: ["A", "B"] }];
async function setup(timeoutMs = 30000) {
  const service = createInteractionService({ emit: () => {}, timeoutMs });
  const test = await openNativeStateTest(service.taskDefinitions);
  cleanups.push(test.close);
  await service.attach(test.attachment);
  const request = () =>
    test.invoke(async (api, ctx) => ({
      ...(await service.request({
        sessionId: "s1",
        toolCallId: api.callId,
        questions,
        api,
        context: ctx,
      })),
    }));
  const pending = async () => {
    await expect.poll(async () => (await service.pending()).length).toBe(1);
    const card = (await service.pending())[0];
    if (!card) throw new Error("Missing pending request");
    return card;
  };
  return { ...test, service, request, pending };
}
describe("native question task", () => {
  it("stores the reply before acknowledging and first committed answer wins", async () => {
    const test = await setup();
    const call = await test.request();
    const card = await test.pending();
    await Promise.all([
      test.service.respond(card.id, {
        outcome: "answered",
        answers: [{ questionId: "q1", selected: ["A"] }],
      }),
      test.service.respond(card.id, { outcome: "cancelled", answers: [] }),
    ]);
    expect(
      (await test.harness.snapshot(InteractionDoc, test.root.id, context))?.entries[card.id]
        ?.response?.outcome,
    ).toBe("answered");
    expect(await call.result).toMatchObject({
      outcome: "answered",
      answers: [{ selected: ["A"] }],
    });
  });
  it("native task enforces deadline without a service timer", async () => {
    const test = await setup(30);
    const call = await test.request();
    expect(await call.result).toMatchObject({ outcome: "unanswered", answers: [] });
    expect(await test.service.pending()).toEqual([]);
  });
  it("service recreation restores the original deadline and pending card; fork resets it", async () => {
    const test = await setup();
    const call = await test.request();
    const card = await test.pending();
    const recovered = createInteractionService({ emit: () => {} });
    await recovered.attach(test.attachment);
    expect((await recovered.pending())[0]?.createdAt).toBe(card.createdAt);
    const at = await test.harness.commit(
      (tx) => tx.appendEntry(test.root.id, { kind: "test.marker", data: {} }),
      context,
    );
    const fork = await test.root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
    expect((await test.harness.snapshot(InteractionDoc, fork.id, context))?.entries ?? {}).toEqual(
      {},
    );
    await recovered.respond(card.id, { outcome: "answered", answers: [] });
    expect(await call.result).toMatchObject({ outcome: "answered" });
  });
  it("cancellation is owned by native task graph and durably removes the pending card", async () => {
    const test = await setup();
    const call = await test.request();
    await test.pending();
    await test.service.cancelSession("s1");
    expect(await call.result).toMatchObject({ outcome: "cancelled" });
    expect(await test.service.pending()).toEqual([]);
  });
});
