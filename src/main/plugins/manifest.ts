// 清单校验器。
//
// **纯函数**：吃一个 `unknown`（`JSON.parse` 的结果），吐一个判别联合。
// 不碰文件系统，所以每条规则都能单测 —— 存储与发现那一层（discovery.ts）负责
// 读文件与解析 JSON，把"读不到"和"读到了但不合法"分开报。
//
// ## 规则的来源
//
// 每一条都对应 docs/plugin-system-plan.md §4.4 的十条校验规则，其中几条是从
// PI-Desktop 的**实际行为**里学来的（那边规范与实现有四处背离，见那份方案 §2.1.4b）。
// 最值得记住的两条：
//
//  1. **未知私有字段 = 失败，不是忽略。** PI-Desktop 的校验器结构体里没有
//     `activationEvents` / `engines` / `entrypoints`，但文档与真实例子里都写着它们 ——
//     作者照着文档写触发器，然后奇怪插件为什么没被激活。
//  2. **Agent Plugins 根上的未知字段 = 报告并忽略。** 那是规范 §5.2 的 MUST：
//     别的客户端的命名空间必须能被无视地穿过。**运行时宽松、作者工具严格**：
//     `oint-plugin check` 会把这类 warning 升级为错误（那是另一处的事）。
//
// ## 与本文件无关的一类检查
//
// **路径是否真的落在插件根内**（realpath 那一层）不在这里：它需要文件系统。
// 这里只做**纯字符串**的 `..` 与绝对路径拒绝 —— 那是清单本身的形状问题；
// 符号链接那一层由 discovery / 协议处理器在解析真实路径时判。

import path from "node:path";
import { isInsidePath } from "@/main/security/path-guard";
import {
  AGENT_PLUGINS_SCHEMA_1_0_0,
  OINT_EXTENSION_NAMESPACE,
  OINT_PLUGIN_API_VERSION,
  type OintPluginManifest,
  PLUGIN_HOOK_EVENTS,
  PLUGIN_PERMISSIONS,
  type PluginFsRule,
  type PluginHookDecl,
  type PluginHookEvent,
  type PluginManifestIssue,
  type PluginManifestResult,
  type PluginPermission,
  type PluginSurfaceDecl,
} from "@/shared/contracts/plugin";
import { MAX_HOOKS_PER_PLUGIN } from "@/shared/contracts/plugin-rpc";

/** Agent Plugins §5.5 的 name 文法（1–64、小写字母数字点连字符、首尾字母数字、禁 `--` 与 `..`） */
const AGENT_PLUGINS_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** 反向域名：`dev.example.git-lens` */
const REVERSE_DOMAIN = /^[a-z0-9]+(?:\.[a-z0-9_-]+)+$/;

/** 界面 id：字母开头，字母数字下划线连字符 */
const SURFACE_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** 裸命令名：不含路径分隔符、盘符、空格 */
const BARE_COMMAND = /^[A-Za-z0-9._+-]+$/;

/** 钩子 id：与界面 id 同一字符集（宿主按它分派，插件内唯一） */
const HOOK_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** 匹配器的长度上限。正则本身是线性的，这里只是防"把一整段正则贴进来" */
const MAX_HOOK_MATCHER_CHARS = 200;

/**
 * 生态里**存在但宿主还没支持**的钩子事件。
 *
 * 单列出来只为了一件事：让报错文案能说"这不是你写错了，是还没做"。
 * 含糊的一句"未知事件"会让作者去翻文档、怀疑自己拼错了，而真相是宿主这一侧还没有挂点。
 */
const PLANNED_HOOK_EVENTS: readonly string[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
];

function isSupportedHookEvent(value: unknown): value is PluginHookEvent {
  return typeof value === "string" && (PLUGIN_HOOK_EVENTS as readonly string[]).includes(value);
}

/** 能不能编译成正则。**判据是试编译**，不自己写一套正则文法（那一定会漏） */
function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * 整树通配：把通配符（`*`）与分隔符（`.` `/`）剥掉之后什么都不剩。
 *
 * 判据是从 PI-Desktop 的实现里抄的（把这三类字符全去掉再看是否为空），
 * 它同时抓住 `**`、`**&#47;*`、`*&#47;**`、`./*` 四种写法。**写与删禁止整树**，读允许 ——
 * 理由见下面 checkFsRule 的说明。
 *
 * （注释里用 `&#47;` 转义斜杠而不是直接写：`*` 紧跟 `/` 会把块注释提前闭合 ——
 * 本文件第一次就是那么写的，编译器报的是一串莫名其妙的语法错误。）
 */
