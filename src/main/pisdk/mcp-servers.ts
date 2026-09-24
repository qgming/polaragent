// MCP 服务桥：把「系统预设 + 设置里的用户 server」变成「可用的宿主工具 + 给面板看的状态」。
//
// 三层分工：
// - src/main/mcp/*              协议实现（传输 + 会话），不认识设置与工具
// - 本文件                       连接池与状态机，向运行时暴露 AgentHarnessTool
// - src/main/ipc/mcp.ts          IPC 出口，向设置面板暴露配置 + 状态
//
// 两层的合并口径**不在本文件**：它住在 shared/mcp/builtin-servers.ts 的
// resolveMcpServerEntries / effectiveMcpServerConfigs 里，面板与运行时共用同一份 ——
// 否则「面板里显示的」和「实际给模型的」会悄悄漂移。
//
// 单例与权限规则库同档（进程内一份）：运行时每次建会话都来这里取当前工具，
// 连接状态也只有一份才不会出现「面板说就绪、运行时说没连上」。

import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import {
  createMcpClient,
  type McpCallResult,
  type McpClient,
  type McpHandshake,
  type McpRemoteTool,
} from "@/main/mcp/client";
import { pluginMcpServerConfigs } from "@/main/plugins/contributions";
import { loadSettings } from "@/main/settings/store";
import {
  isValidMcpServerId,
  type McpConnectionStatus,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerState,
  type McpServerView,
  type McpToolInfo,
  mcpServerLabel,
  qualifyMcpToolName,
} from "@/shared/contracts/mcp";
import type { Settings } from "@/shared/contracts/settings";
import {
  effectiveMcpServerConfigs,
  findBuiltinMcpServer,
  type ResolvedMcpServer,
  resolveMcpServerEntries,
} from "@/shared/mcp/builtin-servers";
import { errorText } from "./error-text";
import type { AppToolContext } from "./tools";
import { createMcpCatalogTool, type McpCatalogServer } from "./tools/mcp-catalog";
import { createMcpGatewayTool, type McpGatewayServer } from "./tools/mcp-gateway";

/**
 * 一次交给模型的 MCP 工具上限。
 *
 * 所有已注册工具每轮都会进请求体，server 一多（或某个 server 工具特别多）就会把
 * 上下文与费用一起推高。超限只截断并记日志，不静默丢掉整批工具。
 *
 * 这个上限在「聚合」形态下几乎不会被碰到：一台 server 恒定只占一个工具位
 *（见 contracts/mcp.ts 的 MCP_GATEWAY_TOOL_NAME），所以它现在是**安全网**而不是配额 ——
 * 只有 server 数异常多（几十上百台）时才会截断并记日志。
 */
const MAX_MCP_TOOLS = 128;

/** 运行时视角：只要「取当前工具 + 订阅变化」两件事 */
export interface McpToolSource {
  /**
   * 当前可用的 MCP 工具（只含已就绪的 server）。
   *
   * 同步返回是刻意的：建会话时要用它一次性装配工具数组，
   * 而连接状态由 reload() 维护，取快照不该再去等网络。
   */
  tools(): AgentHarnessTool<AppToolContext>[];
  /** 工具集合变化时回调（连接/断开/工具列表变化），返回取消订阅函数 */
  subscribe(listener: () => void): () => void;
}

export interface McpServers extends McpToolSource {
  /** 设置里的配置 + 运行时状态，按 createdAt 排序 */
  views(): Promise<McpServerView[]>;
  /** 按当前设置重新对账（连上该连的、断开该断的），返回最新视图 */
  reload(): Promise<McpServerView[]>;
  /**
   * 只重连**一台** server，返回全部 server 的最新视图。
   *
   * 与 reload 的分工：reload 是「按设置对账整张连接表」（设置变了、增删了 server 时用），
   * 而这一条是「这台连不上/断了，单独再试一次」—— 面板每张卡片右上角的按钮用它。
   * 因此它**不动**其它 server：不关别人的连接，也不重新对账。
   *
   * 对停用或被覆盖的 server 只关不连（它们的配置不在生效列表里），并把状态复位成 idle ——
   * 调用方看到的仍然是「这台现在没连接」这个事实。
   */
  reconnect(serverId: string): Promise<McpServerView[]>;
  /** 用一份草稿配置试连一次，不影响正在运行的连接 */
  probe(config: McpServerConfig): Promise<McpProbeResult>;
  /** 调用通道：工具包装层用它转发 tools/call */
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult>;
  dispose(): Promise<void>;
}

