import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@/shared/contracts/ipc";
import type { PluginRegistry } from "./registry";

type Handler = (...args: unknown[]) => unknown;
interface TestSession {
  protocol: { handle: (scheme: string, handler: (request: Request) => Promise<Response>) => void };
  request?: (request: Request) => Promise<Response>;
  setPermissionRequestHandler: () => void;
  setPermissionCheckHandler: () => void;
}
const state = vi.hoisted(() => ({
  registry: undefined as PluginRegistry | undefined,
  handlers: new Map<string, Handler>(),
  sessions: new Map<string, TestSession>(),
  contents: new Map<number, unknown>(),
  exec: vi.fn(async (options: unknown) => options),
  sent: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: state.sent } }],
  },
  session: {
    fromPartition: (partition: string) => {
      let target = state.sessions.get(partition);
      if (!target) {
        target = {
          protocol: {
            handle(_scheme, handler) {
              if (target) target.request = handler;
            },
          },
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
        };
        state.sessions.set(partition, target);
      }
      return target;
    },
  },
  webContents: { fromId: (id: number) => state.contents.get(id) },
  protocol: {},
  dialog: {},
  nativeTheme: {},
  shell: {},
}));
vi.mock("@/main/ipc/handler", () => ({
  handle: (channel: string, _label: string, handler: Handler) =>
    state.handlers.set(channel, handler),
  handleWithEvent: (channel: string, _label: string, handler: Handler) =>
    state.handlers.set(channel, handler),
}));
vi.mock("./registry", async (original) => ({
  ...(await original<typeof import("./registry")>()),
  getPluginRegistry: () => {
    if (!state.registry) throw new Error("Registry fixture missing");
    return state.registry;
  },
}));
vi.mock("./surface-exec", () => ({ execForPlugin: state.exec }));

import { registerPluginsIpc } from "@/main/ipc/plugins";
import { registerSurfaceIpc } from "@/main/ipc/surface";
import { createPluginRegistry } from "./registry";
import { getSurfaceOwners } from "./surface-owners";
import { claimSurfaceBySession, preparePluginPartitions } from "./surfaces";

