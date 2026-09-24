/**
 * 插件进程：握手、调用、超时、崩溃。
 *
 * 这一组全部走**注入的假 fork** —— 真起 `utilityProcess` 既慢又没法可靠地
 * 制造"握手超时""调用中途崩溃"这些分支，而它们恰恰是这一层存在的理由。
 *
 * 最要紧的两条：
 *  - **挂起的调用一定会被结算**（崩溃、停用、超时三条路都要结），
 *    否则模型的回合会永远等下去，而用户看到的是"发出去没反应"；
 *  - **环境变量走白名单**：插件进程拿不到宿主的凭据。
 */

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateCommandDecls, validateToolDecls } from "@/shared/contracts/plugin-rpc";
import {
  type ForkPluginProcess,
  type PluginProcessHandle,
  PluginProcessStartError,
  startPluginProcess,
} from "./plugin-process";

/** 假进程：测试拿着它手动投递消息 / 触发退出 */
class FakeProcess implements PluginProcessHandle {
  readonly sent: unknown[] = [];
  killed = false;
  private messageHandler: ((message: unknown) => void) | null = null;
  private exitHandler: ((code: number) => void) | null = null;

  /**
   * 收到第一条消息（也就是握手 init）时兑现。
   *
   * **这是测试唯一可靠的同步点。** `startPluginProcess` 在 fork 之前要 await 两次
   * realpath（真实文件系统 I/O），而"让出几轮事件循环"是不能确定跨过 I/O 回调的
   *（`setTimeout(0)` 走 timers 阶段，可能排在 poll 阶段的 I/O 回调**之前**）。
   * 用时间猜会让测试变成偶发失败，而失败信息（"没有完成握手"）看起来像实现有问题。
   *
   * 实现里 handler 的注册在 postMessage 之前，所以"收到了 init"蕴含"监听器已挂上"。
   */
  readonly posted: Promise<void>;
  private markPosted: () => void = () => {};

  constructor() {
    this.posted = new Promise((resolve) => {
      this.markPosted = resolve;
    });
  }

  postMessage(message: unknown): void {
    this.sent.push(message);
    this.markPosted();
  }
  onMessage(handler: (message: unknown) => void): () => void {
    this.messageHandler = handler;
    return () => {
      this.messageHandler = null;
    };
  }
  onExit(handler: (code: number) => void): () => void {
    this.exitHandler = handler;
    return () => {
      this.exitHandler = null;
    };
  }
  kill(): void {
    this.killed = true;
  }

  /** 模拟插件发来一条消息 */
  emit(message: unknown): void {
    this.messageHandler?.(message);
  }
  /** 模拟插件进程退出 */
  exit(code: number): void {
    this.exitHandler?.(code);
    this.exitHandler = null;
  }
  /** postMessage 里最后一条 init（握手参数） */
  get init(): Record<string, unknown> | undefined {
    return this.sent[0] as Record<string, unknown> | undefined;
  }
  /** 发出去的全部 call */
  get calls(): Record<string, unknown>[] {
    return this.sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string }).type === "call",
    );
  }
}

let pluginDir: string;

beforeEach(async () => {
  pluginDir = await mkdtemp(path.join(tmpdir(), "oint-plugin-proc-"));
  await writeFile(path.join(pluginDir, "main.js"), "// 假入口", "utf8");
});

afterEach(async () => {
  await rm(pluginDir, { recursive: true, force: true });
});

/** 起一个进程，返回句柄与假进程；`ready` 决定它回不回握手 */
async function start(
  ready: boolean | Record<string, unknown> = true,
  overrides: Partial<Parameters<typeof startPluginProcess>[0]> = {},
): Promise<{ proc: Awaited<ReturnType<typeof startPluginProcess>>; fake: FakeProcess }> {
  const fake = new FakeProcess();
  const fork: ForkPluginProcess = () => fake;

  const promise = startPluginProcess({
    pluginId: "dev.example.demo",
    pluginDir,
    entry: "./main.js",
    permissions: ["agent.tool.register"],
    dataDir: path.join(pluginDir, "data"),
    fork,
    handshakeTimeoutMs: 50,
    callTimeoutMs: 50,
    ...overrides,
  });

  if (ready !== false) {
    // 让 startPluginProcess 先把 init 发出去，再模拟插件应答
    await fake.posted;
    fake.emit({
      type: "ready",
      v: 1,
      tools: [{ name: "echo", description: "回显", parameters: { type: "object" } }],
      commands: [{ name: "hello", description: "打个招呼" }],
      ...(typeof ready === "object" ? ready : {}),
    });
  }

  return { proc: await promise, fake };
}