interface ServerEntry {
  /** 建立当前连接时用的配置快照，用来判断「设置改了要不要重连」 */
  config: McpServerConfig;
  /** null = 还没有活着的连接（首次连接前或已关闭） */
  client: McpClient | null;
  status: McpConnectionStatus;
  error?: string;
  handshake?: McpHandshake;
  tools: McpRemoteTool[];
  connectedAt?: number;
  /** 正在进行的连接尝试：并发 reload 不该把同一个 server 连两遍 */
  connecting?: Promise<void>;
}

export interface McpServersDeps {
  getSettings: () => Promise<Settings>;
  warn?: (message: string) => void;
  /** 注入客户端工厂（测试用） */
  createClient?: (config: McpServerConfig) => McpClient;
}

/**
 * 三层的合并口径：**系统预设 → 插件声明 → 用户配置**。
 *
 * 这两个局部包装是**唯一**注入插件 server 的地方（下面五处调用全走它们）。
 * 为什么收在这里而不是让每个调用点自己写 `pluginMcpServerConfigs()`：
 * 那是五处各写一遍同一个参数，而漏掉任何一处的症状都不一样 ——
 * 漏在 `views()` 是「面板看不到插件提供的 server」，漏在 `reload()` 是
 * 「面板看得到但连不上」，漏在 `reconnect()` 是「点重连没反应」。
 * 三种症状，同一个原因，而且都不报错。
 *
 * `pluginMcpServerConfigs()` 读的是插件贡献面快照（同步）—— 它在装配路径上，
 * 不能 await 注册表。
 */
function entriesOf(settings: Settings): ResolvedMcpServer[] {
  return resolveMcpServerEntries(settings, pluginMcpServerConfigs());
}

/**
 * 设置面板用的清单：**不含插件贡献的 server**。
 *
 * 与 `entriesOf` 分开是刻意的，而且分开的正是**"谁说了算"**：
 *  - 面板是给用户管自己配置的地方。插件带来的 server 用户在面板里既改不了也删不掉
 *    （它们由插件的 `mcp.json` 派生），显示出来只会制造"这里能管它"的错觉；
 *  - 运行时那一侧照常合并（`entriesOf`），所以**模型照样能用它们**。
 *
 * 代价是"插件偷偷加了 MCP server 而用户在设置里看不见"。这条由**插件详情**补上：
 * 详情里有它的权限清单（`mcp.server.local` / `mcp.server.remote` 是高风险项）
 * 与贡献物计数 —— 用户在那个插件自己的档案里看得到，而不是在一个不属于它的列表里。
 */
function entriesForPanel(settings: Settings): ResolvedMcpServer[] {
  return resolveMcpServerEntries(settings);
}

function effectiveOf(settings: Settings): McpServerConfig[] {
  return effectiveMcpServerConfigs(settings, pluginMcpServerConfigs());
}

/** 连接相关的配置是否一致：只比会影响连接本身的字段，名字/启用状态不算 */
function sameConnection(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.transport === b.transport &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.url === b.url &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    JSON.stringify(a.env) === JSON.stringify(b.env) &&
    JSON.stringify(a.headers) === JSON.stringify(b.headers)
  );
}

function toToolInfo(serverId: string, tool: McpRemoteTool): McpToolInfo {
  return {
    name: tool.name,
    qualifiedName: qualifyMcpToolName(serverId, tool.name),
    description: tool.description,
    ...(tool.readOnly === undefined ? {} : { readOnly: tool.readOnly }),
  };
}

