// 系统 MCP 预设：随应用分发、**完全免费、零配置**的远端 server 清单。
//
// ## 为什么住在代码里，而不是 `resources/mcp/*.json`
//
// 技能与魔法提示住在磁盘上（`resources/skills`、`resources/prompts`）是因为它们的正文很长、
// 由用户按需读取，磁盘是它们的自然形态。预设不一样：每一条只是「一个 id + 一个 URL + 一句说明」，
// 而**说明要跟着界面语言变**（走 i18n 键）—— 放进 JSON 就得在数据文件里塞 i18n 键名，
// 反而比直接写在代码里更绕。所以这里选代码注册表：类型安全、双语说明直接可查、
// 也不可能出现「文件没进包」的静默失败。
//
// ## 准入标准（三条都要满足）
//
// 1. **用户什么都不用填就能连上**：只收远端 HTTPS（streamable-http）端点。
//    不收 `npx` / `uvx` 这类 stdio 预设（要求用户机器上装了 Node 或 uv），
//    也不收需要 API Key / OAuth 的（Hugging Face、GitHub、Sentry、Notion 这类一律排除）。
//    本机的 stdio server 仍然完全支持，只是走「用户配置」那一层。
// 2. **通用**：不绑定某一个具体项目或厂商 —— 服务对象是「任何库 / 任何主题 / 任何领域」。
//    所以厂商专属文档（Microsoft Learn、AWS Knowledge、Cloudflare Docs、Mapbox Docs、
//    各家框架文档）不进这张表，它们属于「用户自己按需添加」的那一层。
// 3. **全球**：数据覆盖全球或多国，而不是单城市 / 单州 / 单国专用。
//    地区性数据（纽约地铁、华盛顿州路况、日本亲子酒店、美股/台股/韩股行情、
//    美国普查与财政部数据）同样不进这张表。
//
// 每一条都经过**真实握手 + 真实工具调用**实测：`docs/system-presets-layer.md` 记录了口径，
// 联网用例见 `src/main/pisdk/mcp-presets.live.test.ts`。
//
// ## 与用户配置的关系
//
// 同 id 时**用户配置整条胜出**（与技能、子智能体的「同名用户覆盖内置」同一条原则）：
// 用户手写过 context7 的配置，生效的就是他自己那份，系统预设不会和他抢。
// 系统预设本身**不可编辑、不可删除**，只能启用 / 停用（调用一律免审批，没有信任开关）；
// 启停选择记在 `Settings.systemMcpServerEnabled`。
//
// ## 工具预算：为什么每台 server 只有一个聚合工具
//
// 这张表有十几台 server、上百个工具。每个工具的 JSON Schema 每轮都会进请求体 ——
// 全量展开会直接把上下文与费用推高，还会撞上工具数上限被静默截断。
// 所以每台 server 恒定只暴露一个聚合工具 `mcp__<serverId>__call`，
// 细节由内置工具 `mcp_tools` 按需读取。详见 contracts/mcp.ts 里 MCP_GATEWAY_TOOL_NAME 的说明。

import type { McpServerConfig, McpServerSource } from "@/shared/contracts/mcp";
import { isValidMcpServerId, parseMcpToolName } from "@/shared/contracts/mcp";
import type { Settings } from "@/shared/contracts/settings";

/** 面板里的领域分组（只影响展示顺序与分组标题，不影响任何行为） */
export type McpPresetCategory =
  | "knowledge"
  | "search"
  | "academic"
  | "earth"
  | "health"
  | "finance"
  | "culture";

/** 分组顺序：越靠前越「通用」 */
export const MCP_PRESET_CATEGORIES: readonly McpPresetCategory[] = [
  "knowledge",
  "search",
  "academic",
  "earth",
  "health",
  "finance",
  "culture",
];

