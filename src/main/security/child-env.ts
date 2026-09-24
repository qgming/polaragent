// 子进程环境变量白名单：**所有由主进程拉起的外部进程**（bash、后台作业、MCP server、
// 将来的插件进程）都从这里取环境，而不是继承 `process.env`。
//
// ## 为什么必须白名单，而不是黑名单
//
// 主进程的环境里有 `OINT_HOME` 与用户机器上存在的各类凭据（`*_API_KEY`、`*_TOKEN`、
// 云厂商的 `AWS_*`…）。继承它们意味着：**模型跑一条 `env` 就能把凭据读进上下文**，
// 一条被批准过的命令即可外带。
//
// 黑名单不可行 —— 凭据变量的命名空间是开放的（用户自己起的名字、各家 SDK 的前缀、
// CI 注入的），任何 `*_TOKEN` 之类的正则都会漏。**允许清单是唯一封闭的判据。**
//
// ## 为什么连 `SHELL`/`LANG` 这类也要显式列
//
// 因为一旦改成白名单，**没列到的就等于删掉了**。开发命令对环境的依赖比想象中多：
// Windows 上 `npx`/`git` 依赖 `PATHEXT` 与 `SystemRoot`；`npm` 依赖 `APPDATA`/`LOCALAPPDATA`
// 找缓存；很多工具在 `LANG` 缺失时会把输出切成 ASCII 或 C locale。所以这份清单的目标是
// **「工具链能正常工作」与「凭据不外泄」的交集**，宁可多列几个无害的。
//
// ## 用户确实需要的额外变量怎么办
//
// MCP server 的 `env` 字段、以及将来插件的 settings 都是显式通道 —— 用户想给某个子进程
// 传东西，就在那个配置里写。**「默认什么都不给」+「需要时显式给」**，比「默认全给」
// 然后指望用户去删要可靠得多。
//
// 与 PI-Desktop 的 `child-process-env.ts` 同一形状（它的清单是 PATH / SystemRoot / windir /
// TEMP / TMP / TMPDIR / LANG / HOME / USER / USERPROFILE，外加 `PI_PLUGIN_ID`）。

/**
 * 允许继承的环境变量名（**大小写不敏感**比较）。
 *
 * 分四组，每一组的存在理由都写在分组标题上；删任何一条之前先想清楚它被谁用。
 */
export const INHERITED_ENV_KEYS: readonly string[] = [
  // 1. 可执行文件解析与 shell 自身 —— 少了它们命令根本跑不起来
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SHELL",

  // 2. 系统根目录与临时目录 —— Windows 上的工具链几乎都读这几个
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",

  // 3. 用户与家目录 —— git 配置、npm 缓存、SSH known_hosts 都从这里找
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "USERNAME",
  "LOGNAME",

  // 4. 区域与编码 —— 少了 LANG 时很多工具会把输出切成 C locale（中文变成问号）
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",

  // 5. Windows 的目录约定 —— 不是凭据，但缺了会让部分安装/查找失败
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "ALLUSERSPROFILE",
  "PUBLIC",

  // 6. 架构信息 —— 构建脚本与原生模块编译会读
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "TERM",
];

/** 允许清单的小写集合，供大小写不敏感比较（Windows 的环境变量名不区分大小写） */
const ALLOWED = new Set(INHERITED_ENV_KEYS.map((key) => key.toLowerCase()));

/**
 * 从一份环境变量里挑出允许继承的那些，再叠加调用方显式给的。
 *
 * 三条细节：
 *  - **大小写不敏感匹配**：Windows 上 `Path` / `PATH` 是同一个变量，用原样比较会漏掉；
 *    命中的键按**源里的原始拼写**放进结果，因为子进程要靠那个拼写找到它。
 *  - **空值省略，不写成空串**：`FOO=` 与「没有 FOO」在不少工具里语义不同
 *    （例如 `HOME=""` 会让某些工具把家目录解析成当前目录）。
 *  - **`extra` 覆盖白名单**：调用方显式给的值优先级最高（MCP 的 `config.env` 走这条）。
 *
 * @param source 源环境，默认 `process.env`；测试传固定对象
 * @param extra 调用方显式补充/覆盖的变量
 */
export function buildChildEnv(
  source: Record<string, string | undefined> = process.env,
  extra?: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === "") continue;
    if (!ALLOWED.has(key.toLowerCase())) continue;
    out[key] = value;
  }

  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      // 空串同样按「删除」处理：显式给空值 = 明确不要这个变量
      if (value === "") delete out[key];
      else out[key] = value;
    }
  }

  return out;
}

/**
 * 判断一个变量名是否在白名单里（供审计与诊断显示用）。
 *
 * 单独导出而不是让调用方自己 `INHERITED_ENV_KEYS.includes`：那个比较是大小写敏感的，
 * 而这份判断必须与 `buildChildEnv` 的口径完全一致。
 */
export function isInheritedEnvKey(key: string): boolean {
  return ALLOWED.has(key.toLowerCase());
}
