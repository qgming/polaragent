/**
 * 插件进程池的调度与权限门槛。
 *
 * 这一组最重要的是一条**否定性断言**：没申请 `agent.tool.register` 的插件，
 * 它的工具**不进模型工具表**。进程照跑（它可能有命令），但工具那一栏是空的。
 *
 * 与 MCP 那边"没申请权限的 server 不装载"是同一条纪律：**能力由清单授予，
 * 不由"代码里写了什么"决定**。插件在自己的 ready 消息里声明十个工具，
 * 而宿主只看它有没有那个权限。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OintPluginManifest } from "@/shared/contracts/plugin";
import type { PluginProcessHandle } from "./plugin-process";
import { createPluginProcessHost, pluginGatewayName, pluginToolKey } from "./process-host";
import { PLUGIN_CATALOG_TOOL_NAME } from "./tools/plugin-catalog";

/** 假进程：可手动应答，也能看它收到了什么 */
class FakeProcess implements PluginProcessHandle {
  readonly sent: unknown[] = [];
  killed = false;
  private messageHandler: ((message: unknown) => void) | null = null;
  /** 接口要求，但这一组用例不驱动退出（退出路径在 plugin-process.test.ts 里测） */
  private exitHandler: ((code: number) => void) | null = null;

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

  /** 触发退出（这一组用例用不到，但接口要求实现它） */
  exit(code: number): void {
    this.exitHandler?.(code);
  }
  kill(): void {
    this.killed = true;
  }
  emit(message: unknown): void {
    this.messageHandler?.(message);
  }
  private of(type: string): Record<string, unknown>[] {
    return this.sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string }).type === type,
    );
  }
  /** 工具调用 */
  get calls(): Record<string, unknown>[] {
    return this.of("call");
  }
  /** 命令执行 */
  get runs(): Record<string, unknown>[] {
    return this.of("run");
  }
}

let pluginRoot: string;
/**
 * 每次 fork 造一个新的假进程，按入口路径索引。
 *
 * ⚠️ **键必须归一大小写**：`startPluginProcess` 传给 fork 的是 `resolveRealPath` 的结果，
 * 而它过了一遍 `normalizePath`（**会把盘符小写化**）。用原始路径查表在 Windows 上
 * 永远查不到 —— 而症状是"等不到进程"，看起来像 fork 没被调用。
 */
const fakeKey = (entry: string): string => path.resolve(entry).toLowerCase();
let fakes: Map<string, FakeProcess>;

beforeEach(async () => {
  pluginRoot = await mkdtemp(path.join(tmpdir(), "oint-host-"));
  fakes = new Map();
});

afterEach(async () => {
  await rm(pluginRoot, { recursive: true, force: true });
});

/**
 * 工具执行的 context。
 *
 * 插件工具的 execute 只读 `context.env.cwd`，而 `ExecutionEnv` 有二十来个方法 ——
 * 造一个完整的假实现等于把内核的接口抄一遍，而那抄本会随内核升级而过期。
 * 所以显式断言到最小形状：**这是一处刻意的窄化，不是"没管类型"**。
 */
function toolContext(cwd: string): never {
  return { env: { cwd } } as never;
}

/** 造一个插件目录（含 main.js），返回它的来源描述 */
async function makeSource(
  id: string,
  permissions: string[],
  /** `main: null` = **不要** main 字段（`undefined` 走默认值，两者不是一回事） */
  options: { main?: string | null; hooks?: OintPluginManifest["hooks"] } = {},
): Promise<{ id: string; dir: string; manifest: OintPluginManifest }> {
  const dir = path.join(pluginRoot, pluginToolKey(id));
  await writeFile(path.join(pluginRoot, `${pluginToolKey(id)}.keep`), "", "utf8").catch(() => {});
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "main.js"), "// 假入口", "utf8");

  const manifest: OintPluginManifest = {
    name: pluginToolKey(id),
    version: "1.0.0",
    description: "",
    id,
    apiVersion: "1",
    permissions: permissions as OintPluginManifest["permissions"],
    surfaces: [],
    hooks: options.hooks ?? [],
    ...(options.main === null ? {} : { main: options.main ?? "./main.js" }),
  };
  return { id, dir, manifest };
}