let root: string;
let a: string;
let b: string;
const metadata = (name: string) => ({
  name,
  version: "1.0.0",
  oint: {
    permissions: ["ui.panel", "shell.exec"],
    shell: { exec: ["git"] },
    surfaces: [{ id: "panel", kind: "panel", title: name, entry: "./ui/index.html" }],
  },
});
async function write(dir: string, id: string, html: string): Promise<void> {
  await mkdir(path.join(dir, "ui"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(metadata(id)));
  await writeFile(path.join(dir, "ui/index.html"), html);
}
function registry(): PluginRegistry {
  if (!state.registry) throw new Error("Missing registry");
  return state.registry;
}
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  return Promise.resolve(handler(...args));
}
function guest(id: number, pluginId: string) {
  const surface = registry().find(pluginId)?.surfaces[0];
  if (!surface) throw new Error("Missing surface");
  const target = state.sessions.get(surface.partition);
  if (!target) throw new Error("Missing partition");
  let destroyed = false;
  const contents = {
    id,
    session: target,
    getURL: () => surface.url,
    on() {},
    isDestroyed: () => destroyed,
    close: vi.fn(() => {
      destroyed = true;
      return registry().getWorkspaceDir();
    }),
  };
  state.contents.set(id, contents);
  expect(claimSurfaceBySession(contents as unknown as WebContents)).toBe(true);
  return {
    contents,
    partition: surface.partition,
    event: { sender: { id } },
    async read(): Promise<Response> {
      if (!target.request) throw new Error("Missing protocol handler");
      return target.request(new Request(surface.url));
    },
  };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oint-surface-scope-"));
  a = path.join(root, "a");
  b = path.join(root, "b");
  state.handlers.clear();
  state.sessions.clear();
  state.contents.clear();
  state.exec.mockClear();
  state.sent.mockClear();
  for (const [id] of getSurfaceOwners().entries()) getSurfaceOwners().release(id);
  await write(path.join(a, ".oint/plugins/shared"), "project-shared", "A");
  await write(path.join(b, ".oint/plugins/shared"), "project-shared", "B");
  await write(path.join(root, "resources/plugins/git"), "global-git", "GLOBAL");
  state.registry = createPluginRegistry({ dataDir: root, appPath: root });
  registry().setWorkspaceDir(a);
  await registry().reload();
  await registry().setEnabled("project-shared", true);
  preparePluginPartitions(
    registry()
      .enabledSources()
      .map((source) => source.id),
  );
  registerPluginsIpc();
  registerSurfaceIpc();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("project surface authority across workspace switch", () => {
  it("denies disabled global guest capabilities even while its owner is still registered", async () => {
    const granted = metadata("global-git");
    await writeFile(
      path.join(root, "resources/plugins/git/package.json"),
      JSON.stringify({
        ...granted,
        oint: {
          ...granted.oint,
          permissions: [...granted.oint.permissions, "storage", "clipboard.write", "net.fetch"],
          net: { domains: ["example.com"] },
        },
      }),
    );
    await registry().reload();
    const global = guest(2, "global-git");
    expect(getSurfaceOwners().ownerOf(2)).toBeDefined();
    await registry().setEnabled("global-git", false);
    await expect(invoke(IPC.surface.storageGet, global.event, "note")).rejects.toThrow("没有申请");
    await expect(invoke(IPC.surface.writeText, global.event, "clipboard")).rejects.toThrow(
      "没有申请",
    );
    await expect(
      invoke(IPC.surface.fetch, global.event, "https://example.com", {}),
    ).rejects.toThrow("没有申请");
    expect(getSurfaceOwners().ownerOf(2)).toBeDefined();
  });
  it("revokes A before cwd changes and never lets its guest adopt the same-id package in B", async () => {
    const old = guest(1, "project-shared");
    const global = guest(2, "global-git");
    const oldOwner = getSurfaceOwners().ownerOf(1);
    expect(await (await old.read()).text()).toBe("A");
    await invoke(IPC.surface.exec, old.event, "git", ["status"], {});
    expect(state.exec.mock.lastCall?.[0]).toMatchObject({ cwd: a });
    await invoke(IPC.plugins.setWorkspace, b);
    expect(old.contents.close.mock.results[0]?.value).toBe(a);
    expect(getSurfaceOwners().ownerOf(1)).toBeUndefined();
    expect(getSurfaceOwners().ownerOf(2)).toBeDefined();
    await expect(invoke(IPC.surface.exec, old.event, "git", [], {})).rejects.toThrow();
    expect((await old.read()).status).toBe(403);
    await registry().reload();
    preparePluginPartitions(
      registry()
        .enabledSources()
        .map((source) => source.id),
    );
    expect((await old.read()).status).toBe(403);
    // Source checks also reject a stale owner reference even if it survived external UI cleanup.
    if (!oldOwner) throw new Error("Missing old owner");
    getSurfaceOwners().claim(1, oldOwner);
    await expect(invoke(IPC.surface.workspace, old.event)).rejects.toThrow();
    const current = guest(3, "project-shared");
    expect(current.partition).not.toBe(old.partition);
    expect(await (await current.read()).text()).toBe("B");
    await invoke(IPC.surface.exec, current.event, "git", [], {});
    expect(state.exec.mock.lastCall?.[0]).toMatchObject({ cwd: b });
    await invoke(IPC.surface.exec, global.event, "git", [], {});
    expect(state.exec.mock.lastCall?.[0]).toMatchObject({ cwd: b });
    expect(global.contents.close).not.toHaveBeenCalled();
    expect(await (await global.read()).text()).toBe("GLOBAL");
  });
  it("rechecks an IPC call that yielded before the project was revoked", async () => {
    const old = guest(1, "project-shared");
    const pending = invoke(IPC.surface.exec, old.event, "git", [], {});
    const rejection = expect(pending).rejects.toThrow();
    await invoke(IPC.plugins.setWorkspace, b);
    await rejection;
    expect(state.exec).not.toHaveBeenCalled();
  });
});