/** 一条系统预设的声明（不含 createdAt / enabled —— 那两个由下面的转换函数算出来） */
export interface BuiltinMcpServer {
  /** serverId：会出现在工具限定名 `mcp__<id>__<tool>` 与批量授权规则里，必须合法且稳定 */
  id: string;
  /** 展示名：用**品牌名**（跨语言安全，不做翻译） */
  name: string;
  /** 远端 streamable-http 端点 */
  url: string;
  /** 面板里那句说明的 i18n 键（双语都要有，check-i18n 会校验） */
  descriptionKey: string;
  /** 面板分组 */
  category: McpPresetCategory;
  /**
   * 首次使用时的默认状态。
   *
   * 这一批是「通用 + 全球 + 实测可用」的集合，所以**默认全部开启**；
   * 工具预算由聚合策略兜住（见文件头最后一节），不靠「默认少开几个」来省上下文。
   */
  defaultEnabled: boolean;
}

/**
 * 随包分发的系统 MCP 预设（顺序即面板里的展示顺序，按领域分组）。
 *
 * 加一条之前先做三件事：① 用真实握手确认端点活着、且**不带任何 Key** 能列出工具；
 * ② 真调一次工具确认返回的是真实数据（「能握手」不等于「能用」——
 * 实测见过握手与 tools/list 全过、只有 tools/call 才 403 的端点）；
 * ③ 想清楚它是不是「通用 + 全球」的。
 */
export const BUILTIN_MCP_SERVERS: readonly BuiltinMcpServer[] = [
  // —— 知识与百科 ——
  {
    id: "wolfram",
    name: "Wolfram",
    url: "https://agenttools.wolfram.com/mcp",
    descriptionKey: "settings.mcpBuiltin.wolfram",
    category: "knowledge",
    defaultEnabled: true,
  },
  {
    id: "wikipedia",
    name: "Wikipedia",
    url: "https://wikipedia.caseyjhand.com/mcp",
    descriptionKey: "settings.mcpBuiltin.wikipedia",
    category: "knowledge",
    defaultEnabled: true,
  },
  {
    id: "wikidata",
    name: "Wikidata",
    url: "https://wikidata.caseyjhand.com/mcp",
    descriptionKey: "settings.mcpBuiltin.wikidata",
    category: "knowledge",
    defaultEnabled: true,
  },
  {
    id: "edgepedia",
    name: "Edgepedia",
    url: "https://www.edgechat.ai/mcp",
    descriptionKey: "settings.mcpBuiltin.edgepedia",
    category: "knowledge",
    defaultEnabled: true,
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    url: "https://mcp.deepwiki.com/mcp",
    descriptionKey: "settings.mcpBuiltin.deepwiki",
    category: "knowledge",
    defaultEnabled: true,
  },
  {
    id: "mdn",
    name: "MDN",
    url: "https://mcp.mdn.mozilla.net/mcp",
    descriptionKey: "settings.mcpBuiltin.mdn",
    category: "knowledge",
    defaultEnabled: true,
  },
  {
    id: "context7",
    name: "Context7",
    url: "https://mcp.context7.com/mcp",
    descriptionKey: "settings.mcpBuiltin.context7",
    category: "knowledge",
    defaultEnabled: true,
  },

  // —— 搜索与抓取 ——
  {
    id: "exa-search",
    name: "Exa Search",
    url: "https://mcp.exa.ai/mcp",
    descriptionKey: "settings.mcpBuiltin.exaSearch",
    category: "search",
    defaultEnabled: true,
  },
  {
    id: "grep-app",
    name: "grep.app",
    url: "https://mcp.grep.app",
    descriptionKey: "settings.mcpBuiltin.grepApp",
    category: "search",
    defaultEnabled: true,
  },

  // —— 学术与科学 ——
  {
    id: "arxiv",
    name: "arXiv",
    url: "https://arxiv.caseyjhand.com/mcp",
    descriptionKey: "settings.mcpBuiltin.arxiv",
    category: "academic",
    defaultEnabled: true,
  },
  {
    id: "pubmed",
    name: "PubMed",
    url: "https://pubmed.caseyjhand.com/mcp",
    descriptionKey: "settings.mcpBuiltin.pubmed",
    category: "academic",
    defaultEnabled: true,
  },
  {
    id: "crossref",
    name: "Crossref",
    url: "https://crossref.caseyjhand.com/mcp",
    descriptionKey: "settings.mcpBuiltin.crossref",
    category: "academic",
    defaultEnabled: true,
  },

  // —— 地球与气候 ——
  {
    id: "open-meteo",
    name: "Open-Meteo",
    url: "https://open-meteo.caseyjhand.com/mcp",
    descriptionKey: "settings.mcpBuiltin.openMeteo",
    category: "earth",
    defaultEnabled: true,
  },

  // —— 健康与医学 ——
  {
    id: "who-gho",
    name: "WHO GHO",
    url: "https://who-gho.caseyjhand.com/mcp",
    descriptionKey: "settings.mcpBuiltin.whoGho",
    category: "health",
    defaultEnabled: true,
  },

  // —— 金融与统计 ——
  {
    id: "worldbank",
    name: "World Bank",
    url: "https://worldbank.caseyjhand.com/mcp",
    descriptionKey: "settings.mcpBuiltin.worldbank",
    category: "finance",
    defaultEnabled: true,
  },
  // 注：Manifold Markets（预测市场）曾被收录，但它的端点在实测环境里 DNS/连接全部失败
  //（api.manifold.markets/v0/mcp 与三个变体都不可达）。按「每条预设都必须真实握手通过」的
  // 准入标准，它先不进内置 —— 想用的人可以在「用户」页签自己加。

  // —— 文化与生活 ——
  {
    id: "dynamic-feed",
    name: "DynamicFeed",
    url: "https://dynamicfeed.ai/mcp",
    descriptionKey: "settings.mcpBuiltin.dynamicFeed",
    category: "culture",
    defaultEnabled: true,
  },
];

