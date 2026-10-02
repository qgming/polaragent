import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "@/shared/contracts/settings";
import type { AiApprover } from "./ai-approver";
import { type ApprovalInput, createApprovalService, effectivePermissionMode } from "./approvals";
import { ApprovalDoc } from "./native-state";
import { openNativeStateTest } from "./native-state-test";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(aiApprover?: AiApprover) {
  const service = createApprovalService({
    emit: () => {},
    getSettings: async () => ({ permissionMode: aiApprover ? "ai_review" : "default" }) as Settings,
    ...(aiApprover ? { aiApprover } : {}),
  });
  const test = await openNativeStateTest(service.taskDefinitions);
  cleanups.push(test.close);
  await service.attach(test.attachment);
  const request = (extra: Partial<ApprovalInput> = {}) =>
    test.invoke((api, ctx) =>
      service.request({
        sessionId: "s1",
        toolCallId: api.callId,
        toolName: "bash",
        argsText: '{"command":"build"}',
        risk: "high",
        api,
        context: ctx,
        ...extra,
      }),
    );
  const pending = async () => {
    await expect.poll(async () => (await service.pending()).length).toBe(1);
    const card = (await service.pending())[0];
    if (!card) throw new Error("Missing pending request");
    return card;
  };
  return { ...test, service, request, pending };
}
describe("native approval authority", () => {
  it("commits decision before IPC acknowledgement and invocation completion", async () => {
    const test = await setup();
    const call = await test.request();
    const card = await test.pending();
    await test.service.respond(card.id, "allow_once", "reviewed");
    const saved = await test.harness.snapshot(ApprovalDoc, test.root.id, context);
    expect(saved?.entries[card.id]?.record).toMatchObject({
      decision: "allow_once",
      note: "reviewed",
    });
    expect(await call.result).toBe("allow_once");
    expect(await test.service.pending()).toEqual([]);
    expect((await test.service.history())[0]?.decision).toBe("allow_once");
  });
  it("deduplicates replay by native task and final arguments, then requires a new decision when args change", async () => {
    const test = await setup();
    const call = await test.invoke(async (api, ctx) => {
      const input = {
        sessionId: "s1",
        toolCallId: api.callId,
        toolName: "bash",
        argsText: "first",
        risk: "high" as const,
        api,
        context: ctx,
      };
      const decision = await test.service.request(input);
      expect(await test.service.request(input)).toBe(decision);
      return test.service.request({ ...input, argsText: "changed" });
    });
    await test.service.respond((await test.pending()).id, "allow_once");
    await expect.poll(async () => (await test.service.pending())[0]?.argsText).toBe("changed");
    await test.service.respond((await test.pending()).id, "deny");
    expect(await call.result).toBe("deny");
    expect(await test.service.history()).toHaveLength(2);
  });
  it("recreates service from committed pending data and routes a hidden child's card to parent", async () => {
    const test = await setup();
    const detach = await test.service.attach({ ...test.attachment, displaySessionId: "parent" });
    const call = await test.request();
    const card = await test.pending();
    expect(card.sessionId).toBe("parent");
    detach();
    const recovered = createApprovalService({
      emit: () => {},
      getSettings: async () => ({ permissionMode: "default" }) as Settings,
    });
    await recovered.attach({ ...test.attachment, displaySessionId: "parent" });
    expect((await recovered.pending("parent"))[0]?.id).toBe(card.id);
    await recovered.respond(card.id, "deny");
    expect(await call.result).toBe("deny");
  });
  it("fork resets approvals and native abort resolves denial", async () => {
    const test = await setup();
    const call = await test.request();
    await test.pending();
    const at = await test.harness.commit(
      (tx) => tx.appendEntry(test.root.id, { kind: "test.marker", data: {} }),
      context,
    );
    const fork = await test.root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
    expect((await test.harness.snapshot(ApprovalDoc, fork.id, context))?.entries ?? {}).toEqual({});
    await test.service.cancelSession("s1");
    expect(await call.result).toBe("deny");
  });
  it("AI denial hands the committed request back to user; user decision wins", async () => {
    const test = await setup(async () => ({ allow: false, reason: "需要确认" }));
    const call = await test.request();
    await expect.poll(async () => (await test.service.pending())[0]?.aiReviewed).toBe(true);
    const card = await test.pending();
    expect(card.reason).toBe("需要确认");
    await test.service.respond(card.id, "allow_once");
    expect(await call.result).toBe("allow_once");
  });
  it("AI allowance is durable and full permission is preserved for subagents", async () => {
    const test = await setup(async () => ({ allow: true, reason: "只读" }));
    expect(await (await test.request()).result).toBe("allow_once");
    expect((await test.service.history())[0]).toMatchObject({ decidedBy: "ai" });
    expect(effectivePermissionMode("full", true)).toBe("full");
    expect(effectivePermissionMode("default", true)).toBe("ai_review");
  });
});
