// 原子写：先写临时文件再 rename，避免中断时留下半截文件。
//
// 为什么单独抽一个模块：这段逻辑在本仓出现了**六次**（settings / sessions-index /
// permissions / projects / agents / 以及将来的新配置）。之前每处都是三行裸代码：
//
//   const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
//   await writeFile(tempPath, payload, "utf8");
//   await rename(tempPath, filePath);
//
// 问题出在**失败路径**：writeFile 或 rename 抛错时没人删临时文件。
// 实测本机数据根积了 7 个 `sessions-index.json.<pid>.<ts>.tmp`（48~78 KB，最早两周前）——
// 这就是它们的来源。清理只能靠启动时扫描（见 app/paths.ts 的 purgeStaleTempFiles），
// 但**更该做的是别留下它们**：失败时立刻删，就不需要事后扫。
//
// rename 在 Windows 上还可能因目标被占用而失败（EPERM/EACCES）；那种情况下残留的
// 临时文件同样在这里清掉，调用方照常拿到原始错误。
import { rename, rm, writeFile } from "node:fs/promises";

/**
 * 原子写入一个文本文件。
 *
 * 临时文件与目标同目录（rename 必须同卷），名字带 pid 与时间戳，
 * 避免两个进程/两次写入撞名。
 */
export async function writeFileAtomic(filePath: string, payload: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    // 失败时立刻收掉临时文件：这是「不留垃圾」的第一道，
    // 启动时的陈旧扫描只是兜底（进程被强杀时才会走到那一步）。
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