/** 起一个池；`fork` 为每个入口造一个假进程并记下来 */
function makeHost(): ReturnType<typeof createPluginProcessHost> {
  return createPluginProcessHost({
    fork: (entry) => {
      const fake = new FakeProcess();
      fakes.set(fakeKey(entry), fake);
      return fake;
    },
    handshakeTimeoutMs: 200,
    callTimeoutMs: 200,
  });
}

/**
 * 等某个插件的假进程被建出来。
 *
 * **不能假设 `host.sync(...)` 一调用就 fork 了**：它内部要先 await 两次 realpath
 *（真 I/O）才轮到 `fork`。这是个有界轮询而不是定时等待 —— 条件一到就走，
 * 上限只是防止实现坏掉时挂死。
 */
async function waitForFake(dir: string): Promise<FakeProcess> {
  const entry = fakeKey(path.join(dir, "main.js"));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const fake = fakes.get(entry);
    if (fake !== undefined) return fake;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等不到 ${dir} 的进程`);
}

/**
 * 只看**插件自己的**工具，滤掉目录工具。
 *
 * 目录工具（`plugin_tools`）是宿主内置的，与"某个插件注册了什么"无关 ——
 * 它的存在有单独的用例盯着。
 */
function pluginOnly(host: ReturnType<typeof createPluginProcessHost>) {
  return host.tools().filter((tool) => tool.name !== PLUGIN_CATALOG_TOOL_NAME);
}

/** 让某个插件的假进程完成握手 */
async function readyWith(
  dir: string,
  tools: string[],
  commands: string[] = [],
  hooks: string[] = [],
): Promise<void> {
  const fake = await waitForFake(dir);
  await fake.posted;
  fake.emit({
    type: "ready",
    v: 1,
    hooks,
    tools: tools.map((name) => ({
      name,
      description: `${name} 的说明`,
      parameters: { type: "object" },
    })),
    commands: commands.map((name) => ({ name, description: `${name} 的说明` })),
  });
  // 让 sync 里的 await 走完
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("起不起进程", () => {
  it("声明了 main + agent.tool.register → 起进程", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.a", ["agent.tool.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, ["echo"]);
    await sync;

    expect(host.runningCount()).toBe(1);
    expect(pluginOnly(host).map((tool) => tool.name)).toEqual([pluginGatewayName("dev.example.a")]);
  });

  it("**没有 main 就不起进程** —— 纯声明式插件一个进程都不该有", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.b", ["agent.tool.register"], { main: null });
    await host.sync([source]);

    expect(host.runningCount()).toBe(0);
    expect(fakes.size).toBe(0);
    expect(host.tools()).toEqual([]);
  });

  it("**声明了 main 但一个能力都没申请 → 不起进程**（多一个进程就是多一份攻击面）", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.c", ["ui.panel"]);
    await host.sync([source]);

    expect(host.runningCount()).toBe(0);
    expect(fakes.size).toBe(0);
  });

  it("只申请 commands.register 也会起进程（命令在 ready 里声明）", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.d", ["commands.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, [], ["hello"]);
    await sync;

    expect(host.runningCount()).toBe(1);
    expect(host.commands().map((entry) => entry.name)).toEqual(["hello"]);
  });
});

describe("**权限门槛：能力由清单授予，不由代码决定**", () => {
  it("没申请 agent.tool.register 的插件，**它的工具不进模型工具表**", async () => {
    const host = makeHost();
    // 只申请命令权限，却在 ready 里声明了工具
    const source = await makeSource("dev.example.e", ["commands.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, ["sneaky"], []);
    await sync;

    // 进程跑着（它有命令），但工具那一栏是空的
    expect(host.runningCount()).toBe(1);
    expect(host.tools()).toEqual([]);
  });

  it("没申请 commands.register 的插件，它的命令不出现", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.f", ["agent.tool.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, [], ["sneaky"]);
    await sync;

    expect(host.commands()).toEqual([]);
  });

  it("两个权限都有 → 两者都出现", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.g", ["agent.tool.register", "commands.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, ["echo"], ["hello"]);
    await sync;

    expect(pluginOnly(host)).toHaveLength(1);
    expect(host.commands()).toHaveLength(1);
  });
});

describe("工具名与调用", () => {
  it("工具名带插件前缀（不与内置/MCP 工具撞名）", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.git-lens", ["agent.tool.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, ["status"]);
    await sync;

    // **网关形态**：一个插件恒定只占一个工具位，内层工具走 tool 参数\n    expect(host.tools()[0]?.name).toBe("plugin__dev-example-git-lens__call");
  });

  it("调用转发到插件，成功时回文本", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.h", ["agent.tool.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, ["echo"]);
    await sync;

    const tool = host.tools()[0];
    const promise = tool?.execute(
      "call-1",
      { tool: "echo", args: { value: 1 } },
      () => {},
      toolContext(pluginRoot),
      {} as never,
      {} as never,
    );
    const fake = fakes.get(fakeKey(path.join(source.dir, "main.js")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake?.emit({ type: "result", id: fake.calls[0]?.id, text: "结果" });

    const result = (await promise) as { content: { text: string }[] };
    expect(result.content[0]?.text).toBe("结果");
  });

  it("**插件失败时给模型一段可读文案**，而不是抛异常", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.i", ["agent.tool.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, ["echo"]);
    await sync;

    const tool = host.tools()[0];
    const promise = tool?.execute(
      "call-1",
      { tool: "echo" },
      () => {},
      toolContext(pluginRoot),
      {} as never,
      {} as never,
    );
    const fake = fakes.get(fakeKey(path.join(source.dir, "main.js")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake?.emit({ type: "result", id: fake.calls[0]?.id, error: "仓库不存在" });

    const result = (await promise) as { content: { text: string }[]; isError?: boolean };
    expect(result.content[0]?.text).toContain("仓库不存在");
    expect(result.isError).toBe(true);
  });

  it("调用时带上**这次调用**的工作目录（一个进程服务所有会话）", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.j", ["agent.tool.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, ["echo"]);
    await sync;

    void host
      .tools()[0]
      ?.execute(
        "call-1",
        { tool: "echo" },
        () => {},
        toolContext("/some/workspace"),
        {} as never,
        {} as never,
      );
    const fake = fakes.get(fakeKey(path.join(source.dir, "main.js")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake?.calls[0]?.workspaceDir).toBe("/some/workspace");
  });
});

describe("同步：停掉不该跑的", () => {
  it("插件从来源里消失 → 进程被停掉，但**工具名留在表里**（桩）", async () => {
    /*
      这条钉的是一条**会毁掉整个会话**的契约。

      内核的 `activeToolNames` 是创建会话时按工具名播种的，而 `harness.setTools`
      **不动它**。所以工具表一旦少了一个名字，此后每个请求都会以
      `configured_tools_unavailable` 失败 —— 用户看到的是"消息发不出去了"。

      插件工具恰恰会消失（进程崩溃、插件被停用），所以暴露出去的**名字集合必须单调不减**：
      进程没了，工具还在，只是调用它返回一句可读的错误。
    */
    const host = makeHost();
    const source = await makeSource("dev.example.k", ["agent.tool.register"]);
    const sync = host.sync([source]);
    await readyWith(source.dir, ["echo"]);
    await sync;
    expect(host.runningCount()).toBe(1);

    const toolName = pluginGatewayName("dev.example.k");
    const fake = fakes.get(fakeKey(path.join(source.dir, "main.js")));
    await host.sync([]);

    expect(host.runningCount()).toBe(0);
    expect(fake?.killed).toBe(true);

    // **名字还在** —— 这是内核继续接受请求的前提
    const names = host.tools().map((tool) => tool.name);
    expect(names).toContain(toolName);

    // 而调用它得到的是"插件没在跑"，不是"工具不存在"
    const stub = host.tools().find((tool) => tool.name === toolName);
    const result = (await stub?.execute(
      "c1",
      { tool: "echo" },
      () => {},
      toolContext("/tmp"),
      {} as never,
      {} as never,
    )) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("没有运行");
    expect(result.content[0]?.text).toContain("dev.example.k");
  });

  it("插件重新起来之后，桩被真工具接管", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.k2", ["agent.tool.register"]);
    const syncA = host.sync([source]);
    await readyWith(source.dir, ["echo"]);
    await syncA;
    await host.sync([]);

    // 重新出现：桩应当被摘掉，否则模型会一直被那句"没有运行"骗到
    /*
      **先清掉旧的假进程。** 不清的话 `waitForFake` 会立刻返回上一轮那个（表里还在），
      于是新进程永远等不到握手 —— 而失败信息是"桩没被摘掉"，指向的是实现。
    */
    fakes.clear();
    const syncB = host.sync([source]);
    await readyWith(source.dir, ["echo"]);
    await syncB;

    const tool = host.tools().find((item) => item.name === pluginGatewayName("dev.example.k2"));
    const promise = tool?.execute(
      "c1",
      { tool: "echo" },
      () => {},
      toolContext("/tmp"),
      {} as never,
      {} as never,
    );
    const fake = fakes.get(fakeKey(path.join(source.dir, "main.js")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 真实的调用被转发到了进程 —— 说明桩已经不在了
    fake?.emit({ type: "result", id: fake.calls.at(-1)?.id, text: "真的结果" });
    const result = (await promise) as { content: { text: string }[]; isError?: boolean };
    expect(result.content[0]?.text).toBe("真的结果");
  });

  it("插件目录换了 → 旧进程停掉、新进程起来（开发插件重挂目录）", async () => {
    const host = makeHost();
    const first = await makeSource("dev.example.l", ["agent.tool.register"]);
    const syncA = host.sync([first]);
    await readyWith(first.dir, ["echo"]);
    await syncA;
    const fakeA = fakes.get(fakeKey(path.join(first.dir, "main.js")));

    // 同一个 id，换了目录
    const moved = { ...first, dir: `${first.dir}-moved` };
    const { mkdir } = await import("node:fs/promises");
    await mkdir(moved.dir, { recursive: true });
    await writeFile(path.join(moved.dir, "main.js"), "// 假入口", "utf8");

    const syncB = host.sync([moved]);
    await readyWith(moved.dir, ["echo"]);
    await syncB;

    expect(fakeA?.killed).toBe(true);
    expect(host.runningCount()).toBe(1);
  });

  it("同步两次不会重复起进程（幂等）", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.m", ["agent.tool.register"]);
    const syncA = host.sync([source]);
    await readyWith(source.dir, ["echo"]);
    await syncA;

    await host.sync([source]);
    expect(host.runningCount()).toBe(1);
    expect(fakes.size).toBe(1);
  });

  it("启动失败（握手超时）记成可在诊断里看到的记录", async () => {
    const host = createPluginProcessHost({
      fork: (entry) => {
        const fake = new FakeProcess();
        fakes.set(fakeKey(entry), fake);
        return fake;
      },
      handshakeTimeoutMs: 20,
    });
    const source = await makeSource("dev.example.n", ["agent.tool.register"]);
    // 不 emit ready —— 让它超时
    await host.sync([source]);

    expect(host.runningCount()).toBe(0);
    const issues = host.issues();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.pluginId).toBe("dev.example.n");
    expect(issues[0]?.message).toContain("握手");
  });

  it("stopAll 停掉全部", async () => {
    const host = makeHost();
    const a = await makeSource("dev.example.o", ["agent.tool.register"]);
    const b = await makeSource("dev.example.p", ["agent.tool.register"]);
    const sync = host.sync([a, b]);
    await readyWith(a.dir, ["one"]);
    await readyWith(b.dir, ["two"]);
    await sync;

    host.stopAll();
    expect(host.runningCount()).toBe(0);
    for (const fake of fakes.values()) expect(fake.killed).toBe(true);
  });
});

describe("pluginToolKey", () => {
  it("把反向域名压成可读的 key", () => {
    expect(pluginToolKey("dev.example.git-lens")).toBe("dev-example-git-lens");
    expect(pluginToolKey("a.b_c")).toBe("a-b-c");
  });

  it("首尾的分隔符被去掉（不能出现 plugin__-x__y 这种名字）", () => {
    expect(pluginToolKey(".a.")).toBe("a");
  });
});

describe("插件命令", () => {
  /** 起一个注册了命令的插件 */
  async function withCommands(
    id: string,
    permissions: string[],
    commands: string[],
  ): Promise<{ host: ReturnType<typeof createPluginProcessHost>; dir: string }> {
    const host = makeHost();
    const source = await makeSource(id, permissions);
    const sync = host.sync([source]);
    await readyWith(source.dir, [], commands);
    await sync;
    return { host, dir: source.dir };
  }

  it("命令视图带上插件信息与全局唯一的 id", async () => {
    const { host } = await withCommands("dev.example.cmd", ["commands.register"], ["sync"]);
    expect(host.commands()).toEqual([
      {
        // id 前缀是插件 key —— 两个插件各有一个 sync 时不能撞车
        id: "dev-example-cmd:sync",
        pluginId: "dev.example.cmd",
        pluginName: "dev-example-cmd",
        name: "sync",
        description: "sync 的说明",
      },
    ]);
  });

  it("执行把 run 消息发给插件，结果原样回来", async () => {
    const { host, dir } = await withCommands("dev.example.cmd", ["commands.register"], ["sync"]);
    const promise = host.runCommand("dev-example-cmd:sync", "origin main", "/tmp/ws");

    const fake = await waitForFake(dir);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.runs[0]).toMatchObject({
      type: "run",
      command: "sync",
      // 参数与工作目录都带上了：命令多半要针对"当前会话在看的那个目录"做事
      args: "origin main",
      workspaceDir: "/tmp/ws",
    });
    fake.emit({ type: "result", id: fake.runs[0]?.id, text: "拉取完成" });

    expect(await promise).toEqual({ ok: true, text: "拉取完成" });
  });

  it("**没申请 commands.register 的插件，它的命令执行不了**", async () => {
    // 与工具那一栏同一条纪律：能力由清单授予。区别是这条更隐蔽 ——
    // 命令面板里的条目本来就不会显示，但直接调 IPC 仍然要挡住
    const { host } = await withCommands("dev.example.cmd", ["agent.tool.register"], ["sneaky"]);

    const result = await host.runCommand("dev-example-cmd:sneaky", "", "/tmp");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("找不到插件命令");
  });

  it("id 不认识时报可读错误，而不是静默什么都不做", async () => {
    const { host } = await withCommands("dev.example.cmd", ["commands.register"], ["sync"]);
    const result = await host.runCommand("dev-example-cmd:nope", "", "/tmp");
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("dev-example-cmd:nope"),
    });
  });

  it("**插件被停用之后命令立刻失效**（进程没了，命令也没了）", async () => {
    const { host } = await withCommands("dev.example.cmd", ["commands.register"], ["sync"]);
    host.stopAll();

    expect(host.commands()).toEqual([]);
    const result = await host.runCommand("dev-example-cmd:sync", "", "/tmp");
    expect(result.ok).toBe(false);
  });

  it("插件对命令报错 → ok:false 带可读原因", async () => {
    const { host, dir } = await withCommands("dev.example.cmd", ["commands.register"], ["sync"]);
    const promise = host.runCommand("dev-example-cmd:sync", "", "/tmp");
    const fake = await waitForFake(dir);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.emit({ type: "result", id: fake.runs[0]?.id, error: "不是 Git 仓库" });

    expect(await promise).toEqual({ ok: false, error: "不是 Git 仓库" });
  });

  it("命令与工具共用 id 空间 —— 一次工具的应答不会结算一次命令", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.both", [
      "agent.tool.register",
      "commands.register",
    ]);
    const sync = host.sync([source]);
    await readyWith(source.dir, ["status"], ["sync"]);
    await sync;

    const toolPromise = host
      .tools()[0]
      ?.execute("c1", { tool: "status" }, () => {}, toolContext("/tmp"), {} as never, {} as never);
    const commandPromise = host.runCommand("dev-example-both:sync", "", "/tmp");
    const fake = await waitForFake(source.dir);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 先回命令，再回工具
    fake.emit({ type: "result", id: fake.runs[0]?.id, text: "命令结果" });
    fake.emit({ type: "result", id: fake.calls[0]?.id, text: "工具结果" });

    expect(await commandPromise).toEqual({ ok: true, text: "命令结果" });
    const toolResult = (await toolPromise) as { content: { text: string }[] };
    expect(toolResult.content[0]?.text).toBe("工具结果");
  });
});

/**
 * 钩子的分发（到进程这一层）。
 *
 * 这一组盯的是**三件在真实使用里立刻会踩到的事**：
 *  1. 只声明钩子的插件也必须起进程 —— 否则它的钩子永远没人接，而 fail-closed
 *     的 `PreToolUse` 会把每一次工具调用都拦下，理由还写着"钩子没能做出判定"；
 *  2. 进程不在了不等于"没有钩子" —— 崩掉的策略钩子必须仍然拦得住（否则
 *     "插件崩了"就静默变成"策略失效了"）；
 *  3. 钩子失败要进诊断流 —— 用户在插件管理里得看得到是哪个钩子坏了。
 */
describe("钩子的分发", () => {
  const GUARD: OintPluginManifest["hooks"] = [{ id: "guard", event: "PreToolUse" }];
  const HOOK_ONLY_PERMISSIONS = ["hostHooks.register"];

  function hookPayload() {
    return { toolName: "bash", args: { command: "rm -rf /" }, workspaceDir: "/repo" };
  }

  it("**只声明钩子（没有工具/命令）的插件也起进程**", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.guard", HOOK_ONLY_PERMISSIONS, {
      hooks: GUARD,
    });

    const sync = host.sync([source]);
    await readyWith(source.dir, [], [], ["guard"]);
    await sync;

    expect(host.runningCount()).toBe(1);
    // 它不提供任何工具（那份权限都没申请），但进程在跑 —— 钩子要有进程接
    expect(pluginOnly(host)).toHaveLength(0);
  });

  it("分发给声明了该事件、且 matcher 命中的插件，并带回结论", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.guard", HOOK_ONLY_PERMISSIONS, {
      hooks: [{ id: "guard", event: "PreToolUse", matcher: "^bash$" }],
    });
    const sync = host.sync([source]);
    await readyWith(source.dir, [], [], ["guard"]);
    await sync;
    const fake = await waitForFake(source.dir);

    const pending = host.dispatchHooks("PreToolUse", hookPayload());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sent = fake.sent.at(-1) as Record<string, unknown>;
    fake.emit({ type: "hookResult", id: sent.id, block: "本插件禁用 bash" });

    await expect(pending).resolves.toMatchObject({ block: "本插件禁用 bash" });
  });

  it("matcher 不命中时插件**收不到调用**（少一次跨进程往返）", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.guard", HOOK_ONLY_PERMISSIONS, {
      hooks: [{ id: "guard", event: "PreToolUse", matcher: "^read$" }],
    });
    const sync = host.sync([source]);
    await readyWith(source.dir, [], [], ["guard"]);
    await sync;
    const fake = await waitForFake(source.dir);
    const before = fake.sent.length;

    const result = await host.dispatchHooks("PreToolUse", hookPayload());

    expect(result.block).toBeUndefined();
    expect(fake.sent.length).toBe(before);
  });

  it("**进程不在运行 = 一次失败**：fail-closed 的钩子仍然拦得住", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.guard", HOOK_ONLY_PERMISSIONS, {
      hooks: GUARD,
    });
    // 起不来（不完成握手）→ 进程不在 running 里，但钩子声明还在
    await host.sync([source]);

    const result = await host.dispatchHooks("PreToolUse", hookPayload());

    expect(result.block).toContain("进程没有在运行");
    expect(result.block).toContain("停用该插件");
  });

  it("failure: open 的钩子在进程不在时放行（观察型钩子不该挡住一切）", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.logger", HOOK_ONLY_PERMISSIONS, {
      hooks: [{ id: "logger", event: "PreToolUse", failure: "open" }],
    });
    await host.sync([source]);

    const result = await host.dispatchHooks("PreToolUse", hookPayload());

    expect(result.block).toBeUndefined();
    expect(result.failures).toHaveLength(1);
  });

  it("钩子失败会进诊断流（插件管理里看得到是哪个钩子坏了）", async () => {
    const host = makeHost();
    const source = await makeSource("dev.example.guard", HOOK_ONLY_PERMISSIONS, {
      hooks: GUARD,
    });
    const sync = host.sync([source]);
    await readyWith(source.dir, [], [], ["guard"]);
    await sync;
    const fake = await waitForFake(source.dir);

    const pending = host.dispatchHooks("PreToolUse", hookPayload());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sent = fake.sent.at(-1) as Record<string, unknown>;
    fake.emit({ type: "hookResult", id: sent.id, error: "我坏了" });
    await pending;

    const issues = host.issues();
    expect(issues.some((issue) => issue.message.includes("guard"))).toBe(true);
  });

  it("没有插件声明钩子时，分发是**零成本**的（不发消息、不报错）", async () => {
    const host = makeHost();
    const result = await host.dispatchHooks("PreToolUse", hookPayload());
    expect(result).toEqual({ failures: [] });
  });
});
