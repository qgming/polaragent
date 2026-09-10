/** models.dev 匹配结果，字段已对齐 ModelEntry */
export interface ModelCatalogEntry {
  /** models.dev 完整 id，如 deepseek/deepseek-v4-flash */
  catalogId: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
}

/** 查询结果：ok=false 表示目录不可用（网络/缓存问题），match=null 表示已查到但未收录 */
export type ModelLookupResult =
  | { ok: true; match: ModelCatalogEntry | null }
  | { ok: false; reason: string };