/** 预设 → 运行时配置；`enabled` 由调用方算好（见 resolveMcpServerEntries） */
export function builtinMcpConfig(preset: BuiltinMcpServer, enabled: boolean): McpServerConfig {
  return {
    id: preset.id,
    name: preset.name,
    enabled,
    transport: "http",
    // stdio 那一侧的字段整体留空：预设只用远端端点（见文件头「准入标准」第 1 条）
    command: "",
    args: [],
    env: {},
    cwd: "",
    url: preset.url,
    headers: {},
    // 系统条目没有「创建时间」可言，统一为 0；面板顺序由 resolveMcpServerEntries 决定
    createdAt: 0,
  };
}

/** 按 id 找预设（面板用它取说明文案、分组与默认状态）；不是预设时返回 undefined */
export function findBuiltinMcpServer(id: string): BuiltinMcpServer | undefined {
  return BUILTIN_MCP_SERVERS.find((preset) => preset.id === id);
}

/** 一行解析结果：面板要的「配置 + 它从哪来」 */
export interface ResolvedMcpServer {
  config: McpServerConfig;
  source: McpServerSource;
  /**
   * 这一条是否**被另一层同 id 的配置盖住**。
   *
   * 两边都可能为 true：系统预设被用户配置盖住时，系统那一条标 true（面板解释「为什么改了它没生效」）；
   * 用户配置盖住系统预设时也标 true（面板提示「你这一条正在替代系统预设」）。
   */
  overridden: boolean;
}

/**
 * 把「系统预设 + 插件声明 + 用户配置」解析成面板要的一行行清单。
 *
 * 顺序：**系统（注册表顺序）→ 插件（插件顺序）→ 用户（设置文件里的顺序）**。
 * 这个顺序不是优先级，是**展示顺序**；优先级由 `overridden` 表达 ——
 * 后面同 id 的层盖住前面的。
 *
 * 这是三层唯一的合并口径 —— 运行时取工具（mcp-servers.ts）与设置面板都走它，
 * 所以「面板里显示的」与「实际连接、实际给模型的」不会漂移。
 *
 * `pluginServers` 由调用方注入（主进程从插件注册表算出来）。**这个函数不能自己去读**：
 * 它在 `shared/` 里，而插件注册表是主进程 + 异步的。
 * 注入点只有一处（mcp-servers.ts 的局部包装），所以不存在"四处各算一遍"。
 */
