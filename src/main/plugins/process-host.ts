// 插件进程池：把"哪些插件该跑、它们的工具叫什么"这件事收在一处。
//
// ## 与贡献面快照的关系
//
// 它跟着**同一次刷新**走（contributions.refreshPluginContributions 的三处时机：
// 启动、reload、启停）。分开刷的话会出现"技能生效了但工具还没有"这种半生效状态，
// 而那种状态看起来像插件本身坏了。
//
// ## 工具名的前缀
//
// `plugin__<key>__<name>`。为什么要前缀：工具名是模型眼里的全局命名空间，
// 与内置工具（`bash` / `read`）、MCP 工具（`mcp__<server>__<tool>`）并列。
// 一个插件把自己的工具叫 `read` 就会与内核的 read 撞名 —— 而不加前缀的话，
// 撞名的后果是"模型的 read 变成了插件的东西"，那是最坏的一种失败。
//
// `key` 是插件 id 的归一形式（点换成 `-`）：可读，且与分区名/数据目录名同一套归一，
// 排查时不必再想一遍"这个 key 对应哪个插件"。

import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { dataDir, pluginDataDir } from "@/main/app/paths";
import type {
  OintPluginManifest,
  PluginCommandView,
  PluginHookEvent,
} from "@/shared/contracts/plugin";

import type { PluginHookPayload, PluginToolDecl } from "@/shared/contracts/plugin-rpc";
import {
  dispatchHooks as dispatchHooksImpl,
  type HookDispatch,
  type RegisteredHook,
} from "./hooks";
import {
  type ForkPluginProcess,
  type PluginProcess,
  PluginProcessStartError,
  startPluginProcess,
} from "./plugin-process";
import { createPluginCatalogTool } from "./tools/plugin-catalog";

/** 一个可能要跑进程的插件 */
export interface PluginProcessSource {
  id: string;
  dir: string;
  manifest: OintPluginManifest;
}

/** 进程启动失败 / 崩溃 —— 都记下来，面板上要看得到 */
export interface PluginProcessIssue {
  pluginId: string;
  message: string;
  /** 声明里的逐条问题（启动失败的常见形态） */
  details: string[];
}

