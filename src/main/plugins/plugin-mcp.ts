// 插件的 `mcp.json` → 宿主的 `McpServerConfig`。
//
// **纯函数**：吃「已校验的清单 + 已解析的 mcp.json 对象」，吐「能用的配置 + 问题清单」。
// 读文件在 contributions 那一层，所以这里的每条规则都能单测。
//
// ## 为什么不能直接把成员名当 server id
//
// Agent Plugins 对 `mcp.json` 的成员名**没有任何字符集约束**（那是别的客户端的形状，
// 它们不需要 id —— 工具名前缀直接取成员名）。而 Oint 的 `isValidMcpServerId` 要求
// `^[a-z0-9][a-z0-9_-]*$` **且不含 `__`**（`__` 是工具限定名的分隔符，
// 也是批量授权规则 `mcp__<id>__*` 的边界）。
//
// 所以 id 由宿主生成：`p_<插件 id 归一>_<成员名归一>`。
// **用完整的插件 id 而不是它的最后一段**：`a.git` 与 `b.git` 都贡献一个叫 `github`
// 的 server 时，只用末段会撞成同一个 id —— 而 server id 撞车的后果是
// 「两台 server 的工具混在一份权限规则下」。
//
// ## 权限是硬门槛，不是提示
//
// 一个插件 ship 了 stdio server 却没申请 `mcp.server.local`，那条**不装载**，
// 而且要有诊断 —— 这正是不抄 PI-Desktop「声明了就自动授予」的地方：
// 它的权限校验对未声明的能力是"跳过"，于是"我明明没给这个权限"与
// "我给了但它没生效"在界面上长得一样。

import {
  isValidMcpServerId,
  MCP_NAME_SEPARATOR,
  type McpServerConfig,
} from "@/shared/contracts/mcp";
import type { OintPluginManifest, PluginPermission } from "@/shared/contracts/plugin";

/** 一条由插件提供的 MCP server */
export interface PluginMcpServer {
  config: McpServerConfig;
  /** 提供它的插件 id（面板上「来自插件 X」） */
  pluginId: string;
  /** 插件 `mcp.json` 里那一项的原始名字 */
  memberName: string;
}

/** 一条没能装载的成员及其原因 */
export interface PluginMcpIssue {
  pluginId: string;
  memberName: string;
  message: string;
}

export interface PluginMcpResult {
  servers: PluginMcpServer[];
  issues: PluginMcpIssue[];
}

/**
 * server id 的长度上限。
 *
 * 工具限定名是 `mcp__<serverId>__<toolName>`，而它**每个请求都要进模型上下文**。
 * 只按"够不够短"看是几十个 token 的事，但一个装了十个插件的用户会看到工具清单
 * 被这些前缀占掉可观的一截。40 是"可读"与"不浪费"之间的取舍点。
 */
const MAX_SERVER_ID = 40;

/** id 归一：白名单字符之外全部替换成 `_`，并把 `__` 压成 `_`（它会破坏工具名切分） */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+/, "");
}

/**
 * 从插件成员名与插件 id 造一个合法的 server id。
 *
 * 超长时截断并**在尾部保留一段来自完整 id 的指纹** —— 截断而不加指纹会让
 * 两个长 id 的插件撞成同一个 server id（前缀相同的插件很常见，
 * 比如 `dev.acme.tools-a` 与 `dev.acme.tools-b` 归一后前 30 位一样）。
 */
export function pluginServerId(pluginId: string, memberName: string): string {
  const full = `p_${slug(pluginId)}_${slug(memberName)}`.replace(/_+/g, "_");
  if (full.length <= MAX_SERVER_ID) return full;
  const fingerprint = shortHash(full);
  return `${full.slice(0, MAX_SERVER_ID - fingerprint.length - 1)}_${fingerprint}`;
}

/** 稳定的短指纹（FNV-1a 的 32 位结果转 36 进制，6 位以内） */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(0, 6);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/**
 * 把 `mcp.json` 的成员逐条转成宿主配置。
 *
 * 两种传输按**形状**判而不是按显式字段：有 `url` 就是远端，有 `command` 就是本地。
 * 这与别的客户端读同一份文件的方式一致 —— 让插件作者多写一个 `"type": "stdio"`
 * 只会制造一种"写了但没人读"的字段。
 */
export function buildPluginMcpServers(
  manifest: OintPluginManifest,
  raw: Record<string, unknown>,
): PluginMcpResult {
  const servers: PluginMcpServer[] = [];
  const issues: PluginMcpIssue[] = [];
  const granted = new Set<PluginPermission>(manifest.permissions);

  for (const [memberName, value] of Object.entries(raw)) {
    const fail = (message: string): void => {
      issues.push({ pluginId: manifest.id, memberName, message });
    };

    if (!isRecord(value)) {
      fail("必须是一个对象");
      continue;
    }

    const url = typeof value.url === "string" ? value.url.trim() : "";
    const command = typeof value.command === "string" ? value.command.trim() : "";

    if (url === "" && command === "") {
      fail("必须给出 command（本地）或 url（远端）之一");
      continue;
    }
    if (url !== "" && command !== "") {
      // 两者都给时无法判断意图，而猜错的后果是"跑了本地的却没连上期望的远端"
      fail("不能同时给出 command 与 url");
      continue;
    }

    const remote = url !== "";
    const needed: PluginPermission = remote ? "mcp.server.remote" : "mcp.server.local";
    if (!granted.has(needed)) {
      fail(`提供了 ${remote ? "远端" : "本地"} server 却没有申请 "${needed}" 权限`);
      continue;
    }

    const id = pluginServerId(manifest.id, memberName);
    if (!isValidMcpServerId(id)) {
      // 理论上到不了这里（归一已经保证字符集），留一条兜底而不是静默
      fail(`生成的 server id 不合法：${id}`);
      continue;
    }
    if (id.includes(MCP_NAME_SEPARATOR)) {
      fail(`生成的 server id 含 ${MCP_NAME_SEPARATOR}：${id}`);
      continue;
    }

    servers.push({
      pluginId: manifest.id,
      memberName,
      config: {
        id,
        // 名字带上插件来源：MCP 面板里同时有系统预设与用户配置，
        // 一个光秃秃的 "github" 看不出是谁给的
        name: `${memberName}（${manifest.name}）`,
        // 启停交给 MCP 面板那一层（用户可以在那里关掉单台），插件这一层默认开
        enabled: true,
        transport: remote ? "http" : "stdio",
        command,
        args: Array.isArray(value.args)
          ? value.args.filter((entry): entry is string => typeof entry === "string")
          : [],
        env: stringRecord(value.env),
        cwd: typeof value.cwd === "string" ? value.cwd : "",
        url,
        headers: stringRecord(value.headers),
        // 用 0 而不是 Date.now()：配置是**每次启动都重算**的派生物，
        // 时间戳每次都不一样会让"这条是不是新装的"这类判断失去意义
        createdAt: 0,
      },
    });
  }

  return { servers, issues };
}
