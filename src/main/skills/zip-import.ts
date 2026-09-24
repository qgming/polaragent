// 技能包（zip）导入：把外部 .zip 解压到数据目录的 skills/ 下。
//
// 只做「解压落盘」，不解释技能格式：技能是否有效由内核的 loadSkills 在上层重新扫描时判定
//（见 ipc/skills.ts），这里返回文件数与诊断，让界面能说清「导入了多少、跳过了什么」。
//
// **实现在 main/storage/zip.ts** —— 防 zip-slip、防 zip bomb、过滤元数据条目这三道
// 与"技能"没有任何关系，插件安装（main/plugins/install.ts）要用同一套。
// 这个文件只负责"技能包"这一档的语义（目标目录、返回形状）。

import { extractZipFile, type ZipExtractResult } from "@/main/storage/zip";

export interface SkillZipExtractResult {
  /** 实际写入磁盘的文件数 */
  files: number;
  /** 跳过/失败说明（路径越界、超限等），直接显示给用户 */
  diagnostics: string[];
}

/**
 * 解压一个技能包到 targetDir（通常是 `${dataDir()}/skills`）。
 *
 * 条目按 zip 顺序写入并**覆盖**同名文件：导入是用户主动动作，覆盖是可预期的语义；
 * 中途遇到超限就停止并留下说明，已经写入的部分保留（不清空目录 —— 那是删除技能的职责）。
 */
export async function extractSkillZip(
  zipPath: string,
  targetDir: string,
): Promise<SkillZipExtractResult> {
  const result: ZipExtractResult = await extractZipFile(zipPath, targetDir);
  return { files: result.files, diagnostics: result.diagnostics };
}