export interface PluginProcessHost {
  /** 对齐到给定的插件集合：启动新出现的、停掉不再有的、保留没变的 */
  sync(sources: readonly PluginProcessSource[]): Promise<void>;
  /** 全部插件的工具（已加前缀，可直接进 buildTools 的 extraTools） */
  tools(): AgentHarnessTool<ExecutionToolContext>[];
  /** 插件注册的命令（已转成面板要的形状） */
  commands(): PluginCommandView[];
  /** 执行一个插件命令；id 由 commands() 给出 */
  runCommand(
    id: string,
    args: string,
    workspaceDir: string,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /**
   * 分发一次工具相关的事件（`PreToolUse` / `PostToolUse` / `PostToolUseFailure`）。
   *
   * 判定逻辑在 hooks.ts（纯函数），这里负责把调用送到正确的插件进程。
   * **永不抛错**：调用方在工具执行的关键路径上，一次分发失败应当变成
   * "这次调用怎么处置"（见 HookDispatch），而不是一个异常。
   */
  dispatchHooks(event: PluginHookEvent, payload: PluginHookPayload): Promise<HookDispatch>;
  /** 当前的失败记录 */
  issues(): PluginProcessIssue[];
  /** 停掉全部（应用退出时调） */
  stopAll(): void;
  /** 现在跑着几个进程（诊断用） */
  runningCount(): number;
}

/**
 * 插件 id → 工具前缀里的 key。
 *
 * 与分区名、数据目录名同一套归一的**可读版本**（分区名多了 `persist:oint-plugin-`
 * 前缀与更严的字符集）。
 */
export function pluginToolKey(pluginId: string): string {
  return pluginId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * 模型看到的**内层**工具全名。
 *
 * ⚠️ **它不直接进工具表** —— 模型看到的是下面那个网关（`plugin__<key>__call`），
 * 内层工具通过网关的 `tool` 参数指定。这个函数现在只用于内部记账（retired 表）与诊断。
 */
export function pluginToolName(pluginId: string, toolName: string): string {
  return `plugin__${pluginToolKey(pluginId)}__${toolName}`;
}

/**
 * 插件网关的工具名：`plugin__<key>__call`。
 *
 * **一个插件恒定只占这一个工具位**，内层工具通过它的 `tool` 参数指定 ——
 * 与 MCP 的 `mcp__<server>__call` 完全同形（见 mcp-servers.ts 里那句
 * "一台 server 恒定只占一个工具位"）。
 *
 * ## 为什么不做成"每个工具一个条目"
 *
 *  1. **工具表长度可预测**：插件能声明多少工具由它的代码决定，宿主管不住。
 *     一个插件带十个工具就把模型看到的表撑长一截，而每个工具的描述都进上下文；
 *  2. **名字集合天然稳定**：插件进程崩溃/被停用时，消失的是"一个网关"，
 *     而不是十个名字。内核的 `activeToolNames` 是创建会话时播种的、`setTools` 不动它，
 *     所以名字少一个就会让此后每个请求以 `configured_tools_unavailable` 失败。
 *     网关把这种失败面从 N 个缩到 1 个。
 */
export function pluginGatewayName(pluginId: string): string {
  return `plugin__${pluginToolKey(pluginId)}__call`;
}

/**
 * 生产用的 fork 实现。
 *
 * **动态 import electron**：这个模块本身要能在 node 单测里跑（进程池的调度逻辑
 * —— 该起谁、该停谁、权限不够时工具进不进表 —— 全是纯逻辑，不该因为 electron
 * 而测不了）。
 *
 * `stdio: "pipe"` 让插件的 stdout/stderr 由宿主接管，而不是混进宿主自己的输出。
 */
async function electronFork(): Promise<ForkPluginProcess> {
  const { utilityProcess } = await import("electron");
  return (entry, options) => {
    const child = utilityProcess.fork(entry, [], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      serviceName: "oint-plugin",
    });
    /*
      攒着 stderr。上限 4KB —— 启动失败的原因通常在头几行，
      而一个疯狂打日志的插件不该把主进程内存吃掉。
    */
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });

    return {
      readStderr: () => stderr,
      postMessage: (message) => child.postMessage(message),
      onMessage: (handler) => {
        const listener = (message: unknown): void => handler(message);
        child.on("message", listener);
        return () => {
          child.off("message", listener);
        };
      },
      onExit: (handler) => {
        const listener = (code: number): void => handler(code);
        child.on("exit", listener);
        return () => {
          child.off("exit", listener);
        };
      },
      kill: () => {
        child.kill();
      },
    };
  };
}

export interface PluginProcessHostOptions {
  /** 注入 fork（测试用）；不给就在第一次 sync 时动态取 electron 的实现 */
  fork?: Parameters<typeof startPluginProcess>[0]["fork"];
  handshakeTimeoutMs?: number;
  callTimeoutMs?: number;
  onIssue?: (issue: PluginProcessIssue) => void;
}

/**
 * 工具集合的代号：**只在真的变了的时候 +1**。
 *
 * 运行时要靠它判断"该不该重建工具表"。用"变没变"而不是"同步过几次"：
 * 每次刷新都重建工具表的话，用户每点一次插件管理就会让所有会话的
 * `harness.setTools` 被调一次，而内核的 setTools 会打断正在进行的生成准备。
 */
let toolGeneration = 0;
let lastSignature = "";

/** 当前代号。运行时在每轮结束时与它比对 */
export function pluginToolsGeneration(): number {
  return toolGeneration;
}

