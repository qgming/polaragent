import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type MutableReplicatedState, replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type ToolExecutionApi, type ToolHooks } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import type { PluginAgentDescription, PluginAgentService } from "./agent-service";
import { validatePluginManifest } from "./manifest";
import type { PluginProcess } from "./plugin-process";
import { createPluginProcessHost, type PluginProcessSource } from "./process-host";

async function source(): Promise<PluginProcessSource> {
  const dir = path.resolve(import.meta.dirname, "../../../resources/plugins/toolkit");
  const result = validatePluginManifest(
    JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")),
  );
  if (!result.ok) throw new Error("fixture");
  return { id: result.manifest.id, dir, manifest: result.manifest };
}
function process(
  version: string,
  sections: PluginAgentDescription["sections"] = [],
): PluginProcess {
  const service: PluginAgentService = {
    description: replicatedState({
      tools: [{ name: "test", description: version, parameters: { type: "object" } }],
      commands: [],
      sections,
    }),
    async execute() {
      return { content: [{ type: "text", text: version }] };
    },
    async command() {
      return version;
    },
    async beforeTool() {
      return {};
    },
    async afterTool(_call, result) {
      return result;
    },
  };
  return {
    service,
    alive: true,
    invoke: (operation, context) => operation(service, context),
    retire: vi.fn(),
    stop: vi.fn(),
  };
}
describe("native plugin extension publication", () => {
  it("registers real native sections when the source hash begins with a digit", async () => {
    const initial = await source();
    expect(createHash("sha256").update(initial.id).digest("hex")).toMatch(/^[0-9]/);
    const active = process("one", [{ key: "policy", text: "policy text" }]);
    const host = createPluginProcessHost({ start: async () => active });
    const native = createRegistry();
    host.subscribe(() => {
      for (const { extension } of host.extensions()) native.install(extension);
    });
    await host.sync([initial]);
    const extension = host.extensions()[0]?.extension;
    expect(extension?.sections?.[0]?.key).toMatch(/^p_[0-9][a-f0-9]+_policy$/);
    if (!extension) throw new Error("Missing native extension");
    expect(native.snapshot().extension(extension.name)).toBe(extension);
    expect(host.issues()).toEqual([]);
    host.stopAll();
  });
  it.each(["Policy", "1policy", "bad.key", "a b"])(
    "rejects section %s before publication while the previous invocation finishes",
    async (invalidKey) => {
      const initial = await source();
      const active = process("one", [{ key: "policy", text: "working" }]);
      let finish!: () => void;
      active.service.execute = async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { content: [{ type: "text", text: "old completed" }] };
      };
      const candidate = process("two", [{ key: invalidKey, text: "bad" }]);
      const host = createPluginProcessHost({
        start: vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(candidate),
      });
      await host.sync([initial]);
      const previous = host.extensions()[0]?.extension;
      const tool = previous?.tools?.[0];
      if (!previous || !tool) throw new Error("Missing prior native tool");
      const pending = tool.execute(
        {},
        { callId: "c", taskId: "t", conversationId: "s" } as unknown as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      );
      await expect.poll(() => typeof finish).toBe("function");
      await host.sync([
        { ...initial, manifest: { ...initial.manifest, description: "candidate" } },
      ]);
      expect(host.extensions()[0]?.extension).toBe(previous);
      expect(active.retire).not.toHaveBeenCalled();
      expect(active.stop).not.toHaveBeenCalled();
      expect(candidate.stop).toHaveBeenCalledOnce();
      expect(host.issues()).toHaveLength(1);
      finish();
      expect(await pending).toMatchObject({ content: [{ text: "old completed" }] });
      host.stopAll();
    },
  );
  it("retains the previous native definition on invalid descriptor updates without normalizing collisions", async () => {
    const initial = await source();
    const active = process("one", [{ key: "policy", text: "working" }]);
    const host = createPluginProcessHost({ start: async () => active });
    await host.sync([initial]);
    const previous = host.extensions()[0]?.extension;
    if (!previous) throw new Error("Missing prior native extension");
    const state = active.service.description as MutableReplicatedState<PluginAgentDescription>;
    state.change(BACKGROUND_CONTEXT, (draft) => {
      draft.sections = [
        { key: "policy", text: "a" },
        { key: "Policy", text: "b" },
      ];
    });
    await expect.poll(() => host.issues().length).toBe(1);
    expect(host.extensions()[0]?.extension).toBe(previous);
    expect(active.retire).not.toHaveBeenCalled();
    host.stopAll();
  });
  it("shares global process across workspaces and publishes the replacement before retiring its predecessor", async () => {
    const initial = await source();
    const one = process("one");
    const two = process("two");
    const start = vi.fn().mockResolvedValueOnce(one).mockResolvedValueOnce(two);
    const host = createPluginProcessHost({ start });
    one.retire = vi.fn(() => {
      expect(host.extensions("/a")[0]?.extension.tools?.[0]?.description).toBe("two");
    });
    await host.sync([initial], "/a");
    await host.sync([initial], "/b");
    expect(start).toHaveBeenCalledTimes(1);
    expect(host.extensions("/a")[0]?.extension).toBe(host.extensions("/b")[0]?.extension);
    const updated = { ...initial, manifest: { ...initial.manifest, description: "updated" } };
    await host.sync([updated], "/a");
    // The other workspace has the same source identity; source publication updates both views.
    await host.sync([updated], "/b");
    expect(host.extensions("/a")[0]?.extension.tools?.[0]?.description).toBe("two");
    expect(one.retire).toHaveBeenCalledOnce();
    await host.sync([], "/a");
    expect(host.runningCount()).toBe(1);
    await host.sync([], "/b");
    expect(host.runningCount()).toBe(0);
    expect(two.retire).toHaveBeenCalledOnce();
  });
  it("keeps the last working generation if replacement startup fails", async () => {
    const initial = await source();
    const active = process("one");
    const host = createPluginProcessHost({
      start: vi
        .fn()
        .mockResolvedValueOnce(active)
        .mockRejectedValueOnce(new Error("bad candidate")),
    });
    await host.sync([initial]);
    const extension = host.extensions()[0]?.extension;
    await host.sync([{ ...initial, manifest: { ...initial.manifest, description: "changed" } }]);
    expect(host.extensions()[0]?.extension).toBe(extension);
    expect(active.retire).not.toHaveBeenCalled();
    expect(host.issues()[0]?.message).toContain("bad candidate");
    host.stopAll();
  });
  it("keeps a required native policy blocking when its worker cannot start", async () => {
    const initial = await source();
    initial.manifest.hooks = ["beforeTool"];
    initial.manifest.permissions.push("hostHooks.register");
    const host = createPluginProcessHost({
      start: async () => {
        throw new Error("offline");
      },
    });
    await host.sync([initial]);
    const handlers = host.extensions()[0]?.extension.hooks?.[0]?.handlers as ToolHooks;
    expect(
      await handlers.beforeTool(
        { name: "bash", id: "call", type: "toolCall", arguments: {} },
        {} as never,
        BACKGROUND_CONTEXT,
      ),
    ).toMatchObject({ block: expect.stringContaining("offline") });
    host.stopAll();
  });
});
