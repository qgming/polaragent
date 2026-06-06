// 会话元数据辅助：在同 id 多条 jsonl 中挑选「最优」一条，及自定义条目读取。
// 历史并发竞态可能遗留同 id 的多个文件（一条带标题、一条带消息），这里统一处理。
import { JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { getExecutionEnv } from "./session-repo";

// session 列表项的最小元数据形状（repo.list 的返回元素）
export type SessionMeta = Awaited<ReturnType<JsonlSessionRepo["list"]>>[number];

// 统计某 session 文件里 type==="message" 的行数（近似消息量），读失败按 0。
// 仅在同 id 出现多条时用于挑选「有内容」的那条。
async function metaMessageCount(meta: SessionMeta): Promise<number> {
  try {
    const env = await getExecutionEnv();
    const result = await env.readTextFile(meta.path);
    if (!result.ok) return 0;
    let count = 0;
    for (const line of result.value.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string };
        if (parsed.type === "message") count += 1;
      } catch {
        // 跳过无法解析的行
      }
    }
    return count;
  } catch {
    return 0;
  }
}

// 在同 id 的多条 meta 中选「最优」：消息最多者优先；并列时取 createdAt 较新者。
// 单条时直接返回，避免无谓读盘。
export async function pickBestMeta(metas: SessionMeta[]): Promise<SessionMeta> {
  if (metas.length === 1) return metas[0];
  const scored = await Promise.all(
    metas.map(async (meta) => ({
      meta,
      count: await metaMessageCount(meta),
      createdAt: Date.parse(meta.createdAt) || 0,
    })),
  );
  scored.sort((a, b) =>
    b.count !== a.count ? b.count - a.count : b.createdAt - a.createdAt,
  );
  return scored[0].meta;
}

// 从会话条目里取最后一条指定 customType 的某个字符串字段值（后写覆盖先写）。
export function readLastCustomEntryString(
  entries: Awaited<ReturnType<Session["getEntries"]>>,
  customType: string,
  field: string,
): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === customType) {
      const data = entry.data as Record<string, unknown> | undefined;
      const value = data?.[field];
      if (typeof value === "string" && value.trim()) return value;
      return undefined;
    }
  }
  return undefined;
}
