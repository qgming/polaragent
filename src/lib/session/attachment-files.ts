import {
  createDirectory,
  fileExists,
  readBase64File,
  writeBase64File,
} from "@/lib/electron/electron-api";
import type { ChatAttachment } from "@/lib/chat";

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
      result.push({
        ...attachment,
        path: targetPath,
        name: basename(targetPath),
      });
    } catch (error) {
      console.error(`附件物化失败，已跳过: ${sourcePath}`, error);
    }
  }

  return result;
}