export function isWholeTreePattern(value: string): boolean {
  return value.replace(/[*/.]/g, "") === "";
}

const KNOWN_PERMISSIONS = new Set<string>(PLUGIN_PERMISSIONS);

/** `extensions["dev.oint"]` 里允许出现的键；表外一律失败（规则：不要发布没实现的字段） */
const KNOWN_OINT_KEYS = new Set([
  "id",
  "apiVersion",
  "permissions",
  "fs",
  "net",
  "shell",
  "main",
  "hooks",
  "surfaces",
]);

const KNOWN_SURFACE_KEYS = new Set([
  "id",
  "kind",
  "title",
  "icon",
  "order",
  "entry",
  "shape",
  "width",
  "height",
  "alwaysOnTop",
  "resizable",
  "skipTaskbar",
  "openAt",
]);

/** 一条钩子声明里允许出现的键（表外一律失败） */
const KNOWN_HOOK_KEYS = new Set(["id", "event", "matcher", "failure"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 收集错误的小工具：让每条规则只关心"怎么判"，不关心"怎么记" */
class Issues {
  readonly list: PluginManifestIssue[] = [];
  error(path: string, message: string): void {
    this.list.push({ path, message, severity: "error" });
  }
  warn(path: string, message: string): void {
    this.list.push({ path, message, severity: "warning" });
  }
  get hasError(): boolean {
    return this.list.some((issue) => issue.severity === "error");
  }
}

/**
 * 相对路径的形状检查（**不碰文件系统**）。
 *
 * 三条：必须是 `./` 开头的相对路径、不得含 `..`、解析后必须落在根内。
 * Agent Plugins §4.1 要求一切"插件相对路径"以 `./` 开头，这使得
 * "这是一个包内路径"在形状上就与"这是一个系统路径"区分开。
 */
function checkRelativeEntry(value: unknown, field: string, issues: Issues): string | undefined {
  if (!isNonEmptyString(value)) {
    issues.error(field, "必须是一个非空字符串（相对插件根的路径，以 ./ 开头）");
    return undefined;
  }
  if (!value.startsWith("./")) {
    issues.error(field, `必须是 ./ 开头的插件相对路径，收到 "${value}"`);
    return undefined;
  }
  // 用一个假根来归一：`/plugin` 是任意占位，这里只关心它有没有跑出去
  const resolved = path.resolve("/plugin", value);
  if (!isInsidePath(resolved, "/plugin")) {
    issues.error(field, `路径跑出了插件根：${value}`);
    return undefined;
  }
  return value;
}

/** 一条 fs 范围规则 */
function checkFsRule(
  raw: unknown,
  mode: "read" | "write" | "delete",
  issues: Issues,
): PluginFsRule | undefined {
  const field = `extensions.${OINT_EXTENSION_NAMESPACE}.fs.${mode}`;
  if (!isRecord(raw)) {
    issues.error(field, "必须是一个对象");
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (key !== "root" && key !== "scope" && key !== "own") {
      issues.error(`${field}.${key}`, `未知字段 "${key}"（允许 root / scope / own）`);
    }
  }

  /*
    root 的取值校验与取值分开写：校验那一步只负责"报错"，取值这一步负责"窄化类型"。
    合成一句的话 TS 不肯把 `unknown` 收窄到那三个字面量 —— 而 split 之后
    `root` 的类型是真正窄过的，下面构造返回值时不用断言。
  */
  const rawRoot = raw.root;
  if (
    rawRoot !== undefined &&
    rawRoot !== "workspace" &&
    rawRoot !== "pluginData" &&
    rawRoot !== "userSelected"
  ) {
    issues.error(`${field}.root`, "必须是 workspace / pluginData / userSelected 之一");
  }
  const root =
    rawRoot === "workspace" || rawRoot === "pluginData" || rawRoot === "userSelected"
      ? rawRoot
      : undefined;
  /*
    `own` 只对 delete 合法。允许 write 声明它没有意义 —— write 本来就是"写自己的"，
    而 delete 的 own 表达的是"只能删自己写过的"（走写账本）。
  */
  if (raw.own !== undefined && mode !== "delete") {
    issues.error(`${field}.own`, `只有 delete 支持 own`);
  }

  let scope: string[] | undefined;
  if (raw.scope !== undefined) {
    if (!Array.isArray(raw.scope)) {
      issues.error(`${field}.scope`, "必须是字符串数组");
    } else {
      scope = raw.scope.filter(isNonEmptyString);
      if (scope.length !== raw.scope.length) {
        issues.error(`${field}.scope`, "每一项都必须是非空字符串");
      }
      for (const pattern of scope) {
        if (path.isAbsolute(pattern) || pattern.startsWith("..")) {
          issues.error(`${field}.scope`, `范围必须是相对路径：${pattern}`);
        }
        /*
          **写与删禁止整树通配，读允许。**
          这不是对称的美学问题：读只有在"字节能出去"时才危险，而那半边由 net.domains
          关掉；写与删本身就有破坏性，无法用别的东西兜底 —— 所以必须一开始就声明得窄。
          PI-Desktop 的原话：the egress allowlist is what makes a broad read safe and
          nothing makes a broad write safe.
        */
        if (mode !== "read" && isWholeTreePattern(pattern)) {
          issues.error(
            `${field}.scope`,
            `写与删不能声明整树通配（${pattern}）—— 请写明具体子目录，读可以放宽`,
          );
        }
      }
    }
  }

  return {
    ...(root === undefined ? {} : { root }),
    ...(scope === undefined ? {} : { scope }),
    ...(raw.own === true ? { own: true } : {}),
  };
}

/** 一个界面声明 */
function checkSurface(
  raw: unknown,
  index: number,
  permissions: readonly PluginPermission[],
  issues: Issues,
): PluginSurfaceDecl | undefined {
  const field = `extensions.${OINT_EXTENSION_NAMESPACE}.surfaces[${index}]`;
  if (!isRecord(raw)) {
    issues.error(field, "必须是一个对象");
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SURFACE_KEYS.has(key)) {
      issues.error(`${field}.${key}`, `未知字段 "${key}"`);
    }
  }

  const id = raw.id;
  if (!isNonEmptyString(id) || !SURFACE_ID.test(id)) {
    issues.error(`${field}.id`, "必须是字母开头的 1–64 位字母数字下划线连字符");
  }

  const kind = raw.kind;
  if (kind !== "panel" && kind !== "window" && kind !== "modal") {
    issues.error(`${field}.kind`, `必须是 panel、modal 或 window`);
  } else {
    /*
      **界面形态需要对应权限，缺权限 = 校验失败**（不是静默跳过）。
      这条与「贡献物缺权限就失败」是同一条纪律，理由也一样：一个装上了却画不出来的
      面板，作者只会以为自己的 HTML 写错了。

      三种形态各占一条权限而不是共用一条：权限卡上要能读出**界面会出现在哪**——
      「打开一个模态窗」与「显示一个面板」对用户是两件不同的事。
    */
    const needed: PluginPermission =
      kind === "panel" ? "ui.panel" : kind === "modal" ? "ui.modal" : "ui.window";
    if (!permissions.includes(needed)) {
      issues.error(`${field}.kind`, `声明了 ${kind} 界面就必须申请 "${needed}" 权限`);
    }
  }

  const entry = checkRelativeEntry(raw.entry, `${field}.entry`, issues);

  const title = raw.title;
  const titleOk =
    isNonEmptyString(title) ||
    (isRecord(title) && isNonEmptyString(title.en) && isNonEmptyString(title["zh-CN"]));
  if (!titleOk) {
    issues.error(`${field}.title`, "必须是字符串，或同时含 en 与 zh-CN 的对象");
  }

  if (raw.shape !== undefined && raw.shape !== "panel" && raw.shape !== "widget") {
    issues.error(`${field}.shape`, "必须是 panel 或 widget");
  }
  if (raw.openAt !== undefined && raw.openAt !== "enable" && raw.openAt !== "command") {
    issues.error(`${field}.openAt`, "必须是 enable 或 command");
  }
  if (kind !== "window" && raw.shape === "widget") {
    issues.error(`${field}.shape`, "只有 window 界面能用 widget 形状");
  }
  /*
    这三个字段是**窗口专有**的：模态窗没有"置顶""不进任务栏"可言，它的位置与
    层级由宿主决定；而"能不能缩放"也由宿主决定（对话框不是用户拖出来的）。
    接受它们而不生效，正是"发布了自己没实现的字段"那类错误。
  */
  if (
    kind === "modal" &&
    (raw.alwaysOnTop !== undefined || raw.skipTaskbar !== undefined || raw.resizable !== undefined)
  ) {
    issues.error(
      `${field}.kind`,
      "模态窗不支持 alwaysOnTop / skipTaskbar / resizable（那三项只有 window 界面能用）",
    );
  }

  if (
    entry === undefined ||
    !isNonEmptyString(id) ||
    (kind !== "panel" && kind !== "window" && kind !== "modal")
  ) {
    return undefined;
  }
  return {
    id,
    kind,
    ...(titleOk ? { title: title as PluginSurfaceDecl["title"] } : { title: id }),
    entry,
    ...(typeof raw.icon === "string" ? { icon: raw.icon } : {}),
    ...(typeof raw.order === "number" ? { order: raw.order } : {}),
    ...(raw.shape === "panel" || raw.shape === "widget" ? { shape: raw.shape } : {}),
    ...(typeof raw.width === "number" ? { width: raw.width } : {}),
    ...(typeof raw.height === "number" ? { height: raw.height } : {}),
    ...(raw.alwaysOnTop === true ? { alwaysOnTop: true } : {}),
    ...(raw.resizable === true ? { resizable: true } : {}),
    ...(raw.skipTaskbar === true ? { skipTaskbar: true } : {}),
    ...(raw.openAt === "enable" || raw.openAt === "command" ? { openAt: raw.openAt } : {}),
  };
}

/**
 * 校验一条钩子声明。
 *
 * ## 三类错误被刻意区分开
 *
 * 1. **打错了**（id 字符集、matcher 不是合法正则、unknown 字段）→ 常规报错；
 * 2. **写了一个生态里存在、但宿主还没支持的事件**（`SessionStart` / `UserPromptSubmit` /
 *    `Stop` / `PermissionRequest`）→ 报错文案要点名"这不是你写错了，是**还没做**"，
 *    并列出今天支持的事件。含糊的一句"未知事件"会让作者去翻文档、以为是自己拼错了；
 * 3. **`failure` 写在了不能阻断的事件上** —— 那两个 post 事件根本没有拒绝的能力
 *    （见 PLUGIN_HOOK_EVENTS），在那里写 `failure: "closed"` 是一个**做不到的承诺**：
 *    作者以为自己配了"出错就挡住"，而它永远不会挡住任何东西。
 */
function checkHook(
  raw: unknown,
  index: number,
  seenHookIds: Set<string>,
  issues: Issues,
): PluginHookDecl | undefined {
  const field = `extensions.${OINT_EXTENSION_NAMESPACE}.hooks[${index}]`;
  if (!isRecord(raw)) {
    issues.error(field, "必须是一个对象");
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_HOOK_KEYS.has(key)) {
      issues.error(`${field}.${key}`, `未知字段 "${key}"`);
    }
  }

  const id = raw.id;
  const idOk = isNonEmptyString(id) && HOOK_ID.test(id);
  if (!idOk) {
    issues.error(`${field}.id`, "必须是字母开头的 1–64 位字母数字下划线连字符");
  } else if (seenHookIds.has(id)) {
    issues.error(
      `${field}.id`,
      `钩子 id "${id}" 重复 —— 宿主按 id 分派，重复会让其中一条永远收不到调用`,
    );
  } else {
    seenHookIds.add(id);
  }

  const event = raw.event;
  const eventOk = isSupportedHookEvent(event);
  if (!eventOk) {
    const known = isNonEmptyString(event) && PLANNED_HOOK_EVENTS.includes(event);
    issues.error(
      `${field}.event`,
      Array.isArray(event) || event === undefined || event === null || typeof event !== "string"
        ? `必须是字符串事件名（支持：${PLUGIN_HOOK_EVENTS.join(" / ")}）`
        : known
          ? `"${event}" 是生态里的事件名，但宿主**还没有支持**它（今天支持：${PLUGIN_HOOK_EVENTS.join(" / ")}）—— 现在写它不会报错也不会触发，所以这里直接拒收`
          : `未知事件 "${event}"（支持：${PLUGIN_HOOK_EVENTS.join(" / ")}）`,
    );
  }

  let matcher: string | undefined;
  if (raw.matcher !== undefined) {
    if (!isNonEmptyString(raw.matcher)) {
      issues.error(`${field}.matcher`, "必须是非空字符串（大小写敏感的正则）");
    } else if (raw.matcher.length > MAX_HOOK_MATCHER_CHARS) {
      issues.error(`${field}.matcher`, `最长 ${MAX_HOOK_MATCHER_CHARS} 个字符`);
    } else if (!isValidRegex(raw.matcher)) {
      /*
        非法正则在 ZCode 那边是"永远不匹配且静默"（它自己的诊断技能把这条列为
        最难查的坑之一）。这里在校验期就拒收：钩子注册了却不触发，没有任何地方会报。
      */
      issues.error(`${field}.matcher`, `不是合法的正则表达式：${raw.matcher}`);
    } else {
      matcher = raw.matcher;
    }
  }

  if (raw.failure !== undefined) {
    if (raw.failure !== "open" && raw.failure !== "closed") {
      issues.error(`${field}.failure`, "必须是 open 或 closed");
    } else if (event !== "PreToolUse") {
      issues.error(
        `${field}.failure`,
        `只有 PreToolUse 能阻断调用，${String(raw.event)} 上写 failure 是一个做不到的承诺`,
      );
    }
  }

  if (!idOk || !eventOk) return undefined;
  return {
    id,
    event,
    ...(matcher === undefined ? {} : { matcher }),
    ...(raw.failure === "open" || raw.failure === "closed" ? { failure: raw.failure } : {}),
  };
}