export function createPluginProcessHost(options: PluginProcessHostOptions = {}): PluginProcessHost {
  /** pluginId → 进程与它的来源（用来判断"还是不是同一个插件"） */
  const running = new Map<
    string,
    { process: PluginProcess; dir: string; manifest: OintPluginManifest }
  >();
  let issues: PluginProcessIssue[] = [];
  let forkImpl = options.fork;
  /**
   * **已经暴露过、但进程已经不在了**的工具。
   *
   * ## 为什么必须有这张表（这是一个真踩过的坑）
   *
   * 内核的 `activeToolNames` 是**创建会话时按 `tools.map(t => t.name)` 播种的**，
   * 而 `harness.setTools` **不动它**。于是工具表一旦"少了一个名字"，
   * 此后每次请求 `prepareGeneration` 都会发现"已激活的工具不在表里"，
   * 直接以 `configured_tools_unavailable` 失败 —— **整个会话再也发不出消息**。
   *
   * 插件工具恰恰会消失：进程崩溃、插件被停用、握手失败。
   * MCP 那边没这个问题（它的工具集由设置决定，不会因为一个进程死了而变），
   * 所以这是插件引入的**新失败模式**。
   *
   * 解法是让暴露出去的工具集合**单调不减**：进程没了，工具还在，
   * 只是调用它返回一句可读的错误。用户看到的是"这个插件的工具不可用了"，
   * 而不是"对话发不出去了"。
   */
  const retired = new Map<string, { pluginName: string }>();

  /**
   * 最近一次 `sync` 拿到的插件集合。
   *
   * 钩子分发要读它而不是读 `running`：**进程没起来不等于这个插件没有钩子**
   * （见 dispatchHooks 的说明）。停用的插件不在这个列表里（调用方只给启用中的），
   * 所以"用户停用"与"插件崩了"在这里是两件不同的事。
   */
  let currentSources: readonly PluginProcessSource[] = [];

  /**
   * 正在进行的 `sync`。钩子分发前先等它 —— 否则启动窗口期（进程正在起、
   * 还没进 `running`）会被当成"插件进程没有在运行"，而 fail-closed 的钩子
   * 会因此把开局的工具调用全部拦下。
   */
  let syncing: Promise<void> | null = null;

  const note = (issue: PluginProcessIssue): void => {
    issues = [...issues.filter((item) => item.pluginId !== issue.pluginId), issue];
    options.onIssue?.(issue);
  };

  const clear = (pluginId: string): void => {
    issues = issues.filter((item) => item.pluginId !== pluginId);
  };

  async function stopOne(pluginId: string): Promise<void> {
    const entry = running.get(pluginId);
    if (entry === undefined) return;
    /*
      **停之前先把它暴露过的工具记进 retired**（见那张表的说明）。
      顺序不能反：先 stop 的话，后面就没有 tools 可读了。
    */
    retired.set(pluginId, { pluginName: entry.manifest.name });
    running.delete(pluginId);
    entry.process.stop();
  }

  return {
    sync: runSync,
    tools,
    commands,
    runCommand,
    dispatchHooks,
    issues: () => [...issues],
    stopAll() {
      for (const entry of running.values()) entry.process.stop();
      running.clear();
    },
    runningCount: () => running.size,
  };

  /**
   * `sync` 的入口：把实际工作包一层，记下**正在进行的那一次**。
   *
   * 记账只为一个消费者：`dispatchHooks`。插件进程的启动是异步的（fork + 握手），
   * 而"用户刚启用一个插件、紧接着发一条消息"完全可能落在那个窗口里 ——
   * 那时 `running` 里还没有它，钩子分发会判成"进程没有在运行"，
   * 而 fail-closed 的 `PreToolUse` 会把这一轮的工具调用全拦下。
   * 等一次 in-flight 的 sync 就把这个窗口关掉了。
   */
  async function runSync(sources: readonly PluginProcessSource[]): Promise<void> {
    const task = syncOnce(sources);
    syncing = task;
    try {
      await task;
    } finally {
      if (syncing === task) syncing = null;
    }
  }

  async function syncOnce(sources: readonly PluginProcessSource[]): Promise<void> {
    currentSources = sources;
    forkImpl ??= await electronFork();
    // 先停：不再有的、或者换了目录的（开发插件重挂目录）
    for (const [id, entry] of [...running]) {
      const next = sources.find((source) => source.id === id);
      if (next === undefined || next.dir !== entry.dir) {
        await stopOne(id);
        if (next === undefined) clear(id);
      }
    }

    for (const source of sources) {
      /*
          **只有声明了 `main` 的插件才起进程。**
          纯声明式的插件（只贡献技能/提示/面板）一个进程都不该有 ——
          那正是 T0 那一档的价值：不跑代码就没有代码的风险。
        */
      const entry = source.manifest.main;
      if (entry === undefined) {
        await stopOne(source.id);
        continue;
      }
      /*
          **需要"有可执行的面"才起进程**：工具、命令、或钩子之一。
          一个声明了 main 但一个能力都没申请的插件起了也没用，而多一个进程就是
          多一份内存与攻击面。这一条与清单校验的分工是：校验管"声明的权限认不认识"，
          这里管"起不起进程值不值"。

          **钩子必须算进来**：`hostHooks.register` 单独存在是合法的（一个只做策略拦截、
          不做工具/命令的插件）。漏了它的后果不是"少一个能力"，而是
          **那个插件的钩子永远没人接** —— 而 fail-closed 的钩子（PreToolUse 缺省）
          会把每一次工具调用都拦下，理由还写着"钩子没能做出判定"。
        */
      const useful =
        source.manifest.permissions.includes("agent.tool.register") ||
        source.manifest.permissions.includes("commands.register") ||
        source.manifest.hooks.length > 0;
      if (!useful) continue;
      if (running.has(source.id)) continue;

      try {
        const process = await startPluginProcess({
          pluginId: source.id,
          pluginDir: source.dir,
          entry,
          permissions: source.manifest.permissions,
          // 声明的那一份：进程侧要拿它跟 ready.hooks 对账（对不上就拒绝加载）
          hooks: source.manifest.hooks,
          dataDir: pluginDataDir(source.id, dataDir()),
          fork: forkImpl,
          ...(options.handshakeTimeoutMs === undefined
            ? {}
            : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
          ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
          onLog: (level, message) => {
            // 插件的日志进诊断，**不进模型上下文** —— 它是给作者/用户看的
            if (level === "error") note({ pluginId: source.id, message, details: [] });
          },
        });
        running.set(source.id, { process, dir: source.dir, manifest: source.manifest });
        // 这台又活了：摘掉桩，让真网关重新接管
        retired.delete(source.id);
        clear(source.id);
      } catch (error) {
        note({
          pluginId: source.id,
          message:
            error instanceof PluginProcessStartError
              ? error.message
              : `插件进程启动失败：${error instanceof Error ? error.message : String(error)}`,
          details: error instanceof PluginProcessStartError ? error.issues : [],
        });
      }
    }

    /*
        算一次"工具集合变了没有"。签名用"插件 id + 它的工具名"——
        描述或 schema 变了也算变（它们进模型上下文，模型该看到新的）。
      */
    const signature = [...running]
      .map(([id, entry]) => `${id}:${entry.process.tools.map((tool) => tool.name).join(",")}`)
      .sort()
      .join("|");
    if (signature !== lastSignature) {
      lastSignature = signature;
      toolGeneration += 1;
    }
  }

  function tools(): AgentHarnessTool<ExecutionToolContext>[] {
    const tools: AgentHarnessTool<ExecutionToolContext>[] = [];
    for (const [pluginId, entry] of running) {
      // 权限门槛：没申请 agent.tool.register 的插件，它的工具**不进工具表**
      //（与 MCP 那边"没申请权限的 server 不装载"同一条纪律）
      if (!entry.manifest.permissions.includes("agent.tool.register")) continue;
      // 一个工具都没有的插件不占工具位 —— 与 MCP 那边"没有 server 就不带聚合工具"一致
      if (entry.process.tools.length === 0) continue;
      tools.push(
        makeGatewayTool(pluginId, entry.manifest.name, entry.process, entry.process.tools),
      );
    }
    /*
        retired 的补成**桩网关**：插件没了，但那一个工具名还在 ——
        名字集合少一个，内核就会以 `configured_tools_unavailable` 拒掉此后每个请求。
      */
    for (const [pluginId, entry] of retired) {
      if (running.has(pluginId)) continue;
      tools.push(makeRetiredGateway(pluginId, entry.pluginName));
    }
    /*
        **有工具就带上目录**（与 MCP 那边"只要有 server 就带 mcp_tools"同一条）。
        网关的描述里只有内层工具的名字与说明 —— 参数 schema 太长，塞进去会把上下文撑爆，
        所以"该传什么参数"要靠这个目录工具去查。
      */
    if (tools.length > 0) {
      tools.push(
        createPluginCatalogTool<ExecutionToolContext>({
          catalog: () =>
            [...running]
              .filter(
                ([, entry]) =>
                  entry.manifest.permissions.includes("agent.tool.register") &&
                  entry.process.tools.length > 0,
              )
              .map(([pluginId, entry]) => ({
                pluginId,
                pluginName: entry.manifest.name,
                tools: entry.process.tools,
              })),
        }),
      );
    }
    return tools;
  }

  function commands(): PluginCommandView[] {
    const out: PluginCommandView[] = [];
    for (const [pluginId, entry] of running) {
      // 权限门槛（与工具那一栏同一条纪律：能力由清单授予，不由代码决定）
      if (!entry.manifest.permissions.includes("commands.register")) continue;
      for (const decl of entry.process.commands) {
        out.push({
          // 调用 id 带上插件 key：两个插件各有一个 `status` 命令时不能撞车
          id: `${pluginToolKey(pluginId)}:${decl.name}`,
          pluginId,
          pluginName: entry.manifest.name,
          name: decl.name,
          description: decl.description,
        });
      }
    }
    return out;
  }

  async function runCommand(
    id: string,
    args: string,
    workspaceDir: string,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    /*
        **线性找一遍，而不是从 id 反推插件。**
        id 的前缀是 `pluginToolKey(pluginId)`，而那个归一是**有损的**
        （点、下划线、连字符都变成 `-`），反推不回来 —— 而"反推错了"的后果是
        执行了**另一个插件的命令**。

        找不到时报错而不是静默：命令面板里的条目是刚列出来的，找不到意味着
        插件在两次交互之间被停用了 —— 那正是用户该知道的事。
      */
    for (const [pluginId, entry] of running) {
      if (!entry.manifest.permissions.includes("commands.register")) continue;
      const decl = entry.process.commands.find(
        (candidate) => `${pluginToolKey(pluginId)}:${candidate.name}` === id,
      );
      if (decl === undefined) continue;
      return entry.process.run(decl.name, args, workspaceDir);
    }
    return { ok: false, error: `找不到插件命令：${id}（提供它的插件可能已被停用）` };
  }

  /**
   * 分发一次工具相关的事件给所有声明了它的插件。
   *
   * ## 三条值得说明的取舍
   *
   * 1. **判定在 `hooks.ts`，这里只管"把调用送出去"** —— 匹配、合并、失败处置
   *    都是纯逻辑，能在单测里跑；这一层负责的是"哪个进程、进程不在怎么办"。
   * 2. **顺序 = `currentSources` 的顺序**（注册表的顺序，确定且稳定）。
   *    并发调用多个插件会让"谁先拦下"取决于 IO 完成顺序 —— 那是不确定的策略。
   * 3. **进程不在运行 = 一次失败，不是"没有钩子"**。这条最容易被写错：
   *    插件崩了之后如果钩子静默消失，一个 fail-closed 的策略钩子就等于被自动关闭了。
   *    进程没起（还没跑）时同样按失败处理，理由一样；但会先等一次 in-flight 的 sync，
   *    免得把"正在启动"误判成"起不来"。
   */
  async function dispatchHooks(
    event: PluginHookEvent,
    payload: PluginHookPayload,
  ): Promise<HookDispatch> {
    if (syncing !== null) await syncing.catch(() => undefined);

    const registered: RegisteredHook[] = [];
    for (const source of currentSources) {
      for (const decl of source.manifest.hooks) {
        registered.push({ pluginId: source.id, pluginName: source.manifest.name, decl });
      }
    }
    if (registered.length === 0) return { failures: [] };

    const result = await dispatchHooksImpl(
      registered,
      event,
      payload,
      async (hook, hookPayload) => {
        const entry = running.get(hook.pluginId);
        if (entry === undefined) {
          return { failure: "插件进程没有在运行（被停用、启动失败或已崩溃）" };
        }
        return entry.process.hook(hook.decl.id, event, hookPayload);
      },
    );
    /*
      失败的钩子进**诊断流**（插件管理里能看到），而不是只打一行 console：
      用户看到的是一次被拦下的调用，他需要知道是哪个插件的哪个钩子坏掉了 ——
      那是"我该不该停用它"这个决定的全部依据。
    */
    for (const failure of result.failures) {
      note({
        pluginId: failure.pluginId,
        message: `钩子「${failure.hookId}」执行失败：${failure.message}`,
        details: [],
      });
    }
    return result;
  }
}

/**
 * 进程内唯一实例。
 *
 * 与 getPluginRegistry / getMcpServers 同一手法：**运行时与设置面板必须看到同一批
 * 进程** —— 各持一个的话，"插件管理里显示它在跑"与"模型真的有它的工具"会分叉，
 * 而那种分叉没有任何报错。
 */
let sharedHost: PluginProcessHost | null = null;

export function getPluginProcessHost(options?: PluginProcessHostOptions): PluginProcessHost {
  sharedHost ??= createPluginProcessHost(options);
  return sharedHost;
}

/** 当前可用的插件工具（运行时装配用） */
export function pluginTools(): AgentHarnessTool<ExecutionToolContext>[] {
  return getPluginProcessHost().tools();
}

/** 插件注册的命令（id 直接给命令面板用） */
export function pluginCommands(): PluginCommandView[] {
  return getPluginProcessHost().commands();
}

/**
 * 分发一次工具事件（运行时装配用）。
 *
 * 与 pluginTools / pluginCommands 同一手法：运行时只拿一个门面，
 * 进程池的实例留给 getPluginProcessHost 去管。
 */
export function dispatchPluginHooks(
  event: PluginHookEvent,
  payload: PluginHookPayload,
): Promise<HookDispatch> {
  return getPluginProcessHost().dispatchHooks(event, payload);
}

/** 执行一个插件命令；id 来自 pluginCommands() */
export function runPluginCommand(
  id: string,
  args: string,
  workspaceDir: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return getPluginProcessHost().runCommand(id, args, workspaceDir);
}

/** 进程启动失败 / 崩溃的记录（面板与诊断用） */
export function pluginProcessIssues(): PluginProcessIssue[] {
  return getPluginProcessHost().issues();
}

/** 应用退出时停掉全部插件进程 */
export function stopPluginProcesses(): void {
  sharedHost?.stopAll();
}

/**
 * 一个"插件已经不在"的**桩网关**。
 *
 * 它存在的唯一理由是**让工具表的名字集合保持不变** —— 名字一少，内核就会以
 * `configured_tools_unavailable` 拒掉此后每一个请求（见 `retired` 那张表的说明）。
 *
 * 所以它的行为不是"什么都不做"，而是**明确报出原因**：模型看到
 * "提供这个工具的插件已停用"之后知道该绕开，而不是以为工具坏了。
 *
 * 网关形态让这件事的成本小得多：一个插件只留**一个**桩，而不是每个内层工具一个。
 */
function makeRetiredGateway(
  pluginId: string,
  pluginName: string,
): AgentHarnessTool<ExecutionToolContext> {
  return {
    name: pluginGatewayName(pluginId),
    label: pluginName,
    description: `[插件 ${pluginId}] 当前不可用`,
    parameters: {
      type: "object",
      properties: { tool: { type: "string" }, args: { type: "object" } },
      required: ["tool"],
    },
    async execute(): Promise<AgentToolResult<unknown>> {
      return {
        content: [
          {
            type: "text",
            text: `错误：插件「${pluginName}」（${pluginId}）当前没有运行 —— 它可能已停用、崩溃，或还没启动完成。`,
          },
        ],
        isError: true,
      } as unknown as AgentToolResult<unknown>;
    },
  } as AgentHarnessTool<ExecutionToolContext>;
}

/**
 * 一个插件的**网关工具**：`plugin__<key>__call`。
 *
 * 内层工具通过 `tool` 参数指定，与 MCP 的 `mcp__<server>__call` 同形。
 * 内层工具的清单与说明**写进网关自己的 description** —— 那就是模型发现它们的通道，
 * 不需要再配一个目录工具：一个插件的内层工具是有限且已知的（它自己在 `ready` 里声明的），
 * 而 MCP 那边需要 `mcp_tools` 是因为 server 的工具可能在连接之后才变。
 *
 * 描述有长度上限（清单校验器那道 `MAX_TOOL_DESCRIPTION`），超了就截断并说明 ——
 * 一个带几十个工具的插件不该把模型上下文撑爆。
 */
function makeGatewayTool(
  pluginId: string,
  pluginName: string,
  process: PluginProcess,
  decls: readonly PluginToolDecl[],
): AgentHarnessTool<ExecutionToolContext> {
  const catalog = decls.map((decl) => `- ${decl.name}：${decl.description}`).join("\n");
  const description =
    `[插件 ${pluginId}] ${pluginName} 提供的工具。用 tool 参数指定要调用哪一个，` +
    `参数放进 args。\n\n可用的工具：\n${catalog}`;

  return {
    name: pluginGatewayName(pluginId),
    label: pluginName,
    description,
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          enum: decls.map((decl) => decl.name),
          description: "要调用的内层工具名",
        },
        args: {
          type: "object",
          description: "传给该工具的参数对象；每个工具要什么见上面的清单",
        },
      },
      required: ["tool"],
    },
    async execute(_toolCallId, rawParams, _onUpdate, context): Promise<AgentToolResult<unknown>> {
      /*
        `parameters` 是手写的字面量（没有 typebox schema 可推），所以 params 是 unknown。
        在这里收窄一次，而不是每处都断言。
      */
      const params = (rawParams ?? {}) as { tool?: unknown; args?: unknown };
      const requested = typeof params.tool === "string" ? params.tool : "";
      // 内层工具名的校验**在这里做**：网关了意味着模型可能传任何字符串，
      // 而直接转发给插件会让它的实现收到一个它没声明的名字
      if (!decls.some((decl) => decl.name === requested)) {
        return {
          content: [
            {
              type: "text",
              text: `错误：插件「${pluginName}」没有名为「${requested}」的工具。可用：${decls
                .map((decl) => decl.name)
                .join(", ")}`,
            },
          ],
          isError: true,
        } as unknown as AgentToolResult<unknown>;
      }

      // 工作目录来自**这次调用**的执行环境（一个进程服务所有会话）
      const result = await process.call(requested, params.args ?? {}, context.env.cwd);
      return {
        content: [{ type: "text", text: result.ok ? result.text : `错误：${result.error}` }],
        // 失败时带上 isError，界面据此把卡片标红 —— 与其它工具同款
        ...(result.ok ? {} : { isError: true }),
      } as AgentToolResult<unknown>;
    },
  } as AgentHarnessTool<ExecutionToolContext>;
}
