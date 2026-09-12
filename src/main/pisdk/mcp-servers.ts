// MCP 服务桥：把「设置里的 server 列表」变成「可用的宿主工具 + 给面板看的状态」。
//
// 三层分工：
// - src/main/mcp/*     协议实现（传输 + 会话），不认识设置与工具
// - 本文件              连接池与状态机，向运行时暴露 AgentHarnessTool
// - src/main/ipc/mcp.ts IPC 出口，向设置面板暴露配置 + 状态
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
import { loadSettings } from "@/main/settings/store";
import {
  isValidMcpServerId,
  mcpServerLabel,
  qualifyMcpToolName,
  type McpConnectionStatus,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerState,
  type McpServerView,
  type McpToolInfo,
} from "@/shared/contracts/mcp";
import type { Settings } from "@/shared/contracts/settings";
import type { AppToolContext } from "./tools";
import { createMcpTool } from "./tools/mcp";

/**
 * 一次交给模型的 MCP 工具上限。
 *
 * 所有已注册工具每轮都会进请求体，server 一多（或某个 server 工具特别多）就会把
 * 上下文与费用一起推高。超限只截断并记日志，不静默丢掉整批工具。
 */
const MAX_MCP_TOOLS = 64;

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
  /** 用一份草稿配置试连一次，不影响正在运行的连接 */
  probe(config: McpServerConfig): Promise<McpProbeResult>;
  /** 调用通道：工具包装层用它转发 tools/call */
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult>;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  function toViews(configs: McpServerConfig[]): McpServerView[] {
    return [...configs]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((config) => ({ config, state: stateOf(config) }));
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

  /** 同步收集当前工具：建会话时调用，不做任何等待 */
  function collectTools(): AgentHarnessTool<AppToolContext>[] {
    const result: AgentHarnessTool<AppToolContext>[] = [];
    for (const [id, entry] of entries) {
      if (entry.status !== "ready") continue;
      const serverName = mcpServerLabel(entry.config);
      for (const tool of [...entry.tools].sort((a, b) => a.name.localeCompare(b.name))) {
        if (result.length >= MAX_MCP_TOOLS) {
          warn(`MCP 工具超过 ${MAX_MCP_TOOLS} 个，已省略其余工具（${id}）`);
          return result;
        }
        result.push(
          createMcpTool<AppToolContext>(
            {
              serverId: id,
              serverName,
              toolName: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              ...(tool.readOnly === undefined ? {} : { readOnly: tool.readOnly }),
            },
            { callTool },
          ),
        );
      }
    }
    return result;
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
      return toViews((await deps.getSettings()).mcpServers);
    },
    async reload() {
      if (disposed) return [];
      const settings = await deps.getSettings();
      const wanted = settings.mcpServers.filter((config) => isValidMcpServerId(config.id));
      const byId = new Map(wanted.map((config) => [config.id, config]));

      for (const [id, entry] of [...entries]) {
        const next = byId.get(id);
        // 被删掉或被停用：关连接并从连接表摘掉（视图仍会以 idle 状态展示它）
        if (next === undefined || !next.enabled) {
          await closeEntry(entry);
          entries.delete(id);
          continue;
        }
        // 连接参数变了：先关，下面统一重连
        if (!sameConnection(entry.config, next)) await closeEntry(entry);
      }

      await Promise.all(
        wanted.filter((config) => config.enabled).map((config) => ensureConnected(config)),
      );
      notify();
      return toViews(wanted);
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
