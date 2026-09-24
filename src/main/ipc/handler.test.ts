/**
 * IPC 处理器包装。
 *
 * 这一组存在的理由很具体：**`handle` 不把 `IpcMainInvokeEvent` 传给回调，而写错了
 * 不会报类型错**（`TArgs` 是从回调反推的）。踩过一次，代价是整座插件界面桥静默失效 ——
 * 存储、通知、剪贴板、执行命令全部不可用，而报错是
 * `Cannot read properties of undefined (reading 'id')`，完全不指向原因。
 *
 * 所以这里把两个函数的**参数契约**各钉一条：
 *  - `handle`：回调**收不到** event（第一条载荷就是第一个参数）；
 *  - `handleWithEvent`：回调**第一个参数就是** event。
 *
 * 任何一边被改动（比如有人"顺手"让 `handle` 也传 event），都会在这里变红。
 */

import { ipcMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle, handleWithEvent } from "./handler";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

/** 取出最后一次注册的包装函数 */
function registered(): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const call = vi.mocked(ipcMain.handle).mock.calls.at(-1);
  if (call === undefined) throw new Error("没有注册任何处理器");
  return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

/** 假装是 Electron 传进来的那个事件对象 */
const EVENT = { sender: { id: 42 } };

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("handle", () => {
  it("**回调收不到 event** —— 第一个参数就是第一条载荷", async () => {
    const received: unknown[] = [];
    handle("test:plain", "测试", async (...args: unknown[]) => {
      received.push(...args);
      return null;
    });

    await registered()(EVENT, "载荷一", "载荷二");
    // event 被丢掉了：这正是那个坑，与 ipc/surface.ts 当初写错时一模一样
    expect(received).toEqual(["载荷一", "载荷二"]);
  });

  it("异常被包成「动作失败：原因」", async () => {
    handle("test:throw", "读取插件列表", async () => {
      throw new Error("底层炸了");
    });

    await expect(registered()(EVENT)).rejects.toThrow("读取插件列表失败：底层炸了");
  });

  it("非 Error 的抛出也能包（String(error) 兜底）", async () => {
    handle("test:throwString", "执行", async () => {
      throw "一个字符串";
    });

    await expect(registered()(EVENT)).rejects.toThrow("执行失败：一个字符串");
  });

  it("正常返回值原样透传", async () => {
    handle("test:ok", "测试", async (value: number) => value * 2);
    expect(await registered()(EVENT, 21)).toBe(42);
  });
});

describe("handleWithEvent", () => {
  it("**回调第一个参数就是 event**", async () => {
    let seen: unknown;
    handleWithEvent("test:event", "测试", async (event) => {
      seen = event;
      return null;
    });

    await registered()(EVENT, "载荷");
    // 插件界面桥靠这个 event 查归属表确认"你是谁"，拿不到就等于没有身份
    expect(seen).toBe(EVENT);
  });

  it("载荷按顺序跟在 event 后面", async () => {
    const received: unknown[] = [];
    handleWithEvent("test:eventArgs", "测试", async (event, ...args: unknown[]) => {
      received.push(event, ...args);
      return null;
    });

    await registered()(EVENT, "命令", ["--version"], { cwd: "/tmp" });
    expect(received).toEqual([EVENT, "命令", ["--version"], { cwd: "/tmp" }]);
  });

  it("异常包裹与 handle 一致", async () => {
    handleWithEvent("test:eventThrow", "插件界面执行命令", async () => {
      throw new Error("Cannot read properties of undefined (reading 'id')");
    });

    await expect(registered()(EVENT)).rejects.toThrow(
      "插件界面执行命令失败：Cannot read properties of undefined (reading 'id')",
    );
  });
});
