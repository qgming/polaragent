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
