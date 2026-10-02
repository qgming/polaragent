// Native durable invocation fixture; storage operations must be configured explicitly.
import { createRegistry, type ToolExecutionApi } from "@earendil-works/pi-durable";

export function createToolTestApi(overrides: Partial<ToolExecutionApi> = {}): ToolExecutionApi {
  const unavailable = async (): Promise<never> => {
    throw new Error("This test did not configure durable storage");
  };
  return {
    taskId: 1 as ToolExecutionApi["taskId"],
    conversationId: 1 as ToolExecutionApi["conversationId"],
    callId: "call-1",
    registry: createRegistry().snapshot(),
    env: undefined,
    agent: unavailable,
    output() {},
    diagnostic() {},
    details: async () => {},
    commit: unavailable,
    memo: unavailable,
    createTask: unavailable,
    getTask: unavailable,
    waitForTask: unavailable,
    conversation: unavailable,
    snapshot: unavailable,
    snapshotAsOf: unavailable,
    watchDoc: unavailable,
    ...overrides,
  };
}
