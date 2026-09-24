import { realpath } from "node:fs/promises";
import path from "node:path";

/** 路径访问校验结果：成功时返回归一化后的绝对路径 */
export type PathAccessResult = { ok: true; resolved: string } | { ok: false; reason: string };

/**
 * 路径归一：绝对化、统一平台分隔符、Windows 盘符小写、去除尾分隔符（根路径除外）。
 * 纯函数，不做任何文件系统访问，便于单测。
 */
export function normalizePath(input: string): string {
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  const isRoot = resolved === root;
  // 根路径（C:\ 或 /）保留尾分隔符，其余去掉，保证 "C:\a\" 与 "C:\a" 判定一致
  const trimmed = resolved.endsWith(path.sep) && !isRoot ? resolved.slice(0, -1) : resolved;
  // Windows 盘符统一小写，避免 C: 与 c: 被当成不同根
  if (process.platform === "win32") {
    return trimmed.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
  }
  return trimmed;
}

/**
 * child 是否等于 parent 或位于 parent 内部。
 * 基于 path.relative 实现：相对路径出现 ".." 或返回绝对路径（跨盘符）即视为外部。
 */
export function isInsidePath(child: string, parent: string): boolean {
  const childPath = normalizePath(child);
  const parentPath = normalizePath(parent);
  const relative = path.relative(parentPath, childPath);
  if (relative === "") return true;
  const goesUp = relative === ".." || relative.startsWith(`..${path.sep}`);
  return !goesUp && !path.isAbsolute(relative);
}

/** 校验请求路径是否落在任一工作目录内；roots 为空视为未配置工作目录，直接拒绝 */
export function validatePathAccess(requested: string, roots: string[]): PathAccessResult {
  if (roots.length === 0) {
    return { ok: false, reason: "未指定工作目录，拒绝访问路径" };
  }
  const resolved = normalizePath(requested);
  const allowed = roots.some((root) => isInsidePath(resolved, root));
  if (!allowed) {
    return { ok: false, reason: `路径不在允许的工作目录内: ${resolved}` };
  }
  return { ok: true, resolved };
}

/**
 * 解析到 **realpath** 后再判包含 —— `validatePathAccess` 的异步加强版。
 *
 * ## 为什么必须有它
 *
 * `validatePathAccess` 是**纯字符串**判断（不做任何文件系统访问，因此可单测、可在
 * 任何地方同步调用）。它的盲区是**符号链接**：一个指向禁区（`~/.oint/settings.json`）
 * 的链接，其**字面路径**落在允许根内，于是字符串判断放行，而实际读到的却是禁区文件。
 *
 * 对本仓库来说这条不是理论风险：README 的「仍有未修的越界读写路径」一节自己列了
 * 「路径守卫不做 realpath」。而在引入插件之后它升级为提权链 —— 插件的 `fs` scope
 * 如果不做 realpath，就是一条**纸面规则**（插件在自己目录里放一个指向 `~/.oint` 的
 * 链接即可绕过）。Agent Plugins 规范 §4.1 也明确要求按 `filesystem-resolved` 判定。
 *
 * ## 目标不存在时怎么办
 *
 * **不能直接 realpath 失败就拒绝** —— 新建文件的路径永远不存在，那样等于禁掉写入。
 * 做法是**逐级向上找到最近的已存在祖先**，对它做 realpath，再把剩余段拼回去：
 * 于是「经过一个指向禁区的目录」会被抓住，而「在允许根内新建一个文件」照常放行。
 *
 * ## 边界
 *
 * - 目标完全不存在且祖先一路到根都不存在：退化为纯字符串判断（等价于旧行为）。
 * - 大小写：Windows 上 `realpath` 返回规范大小写，而 `normalizePath` 只把**盘符**
 *   规范化。两侧都过 realpath 之后再比，所以仍然一致。
 */
export async function resolveRealPath(input: string): Promise<string> {
  const absolute = normalizePath(input);
  const trailing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = normalizePath(await realpath(current));
      // trailing 是从下往上收集的，拼回去时要反过来
      return trailing.length === 0 ? real : normalizePath(path.join(real, ...trailing.reverse()));
    } catch {
      const parent = path.dirname(current);
      // 到根还解析不出来：这个路径整条都不存在，退回纯字符串结果
      if (parent === current) return absolute;
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * 解析 realpath 后再判包含。**这是文件访问该走的那道门**。
 *
 * 与 `validatePathAccess` 的关系：语义相同、判据更严（多了 realpath 这一步）。
 * 两者都留着是因为调用方的约束不同 —— 渲染层的文件面板走同步的纯函数就够了
 *（它的 root 来自会话索引、不接受用户输入），而模型侧的文件工具与插件表面
 * 必须走这一道。
 */
export async function validateRealPathAccess(
  requested: string,
  roots: string[],
): Promise<PathAccessResult> {
  if (roots.length === 0) {
    return { ok: false, reason: "未指定工作目录，拒绝访问路径" };
  }
  const target = await resolveRealPath(requested);
  for (const root of roots) {
    const realRoot = await resolveRealPath(root);
    if (isInsidePath(target, realRoot)) return { ok: true, resolved: target };
  }
  return { ok: false, reason: `路径不在允许的工作目录内: ${target}` };
}