/**
 * 校验一份清单。
 *
 * @param raw `JSON.parse` 的结果
 */
export function validatePluginManifest(raw: unknown): PluginManifestResult {
  const issues = new Issues();

  if (!isRecord(raw)) {
    issues.error("", "清单必须是一个 JSON 对象");
    return { ok: false, issues: issues.list };
  }

  // ── Agent Plugins 根 ──────────────────────────────────────────────────────

  /*
    `$schema` 决定"这份清单该按哪一版解释"。缺了或不认识就必须拒绝：
    规范 §5.2 的原文是 "If a client does not support the declared Agent Plugins
    version … it MUST reject the plugin"。**不认识却继续加载**是最坏的一种宽容
    —— 一份 2.0 的清单会被当成 1.0 解释，字段对不上而没有任何提示。
  */
  if (raw.$schema !== AGENT_PLUGINS_SCHEMA_1_0_0) {
    issues.error(
      "$schema",
      `必须是 "${AGENT_PLUGINS_SCHEMA_1_0_0}"（当前支持的版本）；收到 ${
        typeof raw.$schema === "string" ? `"${raw.$schema}"` : String(raw.$schema)
      }`,
    );
  }

  const name = raw.name;
  if (!isNonEmptyString(name) || name.length > 64 || !AGENT_PLUGINS_NAME.test(name)) {
    issues.error(
      "name",
      "必须是 1–64 位小写字母/数字/点/连字符，首尾为字母或数字，且不含 -- 与 ..",
    );
  }

  /*
    `version` **只要求是非空字符串**，不要求 semver。
    这是 Agent Plugins §5.4 明确规定的：*"Clients MUST NOT reject a manifest solely
    because `version` is not valid Semantic Versioning"*。为一条不参与任何逻辑的
    元数据拒绝整个插件，收益是零而代价是兼容性。
  */
  if (!isNonEmptyString(raw.version)) {
    issues.error("version", "必须是非空字符串");
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    issues.error("description", "必须是字符串");
  }

  // 根上的未知字段：报告并忽略（规范 §5.2 的 MUST），不是失败
  const knownRootKeys = new Set([
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ]);
  for (const key of Object.keys(raw)) {
    if (!knownRootKeys.has(key)) {
      issues.warn(key, `Agent Plugins 清单不认识这个字段，已忽略（"${key}"）`);
    }
  }

  // ── extensions ────────────────────────────────────────────────────────────

  const extensions = raw.extensions;
  if (!isRecord(extensions)) {
    issues.error("extensions", `必须是对象，并在 "${OINT_EXTENSION_NAMESPACE}" 下声明 Oint 的字段`);
    return { ok: false, issues: issues.list };
  }

  const oint = extensions[OINT_EXTENSION_NAMESPACE];
  if (!isRecord(oint)) {
    issues.error(
      `extensions.${OINT_EXTENSION_NAMESPACE}`,
      `缺少 Oint 的私有层（对象）。只写 skills/ 与 mcp.json 的插件在别的客户端上能跑，但 Oint 需要这一层才知道 id 与权限`,
    );
    return { ok: false, issues: issues.list };
  }

  // 私有层里的未知字段一律失败（不是 warning）—— 对 Oint 作者来说它就是打错了
  for (const key of Object.keys(oint)) {
    if (!KNOWN_OINT_KEYS.has(key)) {
      issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.${key}`, `未知字段 "${key}"`);
    }
  }

  const id = oint.id;
  if (!isNonEmptyString(id) || !REVERSE_DOMAIN.test(id)) {
    issues.error(
      `extensions.${OINT_EXTENSION_NAMESPACE}.id`,
      "必须是反向域名（如 dev.example.git-lens），全小写",
    );
  }

  const apiVersion = oint.apiVersion;
  if (apiVersion !== OINT_PLUGIN_API_VERSION) {
    issues.error(
      `extensions.${OINT_EXTENSION_NAMESPACE}.apiVersion`,
      `必须是 "${OINT_PLUGIN_API_VERSION}"；不认识的版本拒绝加载，而不是按旧版解释`,
    );
  }

  // ── 权限 ──────────────────────────────────────────────────────────────────

  const permissions: PluginPermission[] = [];
  if (!Array.isArray(oint.permissions)) {
    issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.permissions`, "必须是字符串数组");
  } else {
    const seen = new Set<string>();
    for (const entry of oint.permissions) {
      if (!isNonEmptyString(entry) || !KNOWN_PERMISSIONS.has(entry)) {
        issues.error(
          `extensions.${OINT_EXTENSION_NAMESPACE}.permissions`,
          `未知权限 "${String(entry)}"。宿主不认识的权限必须让校验失败 —— 静默忽略会让作者以为自己申请到了这个能力`,
        );
        continue;
      }
      if (seen.has(entry)) {
        issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.permissions`, `重复声明 "${entry}"`);
        continue;
      }
      seen.add(entry);
      permissions.push(entry as PluginPermission);
    }
  }

  const hasPermission = (permission: PluginPermission): boolean => permissions.includes(permission);

  // ── fs / net / shell ──────────────────────────────────────────────────────

  let fs: OintPluginManifest["fs"];
  if (oint.fs !== undefined) {
    if (!isRecord(oint.fs)) {
      issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.fs`, "必须是对象");
    } else {
      for (const key of Object.keys(oint.fs)) {
        if (key !== "read" && key !== "write" && key !== "delete") {
          issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.fs.${key}`, `未知字段 "${key}"`);
        }
      }
      const read =
        oint.fs.read === undefined ? undefined : checkFsRule(oint.fs.read, "read", issues);
      const write =
        oint.fs.write === undefined ? undefined : checkFsRule(oint.fs.write, "write", issues);
      const del =
        oint.fs.delete === undefined ? undefined : checkFsRule(oint.fs.delete, "delete", issues);
      fs = {
        ...(read === undefined ? {} : { read }),
        ...(write === undefined ? {} : { write }),
        ...(del === undefined ? {} : { delete: del }),
      };
      /*
        fs 的每一档都要有对应的权限。反过来（有权限没声明范围）是合法的 ——
        那表示"每次访问都落到运行期确认"，是 fail-closed 的形状。
      */
      for (const [mode, needed] of [
        ["read", "fs.read"],
        ["write", "fs.write"],
        ["delete", "fs.delete"],
      ] as const) {
        if (fs[mode] !== undefined && !hasPermission(needed)) {
          issues.error(
            `extensions.${OINT_EXTENSION_NAMESPACE}.fs.${mode}`,
            `声明了 fs.${mode} 范围就必须申请 "${needed}" 权限`,
          );
        }
      }
    }
  }

  let net: OintPluginManifest["net"];
  if (oint.net !== undefined) {
    if (!isRecord(oint.net)) {
      issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.net`, "必须是对象");
    } else {
      for (const key of Object.keys(oint.net)) {
        if (key !== "domains") {
          issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.net.${key}`, `未知字段 "${key}"`);
        }
      }
      if (oint.net.domains !== undefined) {
        if (!Array.isArray(oint.net.domains)) {
          issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.net.domains`, "必须是字符串数组");
        } else {
          const domains: string[] = [];
          for (const entry of oint.net.domains) {
            if (!isNonEmptyString(entry)) {
              issues.error(
                `extensions.${OINT_EXTENSION_NAMESPACE}.net.domains`,
                "每一项都必须是非空字符串",
              );
              continue;
            }
            /*
              裸 `*` 拒绝，但 `*.example.com` 允许。
              前者是"去哪都行"，等于没有出站白名单；后者是一个明确的域及其子域。
            */
            if (entry === "*") {
              issues.error(
                `extensions.${OINT_EXTENSION_NAMESPACE}.net.domains`,
                `不允许裸 "*" —— 请逐条列出你要访问的主机（可以用 *.example.com 覆盖子域）`,
              );
              continue;
            }
            if (/[:/?#]/.test(entry)) {
              issues.error(
                `extensions.${OINT_EXTENSION_NAMESPACE}.net.domains`,
                `只写主机名，不要带协议/端口/路径：${entry}`,
              );
              continue;
            }
            domains.push(entry);
          }
          net = { domains };
        }
      }
      if (net !== undefined && net.domains.length > 0 && !hasPermission("net.fetch")) {
        issues.error(
          `extensions.${OINT_EXTENSION_NAMESPACE}.net.domains`,
          `声明了出站白名单就必须申请 "net.fetch" 权限`,
        );
      }
    }
  }

  let shell: OintPluginManifest["shell"];
  if (oint.shell !== undefined) {
    if (!isRecord(oint.shell)) {
      issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.shell`, "必须是对象");
    } else {
      for (const key of Object.keys(oint.shell)) {
        if (key !== "exec") {
          issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.shell.${key}`, `未知字段 "${key}"`);
        }
      }
      if (oint.shell.exec !== undefined) {
        if (!Array.isArray(oint.shell.exec)) {
          issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.shell.exec`, "必须是字符串数组");
        } else {
          const exec: string[] = [];
          for (const entry of oint.shell.exec) {
            if (!isNonEmptyString(entry) || !BARE_COMMAND.test(entry)) {
              issues.error(
                `extensions.${OINT_EXTENSION_NAMESPACE}.shell.exec`,
                `每一项都必须是裸命令名（不含路径与空格）：${String(entry)}`,
              );
              continue;
            }
            exec.push(entry);
          }
          shell = { exec };
        }
      }
    }
  }

  /*
    **两条交叉检查放在 `if (oint.shell !== undefined)` 之外。**

    这一点踩过：第一版把它们写在了那个 if 里面，于是「申请了 shell.exec 权限但
    **整块 shell 都没写**」这条最典型的笔误恰好漏过 —— 而那正是这条规则存在的理由。
    **交叉检查的对象是"权限"与"声明"两个独立字段，不是 shell 块自己**，
    所以它不能挂在任何一个字段的解析分支里。fs 与 net 那两处同理
    （它们的检查在各自的 else 分支里，`fs: {}` 这种空对象仍会走到，但 `fs` 整块缺失
    时 `hasPermission` 那一侧本来就无从触发 —— 因为缺了范围声明不构成问题）。
  */
  if (hasPermission("shell.exec") && (shell === undefined || shell.exec.length === 0)) {
    issues.error(
      `extensions.${OINT_EXTENSION_NAMESPACE}.shell.exec`,
      `申请了 "shell.exec" 就必须列出允许执行的命令白名单 —— 一个用不了的权限是笔误，不是"静默无效"`,
    );
  }
  if (shell !== undefined && shell.exec.length > 0 && !hasPermission("shell.exec")) {
    issues.error(
      `extensions.${OINT_EXTENSION_NAMESPACE}.shell.exec`,
      `声明了命令白名单就必须申请 "shell.exec" 权限`,
    );
  }

  // ── main 与界面 ───────────────────────────────────────────────────────────

  const main =
    oint.main === undefined
      ? undefined
      : checkRelativeEntry(oint.main, `extensions.${OINT_EXTENSION_NAMESPACE}.main`, issues);

  const surfaces: PluginSurfaceDecl[] = [];
  if (oint.surfaces !== undefined) {
    if (!Array.isArray(oint.surfaces)) {
      issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.surfaces`, "必须是数组");
    } else {
      const seenIds = new Set<string>();
      oint.surfaces.forEach((entry, index) => {
        const surface = checkSurface(entry, index, permissions, issues);
        if (surface === undefined) return;
        if (seenIds.has(surface.id)) {
          issues.error(
            `extensions.${OINT_EXTENSION_NAMESPACE}.surfaces[${index}].id`,
            `界面 id "${surface.id}" 重复`,
          );
          return;
        }
        seenIds.add(surface.id);
        surfaces.push(surface);
      });
    }
  }

  // ── 钩子 ──────────────────────────────────────────────────────────────────

  const hooks: PluginHookDecl[] = [];
  if (oint.hooks !== undefined) {
    if (!Array.isArray(oint.hooks)) {
      issues.error(`extensions.${OINT_EXTENSION_NAMESPACE}.hooks`, "必须是数组");
    } else {
      const seenHookIds = new Set<string>();
      oint.hooks.forEach((entry, index) => {
        const hook = checkHook(entry, index, seenHookIds, issues);
        if (hook !== undefined) hooks.push(hook);
      });
      if (hooks.length > MAX_HOOKS_PER_PLUGIN) {
        issues.error(
          `extensions.${OINT_EXTENSION_NAMESPACE}.hooks`,
          `最多注册 ${MAX_HOOKS_PER_PLUGIN} 条钩子（收到 ${hooks.length} 条）—— 每次工具调用都要为它们付一轮跨进程往返`,
        );
      }
    }
  }

  /*
    钩子的两条交叉检查，都放在 `if (oint.hooks !== undefined)` 之外。

    理由与上面 shell 那两条同源：检查的对象是**两个独立字段之间**的关系
    （"声明了钩子" vs "有没有权限 / 有没有进程"），挂在字段自己的解析分支里会漏掉
    "钩子写了一条但整块权限忘了"这种最典型的笔误 —— 而那正是规则存在的理由。
  */
  if (hooks.length > 0 && !hasPermission("hostHooks.register")) {
    issues.error(
      `extensions.${OINT_EXTENSION_NAMESPACE}.hooks`,
      `注册钩子必须申请 "hostHooks.register" 权限 —— 钩子能拦住工具调用，用户必须在装之前就看到这一条`,
    );
  }
  if (hooks.length > 0 && main === undefined) {
    /*
      钩子是宿主回调**插件进程里的代码**（见 plugin-rpc.ts 的 PluginHookMessage）。
      没有 `main` 就没有人接这个调用，而"声明了却永远不会被调用"是这个系统里最糟的
      一类状态：作者会以为自己的策略生效了。
    */
    issues.error(
      `extensions.${OINT_EXTENSION_NAMESPACE}.hooks`,
      `注册钩子必须同时声明 "main" —— 钩子是宿主回调插件进程里的代码，没有进程就没人接`,
    );
  }

  if (issues.hasError) return { ok: false, issues: issues.list };

  return {
    ok: true,
    manifest: {
      name: name as string,
      version: raw.version as string,
      description: typeof raw.description === "string" ? raw.description : "",
      id: id as string,
      apiVersion: OINT_PLUGIN_API_VERSION,
      permissions,
      ...(fs === undefined ? {} : { fs }),
      ...(net === undefined ? {} : { net }),
      ...(shell === undefined ? {} : { shell }),
      ...(main === undefined ? {} : { main }),
      hooks,
      surfaces,
    },
    warnings: issues.list.filter((issue) => issue.severity === "warning"),
  };
}