describe("握手", () => {
  it("成功后工具与命令都可读", async () => {
    const { proc } = await start();
    expect(proc.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(proc.commands.map((command) => command.name)).toEqual(["hello"]);
    expect(proc.alive).toBe(true);
  });

  it("init 里带上插件身份、权限与目录", async () => {
    const { fake } = await start();
    expect(fake.init).toMatchObject({
      type: "init",
      v: 1,
      pluginId: "dev.example.demo",
      permissions: ["agent.tool.register"],
    });
  });

  it("**环境变量走白名单**：插件进程拿不到宿主的凭据", async () => {
    // 这一条与 P0 缺口三是同一份 buildChildEnv —— 插件进程是又一条"外部代码"路径
    const previous = process.env.OINT_TEST_SECRET;
    process.env.OINT_TEST_SECRET = "sk-should-not-leak";
    process.env.PATH = process.env.PATH ?? "/usr/bin";
    try {
      const fake = new FakeProcess();
      let captured: NodeJS.ProcessEnv = {};
      const promise = startPluginProcess({
        pluginId: "dev.example.demo",
        pluginDir,
        entry: "./main.js",
        permissions: [],
        dataDir: pluginDir,
        fork: (_entry, options) => {
          captured = options.env;
          return fake;
        },
        handshakeTimeoutMs: 50,
      });
      await fake.posted;
      fake.emit({ type: "ready", v: 1, tools: [], commands: [] });
      await promise;

      expect(captured.OINT_TEST_SECRET).toBeUndefined();
      // 工具链变量必须在，否则插件连 require 都跑不动
      expect(captured.PATH).toBeDefined();
      // 宿主显式注入的两项在
      expect(captured.OINT_PLUGIN_ID).toBe("dev.example.demo");
    } finally {
      if (previous === undefined) delete process.env.OINT_TEST_SECRET;
      else process.env.OINT_TEST_SECRET = previous;
    }
  });

  it("cwd 是插件目录（插件按包内相对路径 require 自己的模块）", async () => {
    const fake = new FakeProcess();
    let capturedCwd = "";
    const promise = startPluginProcess({
      pluginId: "dev.example.demo",
      pluginDir,
      entry: "./main.js",
      permissions: [],
      dataDir: pluginDir,
      fork: (_entry, options) => {
        capturedCwd = options.cwd;
        return fake;
      },
      handshakeTimeoutMs: 50,
    });
    await fake.posted;
    fake.emit({ type: "ready", v: 1, tools: [], commands: [] });
    await promise;
    expect(capturedCwd).toBe(pluginDir);
  });

  it("握手超时 → 抛可读错误，并且进程被停掉", async () => {
    const fake = new FakeProcess();
    await expect(
      startPluginProcess({
        pluginId: "dev.example.demo",
        pluginDir,
        entry: "./main.js",
        permissions: [],
        dataDir: pluginDir,
        fork: () => fake,
        handshakeTimeoutMs: 20,
      }),
    ).rejects.toThrow(/没有完成握手/);
    // 超时之后必须杀掉：留着一个永远不握手的进程只会白占资源
    expect(fake.killed).toBe(true);
  });

  it("**握手前就退出** → 把退出码报出来（那是作者最需要的线索）", async () => {
    const fake = new FakeProcess();
    const promise = startPluginProcess({
      pluginId: "dev.example.demo",
      pluginDir,
      entry: "./main.js",
      permissions: [],
      dataDir: pluginDir,
      fork: () => fake,
      handshakeTimeoutMs: 1000,
    });
    await fake.posted;
    fake.exit(3);

    await expect(promise).rejects.toThrow(/退出码 3/);
  });

  it("RPC 版本不匹配 → 拒绝（不按旧版解释）", async () => {
    const fake = new FakeProcess();
    const promise = startPluginProcess({
      pluginId: "dev.example.demo",
      pluginDir,
      entry: "./main.js",
      permissions: [],
      dataDir: pluginDir,
      fork: () => fake,
      handshakeTimeoutMs: 100,
    });
    await fake.posted;
    fake.emit({ type: "ready", v: 999, tools: [], commands: [] });

    await expect(promise).rejects.toThrow(/版本不匹配/);
  });

  it("**声明不合法就整个拒绝启动**，并逐条报出问题", async () => {
    const fake = new FakeProcess();
    const promise = startPluginProcess({
      pluginId: "dev.example.demo",
      pluginDir,
      entry: "./main.js",
      permissions: [],
      dataDir: pluginDir,
      fork: () => fake,
      handshakeTimeoutMs: 100,
    });
    await fake.posted;
    fake.emit({
      type: "ready",
      v: 1,
      // 名字非法 + 缺说明：两条都要报出来
      tools: [
        { name: "1bad", description: "x", parameters: { type: "object" } },
        { name: "noDesc" },
      ],
      commands: [],
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginProcessStartError);
    expect((error as PluginProcessStartError).issues.length).toBeGreaterThanOrEqual(2);
    // 静默跳过会让作者以为自己注册成功了 —— 所以必须是拒绝
    expect(fake.killed).toBe(true);
  });

  it("入口跑出插件目录 → 拒绝", async () => {
    await expect(
      startPluginProcess({
        pluginId: "dev.example.demo",
        pluginDir,
        entry: "./../outside.js",
        permissions: [],
        dataDir: pluginDir,
        fork: () => new FakeProcess(),
      }),
    ).rejects.toThrow(/跑出了插件目录/);
  });

  it("**符号链接指向插件目录外**也拒绝（纯字符串检查挡不住这个）", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "oint-outside-"));
    try {
      await writeFile(path.join(outside, "evil.js"), "// 外面的代码", "utf8");
      await symlink(path.join(outside, "evil.js"), path.join(pluginDir, "link.js"));
      await expect(
        startPluginProcess({
          pluginId: "dev.example.demo",
          pluginDir,
          entry: "./link.js",
          permissions: [],
          dataDir: pluginDir,
          fork: () => new FakeProcess(),
        }),
      ).rejects.toThrow(/跑出了插件目录/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("调用", () => {
  it("往返：宿主发 call，插件回 result", async () => {
    const { proc, fake } = await start();
    const promise = proc.call("echo", { value: 1 }, pluginDir);

    await fake.posted;
    const sent = fake.calls[0];
    expect(sent).toMatchObject({ type: "call", tool: "echo", args: { value: 1 } });
    fake.emit({ type: "result", id: sent?.id, text: "hello" });

    expect(await promise).toEqual({ ok: true, text: "hello" });
  });

  it("插件报错 → ok:false 带可读原因（**不抛异常**：调用方是模型工具层）", async () => {
    const { proc, fake } = await start();
    const promise = proc.call("echo", {}, pluginDir);
    await fake.posted;
    fake.emit({ type: "result", id: fake.calls[0]?.id, error: "仓库不存在" });

    expect(await promise).toEqual({ ok: false, error: "仓库不存在" });
  });

  it("**调用超时会被结算** —— 否则模型的回合会永远等下去", async () => {
    const { proc } = await start();
    // 插件对这次调用不作任何应答
    const result = await proc.call("echo", {}, pluginDir);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/没有返回结果/);
  });

  it("**调用中途崩溃：全部挂起的调用都被结算**", async () => {
    const { proc, fake } = await start();
    const first = proc.call("echo", {}, pluginDir);
    const second = proc.call("echo", {}, pluginDir);
    await fake.posted;

    fake.exit(1);

    expect(await first).toEqual({ ok: false, error: expect.stringContaining("已退出") });
    expect(await second).toEqual({ ok: false, error: expect.stringContaining("已退出") });
    expect(proc.alive).toBe(false);
    expect(proc.exitCode).toBe(1);
  });

  it("迟到很久的应答不会污染后面的调用（id 各归各的）", async () => {
    const { proc, fake } = await start();
    const first = proc.call("echo", {}, pluginDir);
    await fake.posted;
    const firstId = fake.calls[0]?.id;

    const second = proc.call("echo", {}, pluginDir);
    await fake.posted;
    const secondId = fake.calls[1]?.id;

    // 先回第二个，再回第一个
    fake.emit({ type: "result", id: secondId, text: "second" });
    fake.emit({ type: "result", id: firstId, text: "first" });

    expect(await second).toEqual({ ok: true, text: "second" });
    expect(await first).toEqual({ ok: true, text: "first" });
  });

  it("stop() 之后调用直接失败，不再发消息", async () => {
    const { proc, fake } = await start();
    proc.stop();
    expect(fake.killed).toBe(true);

    const before = fake.sent.length;
    const result = await proc.call("echo", {}, pluginDir);
    expect(result.ok).toBe(false);
    expect(fake.sent.length).toBe(before);
  });

  it("stop() 是幂等的（停用路径可能重复调用）", async () => {
    const { proc } = await start();
    proc.stop();
    expect(() => proc.stop()).not.toThrow();
  });

  it("stop() 结算挂起的调用", async () => {
    const { proc } = await start();
    const pending = proc.call("echo", {}, pluginDir);
    proc.stop();
    expect(await pending).toEqual({ ok: false, error: "插件已停用" });
  });

  it("插件的日志走 onLog，不进调用结果", async () => {
    const onLog = vi.fn();
    const { fake } = await start(true, { onLog });
    fake.emit({ type: "log", level: "warn", message: "注意" });
    expect(onLog).toHaveBeenCalledWith("warn", "注意");
  });
});

describe("validateToolDecls", () => {
  const ok = { name: "echo", description: "回显", parameters: { type: "object" } };

  it("合法声明通过", () => {
    expect(validateToolDecls([ok])).toEqual({ tools: [ok], issues: [] });
  });

  it.each([
    ["名字以数字开头", { ...ok, name: "1bad" }],
    ["名字含空格", { ...ok, name: "a b" }],
    ["缺说明", { name: "x", parameters: { type: "object" } }],
    ["说明是空白", { ...ok, description: "   " }],
    ["parameters 不是对象", { ...ok, parameters: [] }],
    ["parameters 顶层不是 object", { ...ok, parameters: { type: "array" } }],
  ])("%s → 报问题", (_label, decl) => {
    const result = validateToolDecls([decl]);
    expect(result.tools).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("名字重复 → 报问题（否则后者会静默顶掉前者）", () => {
    expect(validateToolDecls([ok, ok]).issues.join()).toContain("重复");
  });

  it("说明过长 → 报问题（它每个请求都进模型上下文）", () => {
    const result = validateToolDecls([{ ...ok, description: "x".repeat(3000) }]);
    expect(result.issues.join()).toContain("说明超过");
  });

  it("schema 过大 → 报问题", () => {
    const result = validateToolDecls([
      { ...ok, parameters: { type: "object", padding: "x".repeat(9000) } },
    ]);
    expect(result.issues.join()).toContain("schema");
  });

  it("数量超限 → 报问题，并且只收前 N 个", () => {
    const many = Array.from({ length: 40 }, (_value, index) => ({ ...ok, name: `t${index}` }));
    const result = validateToolDecls(many);
    expect(result.issues.join()).toContain("最多注册");
    expect(result.tools.length).toBeLessThanOrEqual(32);
  });

  it("非数组 → 报问题", () => {
    expect(validateToolDecls("nope").issues.length).toBeGreaterThan(0);
  });
});

describe("validateCommandDecls", () => {
  it("合法声明通过", () => {
    const ok = { name: "hello", description: "打个招呼" };
    expect(validateCommandDecls([ok])).toEqual({ commands: [ok], issues: [] });
  });

  it("名字非法 / 缺说明 / 重复都报问题", () => {
    expect(validateCommandDecls([{ name: "1bad", description: "x" }]).issues.length).toBe(1);
    expect(validateCommandDecls([{ name: "ok" }]).issues.length).toBe(1);
    expect(
      validateCommandDecls([
        { name: "a", description: "x" },
        { name: "a", description: "y" },
      ]).issues.join(),
    ).toContain("重复");
  });
});

/**
 * 钩子：声明与实现的对账 + 跨进程的一次调用。
 *
 * 这一组钉的是两类**真实故障**，它们的现象完全不同：
 *  - 声明了、代码没实现 → 宿主照常调用，每次都失败，而 fail-closed 的
 *    `PreToolUse` 会把每一次工具调用都拦下（用户会以为工具全坏了）；
 *  - 实现了、清单没声明 → 那一段代码永远不会被调用，而作者以为策略生效了。
 */
describe("钩子", () => {
  const DECL = { id: "guard", event: "PreToolUse" as const };

  it("声明与实现一致时启动成功", async () => {
    const { proc } = await start({ hooks: ["guard"] } satisfies Record<string, unknown>, {
      hooks: [DECL],
    });
    expect(proc.alive).toBe(true);
  });

  /** 断言启动失败，并在**逐条明细**里找那句话（标题是笼统的，细节在 issues 里） */
  async function expectStartIssues(
    ready: Record<string, unknown>,
    options: Partial<Parameters<typeof startPluginProcess>[0]>,
    expected: RegExp,
  ): Promise<void> {
    try {
      await start(ready, options);
      throw new Error("本该校验失败");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginProcessStartError);
      const issues = (error as PluginProcessStartError).issues.join("\n");
      expect(issues).toMatch(expected);
    }
  }

  it("**声明了但没实现 → 拒绝启动**，理由点名是哪个钩子", async () => {
    await expectStartIssues({ hooks: [] }, { hooks: [DECL] }, /清单声明了钩子「guard」/);
  });

  it("**实现了但没声明 → 拒绝启动**（那段代码永远不会被调用）", async () => {
    await expectStartIssues({ hooks: ["ghost"] }, { hooks: [] }, /未声明的钩子「ghost」/);
  });

  it("一次钩子调用把 id / 事件 / payload 送出去，并带回结论", async () => {
    const { proc, fake } = await start({ hooks: ["guard"] } satisfies Record<string, unknown>, {
      hooks: [DECL],
    });

    const pending = proc.hook("guard", "PreToolUse", {
      toolName: "bash",
      args: { command: "rm -rf /" },
      workspaceDir: "/repo",
    });
    const sent = fake.sent.at(-1) as Record<string, unknown>;
    expect(sent.type).toBe("hook");
    expect(sent.hook).toBe("guard");
    expect(sent.event).toBe("PreToolUse");
    expect((sent.payload as { toolName: string }).toolName).toBe("bash");

    fake.emit({ type: "hookResult", id: sent.id, block: "本插件禁用 bash" });
    await expect(pending).resolves.toEqual({ block: "本插件禁用 bash" });
  });

  it("插件回错误 = 失败（调用方按 failure 策略处置）", async () => {
    const { proc, fake } = await start({ hooks: ["guard"] } satisfies Record<string, unknown>, {
      hooks: [DECL],
    });
    const pending = proc.hook("guard", "PreToolUse", {
      toolName: "bash",
      args: {},
      workspaceDir: "/repo",
    });
    const sent = fake.sent.at(-1) as Record<string, unknown>;
    fake.emit({ type: "hookResult", id: sent.id, error: "我不认识这个 id" });
    await expect(pending).resolves.toEqual({ failure: "我不认识这个 id" });
  });

  it("回调形状不对也算失败（回了一个 result 而不是 hookResult）", async () => {
    const { proc, fake } = await start({ hooks: ["guard"] } satisfies Record<string, unknown>, {
      hooks: [DECL],
    });
    const pending = proc.hook("guard", "PreToolUse", {
      toolName: "bash",
      args: {},
      workspaceDir: "/repo",
    });
    const sent = fake.sent.at(-1) as Record<string, unknown>;
    fake.emit({ type: "result", id: sent.id, text: "跑错通道了" });
    await expect(pending).resolves.toEqual({ failure: "插件返回了类型不对的应答" });
  });

  it("超时按失败结算，不是永远等下去", async () => {
    const { proc } = await start({ hooks: ["guard"] } satisfies Record<string, unknown>, {
      hooks: [DECL],
      hookTimeoutMs: 20,
    });
    const outcome = await proc.hook("guard", "PreToolUse", {
      toolName: "bash",
      args: {},
      workspaceDir: "/repo",
    });
    expect(outcome.failure).toContain("20ms");
  });

  it("钩子还在途、进程崩了 —— 也要结算（否则工具调用永远卡住）", async () => {
    const { proc, fake } = await start({ hooks: ["guard"] } satisfies Record<string, unknown>, {
      hooks: [DECL],
    });
    const pending = proc.hook("guard", "PreToolUse", {
      toolName: "bash",
      args: {},
      workspaceDir: "/repo",
    });
    fake.exit(1);
    const outcome = await pending;
    expect(outcome.failure).toContain("已退出");
  });
});
