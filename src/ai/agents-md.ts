// 全局 AGENTS.md 读取与缓存
// src/ai/agents-md.ts
//
// 路径固定为 {dataDir}/AGENTS.md，始终启用。首启时由 ensureDataDir 创建默认内容。

import { readAgentsMd, writeAgentsMd } from "@/lib/electron/electron-api";

let cache: { content: string; loadedAt: number } | null = null;
const CACHE_TTL_MS = 5_000;

/** 读取 AGENTS.md 内容；读取失败时返回空串 */
export async function loadAgentsMdContent(): Promise<string> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.content;
  }

  try {
    const content = await readAgentsMd();
    cache = { content, loadedAt: now };
    return content;
  } catch {
    cache = { content: "", loadedAt: now };
    return "";
  }
}

/** 保存 AGENTS.md 内容并使缓存失效 */
export async function saveAgentsMdContent(content: string): Promise<void> {
  await writeAgentsMd(content);
  cache = null;
}

/** 使 AGENTS.md 缓存失效（保存后或外部编辑后调用） */
export function invalidateAgentsMdCache(): void {
  cache = null;
}
