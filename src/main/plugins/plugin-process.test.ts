import { MessageChannel, type MessagePort } from "node:worker_threads";
import { type Context, createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { PluginAgent, type PluginAgentDescription } from "./agent-service";
import { connectPluginProcess } from "./plugin-process";
import { type BytePort, createPluginServer } from "./transport";

function bytePort(port: MessagePort): BytePort {
  return {
    postMessage: (value) => port.postMessage(value),
    close: () => port.close(),
    onData(listener) {
      port.on("message", listener);
      return () => port.off("message", listener);
    },
    onClose(listener) {
      port.on("close", listener);
      return () => port.off("close", listener);
    },
  };
}
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const description: PluginAgentDescription = {
  tools: [{ name: "echo", description: "Echo", parameters: { type: "object" } }],
  commands: [],
  sections: [],
};

async function setup(execute: (context: Context) => Promise<string> = async () => "ok") {
  let update!: (name: string) => void;
  const host = await createFacetHost({
    facets: [
      defineFacet({
        id: "test",
        setup(env) {
          const state = env.replicatedState(structuredClone(description));
          update = (name) =>
            state.change(BACKGROUND_CONTEXT, (draft) => {
              if (draft.tools[0]) draft.tools[0].description = name;
            });
          env.provide(PluginAgent, {
            description: state,
            async execute(_name, _args, _invocation, context) {
              return { content: [{ type: "text", text: await execute(context) }] };
            },
            async command() {
              return "command";
            },
            async beforeTool() {
              return {};
            },
            async afterTool(_call, result) {
              return result;
            },
          });
        },
      }),
    ],
  });
  cleanups.push(() => host.dispose());
  const { port1, port2 } = new MessageChannel();
  const server = createPluginServer(
    host.services,
    bytePort(port2),
    "3fc4af76-1359-4b26-9e8f-bdb675936eda",
  );
  await server.start();
  cleanups.push(() => server.close());
  const process = await connectPluginProcess(
    bytePort(port1),
    "3fc4af76-1359-4b26-9e8f-bdb675936eda",
    () => {},
  );
  cleanups.push(async () => process.stop());
  return { process, update };
}
const invoke = (
  process: Awaited<ReturnType<typeof setup>>["process"],
  context = BACKGROUND_CONTEXT,
  timeout?: number,
) =>
  process.invoke(
    (service, context) =>
      service.execute(
        "echo",
        {},
        { callId: "c", taskId: "t", conversationId: "s", cwd: "" },
        context,
      ),
    context,
    timeout,
  );

describe("official Client/Server on MessagePort", () => {
  it("invokes a Chord facet service and hydrates/updates replicated descriptors", async () => {
    const { process, update } = await setup();
    expect(await invoke(process)).toMatchObject({ content: [{ text: "ok" }] });
    update("New description");
    await expect
      .poll(() => process.service.description.value?.tools[0]?.description)
      .toBe("New description");
  });
  it("delivers caller cancellation to the service execution context", async () => {
    let started = false;
    let cancelled = false;
    const { process } = await setup(
      (context) =>
        new Promise((_resolve, reject) => {
          started = true;
          context.abortSignal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(context.abortSignal?.reason);
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const call = invoke(process, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    const rejected = expect(call).rejects.toBeDefined();
    await expect.poll(() => started).toBe(true);
    controller.abort();
    await rejected;
    await expect.poll(() => cancelled).toBe(true);
  });
  it("keeps a started invocation alive while retiring its generation", async () => {
    let finish!: (value: string) => void;
    const { process } = await setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const call = invoke(process);
    await expect.poll(() => typeof finish).toBe("function");
    process.retire();
    expect(process.alive).toBe(true);
    await expect(invoke(process)).rejects.toThrow("卸载");
    finish("old generation finished");
    expect(await call).toMatchObject({ content: [{ text: "old generation finished" }] });
    expect(process.alive).toBe(false);
  });
  it("deadline cancels remote execution and disconnected calls settle", async () => {
    let cancelled = false;
    const { process } = await setup(
      (context) =>
        new Promise((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        }),
    );
    await expect(invoke(process, BACKGROUND_CONTEXT, 30)).rejects.toBeDefined();
    await expect.poll(() => cancelled).toBe(true);
    const pending = invoke(process);
    const rejected = expect(pending).rejects.toBeDefined();
    process.stop();
    await rejected;
  });
});