export function resolveMcpServerEntries(
  settings: Settings,
  pluginServers: McpServerConfig[] = [],
): ResolvedMcpServer[] {
  const userIds = new Set(settings.mcpServers.map((config) => config.id));
  const pluginIds = new Set(pluginServers.map((config) => config.id));

  const entries: ResolvedMcpServer[] = BUILTIN_MCP_SERVERS.map((preset) => ({
    config: builtinMcpConfig(preset, isSystemServerEnabled(settings, preset)),
    source: "system" as const,
    // 系统预设被**任何**后面的层盖住。两层都要看：只看用户那一层的话，
    // 插件盖住了预设而面板仍显示它是生效的
    overridden: userIds.has(preset.id) || pluginIds.has(preset.id),
  }));

  for (const config of pluginServers) {
    entries.push({
      config,
      source: "plugin",
      // 用户配置盖住插件：用户手写的那一份永远优先（与"用户覆盖插件技能"同一条原则）
      overridden: userIds.has(config.id),
    });
  }

  for (const config of settings.mcpServers) {
    entries.push({
      config,
      source: "user",
      overridden: findBuiltinMcpServer(config.id) !== undefined || pluginIds.has(config.id),
    });
  }
  return entries;
}

/**
 * 系统预设**生效的**启停状态：用户在设置里明确选过就以他为准，没选过才回落到预设默认值。
 *
 * 用「显式选择表」而不是「禁用表」是因为预设的默认值未来可能不一致：
 * 只记禁用的话，「默认关的那个用户打开了」这件事无处可记。
 */
export function isSystemServerEnabled(settings: Settings, preset: BuiltinMcpServer): boolean {
  return settings.systemMcpServerEnabled[preset.id] ?? preset.defaultEnabled;
}

/**
 * 系统预设是否**免审批**（不弹审批卡）：是，一律是。
 *
 * 这些端点随包分发、逐条实测过，用户既没有申请 Key 也没有手填地址 ——
 * 让「查一下维基百科」弹一次审批卡只会把这个能力废掉。所以**没有开关**，
 * 面板上也不给信任切换。用户自己加的 server 不走这条路径
 *（它们仍按老逻辑：弹卡，或由用户点「始终允许」写入 `mcp__<id>__*` 规则）。
 */
export function isSystemServerTrusted(serverId: string): boolean {
  return findBuiltinMcpServer(serverId) !== undefined;
}

/**
 * 运行时实际要连接、要暴露工具的配置：同 id 时用户配置胜出，且只保留启用中的那些。
 *
 * 注意「排重后仍可能一条都不剩」是正常的 —— 用户把某个预设停用、又没配自己的 server 时就是这样。
 */
export function effectiveMcpServerConfigs(
  settings: Settings,
  pluginServers: McpServerConfig[] = [],
): McpServerConfig[] {
  const configs: McpServerConfig[] = [];
  for (const entry of resolveMcpServerEntries(settings, pluginServers)) {
    if (!entry.config.enabled) continue;
    /*
      被后面某一层盖住的**前面的层**跳过，让盖住它的那一份进列表（id 相同，运行时只认一个）。
      用户那一层永远不被盖（它是最后一层），所以它的 overridden 只用于界面提示。
    */
    if (entry.source !== "user" && entry.overridden) continue;
    if (!isValidMcpServerId(entry.config.id)) continue;
    configs.push(entry.config);
  }
  return configs;
}

/**
 * 这个工具名是不是「系统预设」——也就是运行时权限门要不要**跳过审批卡**。
 *
 * 抽成纯函数是为了能直接单测：这段逻辑一旦写错，方向只有两种，都很糟 ——
 * 要么系统预设每次调用都弹卡（一个「查一下维基百科」变成一次点击），
 * 要么把用户自己加的 server 也一起放行（审批门形同虚设）。
 *
 * 注意它与 `assessToolRisk` 的分工：那里给 MCP 工具一律判 high（名字与行为由外部决定），
 * 免审批只在这里按 **serverId 是不是预设**判定，两者缺一不可。
 */
export function isPreTrustedMcpTool(toolName: string): boolean {
  const parsed = parseMcpToolName(toolName);
  if (parsed === null) return false;
  return isSystemServerTrusted(parsed.serverId);
}