export function createMcpServers(deps: McpServersDeps): McpServers {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const makeClient =
    deps.createClient ?? ((config: McpServerConfig) => createMcpClient({ config, warn }));
  const entries = new Map<string, ServerEntry>();
  const listeners = new Set<() => void>();
  let disposed = false;

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        warn(`MCP 工具变更通知失败：${errorText(error)}`);
      }
    }
  }

  function stateOf(config: McpServerConfig): McpServerState {
    const entry = entries.get(config.id);
    if (entry === undefined) return { status: "idle", tools: [] };
    const handshake = entry.handshake;
    return {
      status: entry.status,
      tools: entry.tools.map((tool) => toToolInfo(config.id, tool)),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(handshake === undefined || handshake.serverName === ""
        ? {}
        : { serverName: handshake.serverName }),
      ...(handshake === undefined || handshake.protocolVersion === ""
        ? {}
        : { protocolVersion: handshake.protocolVersion }),
      ...(entry.connectedAt === undefined ? {} : { connectedAt: entry.connectedAt }),
    };
  }

  function toViews(resolved: ResolvedMcpServer[]): McpServerView[] {
    // 顺序即入参顺序：系统预设按注册表顺序在前，用户配置按设置文件顺序在后（不再重排 ——
    // 重排会让「面板里的位置」和「配置从哪来」对不上，而两层的分界正是这次要讲清的事）
    return resolved.map((entry) => ({
      config: entry.config,
      state: stateOfEntry(entry),
      source: entry.source,
      overridden: entry.overridden,
    }));
  }

  /**
   * 一行视图的状态。
   *
   * 被用户同 id 配置盖住的系统预设**一律报 idle**：连接是按 id 建的，那条连接属于用户配置，
   * 把它的「已连接 / 工具清单」显示在系统行上，会让人以为预设本身也在生效（两行都绿）。
   * 面板对这种情况的说明是那枚「被覆盖」徽标 + 用户行上的真实状态。
   */
  function stateOfEntry(entry: ResolvedMcpServer): McpServerState {
    if (entry.source === "system" && entry.overridden) return { status: "idle", tools: [] };
    return stateOf(entry.config);
  }

  /**
   * 关掉一条连接并复位状态；条目的删除由调用方决定。
   *
   * 刻意不动 `entry.connecting`：那是「同一 server 正在连」的去重键，
   * 由尝试自己的 then/finally 清理，否则并行 reload 会看到「没在连」而叠出第二个子进程。
   */
  async function closeEntry(entry: ServerEntry): Promise<void> {
    const client = entry.client;
    entry.client = null;
    entry.status = "idle";
    entry.error = undefined;
    entry.handshake = undefined;
    entry.tools = [];
    entry.connectedAt = undefined;
    if (client === null) return;
    await client.close().catch((error: unknown) => {
      warn(`关闭 MCP 连接失败：${errorText(error)}`);
    });
  }

  /** 建立一条新连接（旧连接先关掉）；同一 server 的并发调用会被 connecting 去重 */
  function connectEntry(entry: ServerEntry, config: McpServerConfig): Promise<void> {
    const inFlight = entry.connecting;
    if (inFlight !== undefined) return inFlight;
    const attempt = (async () => {
      await closeEntry(entry);
      // 关连接期间条目可能已被删掉（server 被移除/停用 / 已 dispose）：这次尝试作废
      if (disposed || entries.get(config.id) !== entry) return;

      let client: McpClient;
      try {
        client = makeClient(config);
      } catch (error) {
        // 例如 spawn 对非法参数同步抛错：记成连接失败，别把 rejected promise 留在 connecting 上
        entry.status = "error";
        entry.error = errorText(error);
        entry.tools = [];
        notify();
        return;
      }
      entry.client = client;
      entry.config = config;
      entry.status = "connecting";
      entry.error = undefined;
      notify();

      // 就绪之后才断开的连接：状态必须跟着变，否则面板会一直显示「已连接」而工具已失效
      client.onClosed((reason) => {
        if (entry.client !== client || entry.status !== "ready") return;
        entry.status = "error";
        entry.error = `连接已断开：${reason}`;
        entry.tools = [];
        notify();
      });

      try {
        const handshake = await client.connect();
        const tools = await client.listTools();
        // 期间被新的重连/关闭替换过：这次结果已经过期，直接丢弃
        if (entry.client !== client) return;
        entry.handshake = handshake;
        entry.tools = tools;
        entry.status = "ready";
        entry.connectedAt = Date.now();
      } catch (error) {
        if (entry.client !== client) return;
        const detail = errorText(error);
        const diagnostics = client.diagnostics();
        entry.status = "error";
        entry.error = diagnostics === "" ? detail : `${detail}（${diagnostics}）`;
        entry.tools = [];
        await client.close().catch(() => undefined);
      } finally {
        notify();
      }
    })();
    entry.connecting = attempt;
    // 只有仍挂着这次尝试时才清登记：清掉后来者的登记会让下一次 reload 又叠一条连接
    const clear = (): void => {
      if (entry.connecting === attempt) entry.connecting = undefined;
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  function ensureConnected(config: McpServerConfig): Promise<void> {
    const existing = entries.get(config.id);
    if (existing !== undefined) {
      if (existing.connecting !== undefined) return existing.connecting;
      // 已经就绪且连接参数没变：什么都不用做
      if (existing.status === "ready" && sameConnection(existing.config, config)) {
        return Promise.resolve();
      }
      // 配置变了或上次失败：复用条目，但连接重建
      return connectEntry(existing, config);
    }
    const entry: ServerEntry = { config, client: null, status: "idle", tools: [] };
    entries.set(config.id, entry);
    return connectEntry(entry, config);
  }

  /**
   * 一台 server 的聚合视图：聚合工具与 `mcp_tools` 都从它取数据。
   *
   * 每台 server 恒定只暴露一个工具 —— MCP server 的工具数不可预知（实测见过 94 个），
   * 全量展开会把几百个 schema 塞进每一轮请求，还会撞上工具数上限被静默截断。
   * 细节由 `mcp_tools` 按需读取（见 tools/mcp-catalog.ts）。
   */
  function gatewayServer(id: string, entry: ServerEntry): McpGatewayServer {
    return {
      serverId: id,
      serverName: mcpServerLabel(entry.config),
      // 系统预设的一句话说明来自注册表的 i18n 键 —— 但主进程没有 i18n，
      // 所以这里不塞文案：面板会显示它，模型从工具索引里也能看出这台 server 是干什么的。
      tools: [...entry.tools]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((tool) => ({ name: tool.name, description: tool.description })),
    };
  }

  /**
   * 同步收集当前工具：建会话时调用，不做任何等待。
   *
   * 每台就绪的 server 出一个聚合工具 `mcp__<id>__call`；只要有 server 就带上 `mcp_tools`
   *（内置详情工具，聚合形态下它是读工具清单与参数 schema 的唯一通道）。
   */
  function collectTools(): AgentHarnessTool<AppToolContext>[] {
    const result: AgentHarnessTool<AppToolContext>[] = [];
    if (entries.size > 0) {
      result.push(createMcpCatalogTool<AppToolContext>({ catalog }));
    }
    for (const [id, entry] of entries) {
      if (entry.status !== "ready") continue;
      if (result.length >= MAX_MCP_TOOLS) {
        warn(`MCP 工具超过 ${MAX_MCP_TOOLS} 个，已省略其余 server（${id}）`);
        return result;
      }
      result.push(createMcpGatewayTool<AppToolContext>(gatewayServer(id, entry), { callTool }));
    }
    return result;
  }

  /**
   * 能力清单快照：`mcp_tools` 的数据源。
   *
   * 覆盖**所有**条目（含未连接与连接失败的），因为它们正是排查时最需要的信息：
   * 「这台 server 为什么没有工具」的答案通常就在 status/error 里。
   */
  function catalog(): McpCatalogServer[] {
    return [...entries].map(([id, entry]) => ({
      serverId: id,
      serverName: mcpServerLabel(entry.config),
      source: findBuiltinMcpServer(id) === undefined ? "user" : "system",
      status: entry.status,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      tools: [...entry.tools]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.readOnly === undefined ? {} : { readOnly: tool.readOnly }),
        })),
    }));
  }

  async function callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const entry = entries.get(serverId);
    if (entry === undefined || entry.status !== "ready" || entry.client === null) {
      throw new Error(`MCP server 未连接：${serverId}`);
    }
    return entry.client.callTool(toolName, args);
  }

  const servers: McpServers = {
    tools: collectTools,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async views() {
      // 面板要看到**两层**（系统预设 + 用户配置），包括停用与被覆盖的那些 —— 停用的条目
      // 也要显示（否则用户没法把它重新打开），被覆盖的也要显示（否则「改了没生效」无从解释）。
      // 面板：不含插件贡献的（理由见 entriesForPanel）
      return toViews(entriesForPanel(await deps.getSettings()));
    },
    async reload() {
      if (disposed) return [];
      const settings = await deps.getSettings();
      // 连接只连**生效的**那些：同 id 用户配置胜出、停用的不连（合并口径见 builtin-servers.ts）
      const active = effectiveOf(settings);
      const byId = new Map(active.map((config) => [config.id, config]));

      for (const [id, entry] of [...entries]) {
        const next = byId.get(id);
        // 被删掉、被停用、或被另一层同 id 配置取代：关连接并从连接表摘掉
        //（视图仍会以 idle 状态展示它，用户在面板里还看得见）
        if (next === undefined) {
          await closeEntry(entry);
          entries.delete(id);
          continue;
        }
        // 连接参数变了：先关，下面统一重连
        if (!sameConnection(entry.config, next)) await closeEntry(entry);
      }

      await Promise.all(active.map((config) => ensureConnected(config)));
      notify();
      return toViews(entriesOf(settings));
    },
    async reconnect(serverId) {
      const settings = await deps.getSettings();
      const config = effectiveOf(settings).find((item) => item.id === serverId);
      // 先断开这台（如果有连接）：不复用旧 client，否则「重连」等于什么都不做
      const existing = entries.get(serverId);
      if (existing !== undefined) {
        await closeEntry(existing);
        // 停用 / 被覆盖 / 已从设置里删掉的 server：断完就算（视图里仍以 idle 展示它）
        if (config === undefined) entries.delete(serverId);
      }
      if (config !== undefined) await ensureConnected(config);
      notify();
      return toViews(entriesOf(settings));
    },
    async probe(config) {
      if (!isValidMcpServerId(config.id)) {
        return { ok: false, reason: `服务器 ID 非法：${config.id}` };
      }
      let client: McpClient;
      try {
        // 建客户端可能同步抛错（spawn 参数非法等）：按「试连失败」回，不把异常抛给通道
        client = makeClient(config);
      } catch (error) {
        return { ok: false, reason: errorText(error) };
      }
      try {
        const handshake = await client.connect();
        const tools = await client.listTools();
        return {
          ok: true,
          serverName: handshake.serverName,
          protocolVersion: handshake.protocolVersion,
          tools: tools.map((tool) => toToolInfo(config.id, tool)),
        };
      } catch (error) {
        const detail = errorText(error);
        const diagnostics = client.diagnostics();
        return { ok: false, reason: diagnostics === "" ? detail : `${detail}（${diagnostics}）` };
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    callTool,
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      for (const entry of entries.values()) await closeEntry(entry);
      entries.clear();
    },
  };
  return servers;
}

// 进程内唯一实例：运行时取工具与 IPC 面板读状态必须是同一份
let sharedServers: McpServers | null = null;

/** 取共享 MCP 服务桥；首次调用时用真实设置来源装配 */
export function getMcpServers(): McpServers {
  sharedServers ??= createMcpServers({ getSettings: loadSettings });
  return sharedServers;
}
