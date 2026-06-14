import {
  createDirectory,
  fileExists,
  readBase64File,
  writeBase64File,
  writeFile,
} from "@/lib/electron/electron-api";
import type { ChatAttachment } from "@/lib/chat";
import { readDocument } from "@/lib/document-reader";

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function normalizeDir(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

function sanitizeFileName(name: string): string {
  const clean = basename(name).replace(/[<>:"|?*\x00-\x1f]/g, "-").trim();
  return clean || "attachment";
}

function splitName(name: string): { stem: string; ext: string } {
  const match = name.match(/^(.*?)(\.[^.\\/]*)?$/);
  return {
    stem: match?.[1] || "attachment",
    ext: match?.[2] || "",
  };
}

async function uniqueTargetPath(targetDir: string, name: string, sourcePath: string): Promise<string> {
  const safeName = sanitizeFileName(name);
  const sourceNorm = sourcePath.replace(/\\/g, "/").toLowerCase();
  const first = joinPath(targetDir, safeName);
  if (first.replace(/\\/g, "/").toLowerCase() === sourceNorm) return first;
  if (!(await fileExists(first))) return first;

  const { stem, ext } = splitName(safeName);
  for (let index = 1; index <= 99; index += 1) {
    const candidate = joinPath(targetDir, `${stem}-${String(index).padStart(2, "0")}${ext}`);
    if (candidate.replace(/\\/g, "/").toLowerCase() === sourceNorm) return candidate;
    if (!(await fileExists(candidate))) return candidate;
  }
  return joinPath(targetDir, `${stem}-${Date.now()}${ext}`);
}

export async function materializeAttachments(
  attachments: ChatAttachment[],
  targetDir: string,
): Promise<ChatAttachment[]> {
  const dir = targetDir.trim();
  if (!dir || attachments.length === 0) return attachments;
  await createDirectory(dir);
  const targetNorm = normalizeDir(dir);
  const result: ChatAttachment[] = [];

  for (const attachment of attachments) {
    const sourcePath = attachment.path;
    // 路径为空的附件直接跳过，避免后续 dirname/basename 抛错中断整次发送
    if (!sourcePath || typeof sourcePath !== "string") {
      console.error("附件路径为空，已跳过", attachment);
      continue;
    }

    if (normalizeDir(dirname(sourcePath)) === targetNorm) {
      result.push({ ...attachment, name: basename(sourcePath) });
      continue;
    }

    // 单个附件复制失败不应中断整次发送：记录并跳过该附件，其余继续物化。
    try {
      const targetPath = await uniqueTargetPath(dir, attachment.name || basename(sourcePath), sourcePath);
      const content = await readBase64File(sourcePath);
      await writeBase64File(targetPath, content);

      // 如果是文档类型，提取文本内容并生成 .txt 副本
      if (attachment.kind === "document") {
        try {
          console.log(`正在提取文档内容: ${sourcePath}`);
          const textContent = await readDocument(sourcePath);

          // 生成文本副本文件名（原文件名 + .txt）
          const { stem } = splitName(basename(targetPath));
          const textPath = await uniqueTargetPath(dir, `${stem}.txt`, `${targetPath}.txt`);

          await writeFile(textPath, textContent);
          console.log(`文档内容已提取到: ${textPath}`);

          // 返回文本文件路径，kind 改为 text，以便 Agent 处理
          result.push({
            path: textPath,
            name: basename(textPath),
            kind: "text",
          });
        } catch (docError) {
          console.error(`文档内容提取失败，将保留原文件: ${sourcePath}`, docError);
          // 提取失败时保留原文档文件
          result.push({
            ...attachment,
            path: targetPath,
            name: basename(targetPath),
          });
        }
      } else {
        result.push({
          ...attachment,
          path: targetPath,
          name: basename(targetPath),
        });
      }
    } catch (error) {
      console.error(`附件物化失败，已跳过: ${sourcePath}`, error);
    }
  }

  return result;
}
