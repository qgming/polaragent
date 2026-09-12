import type { ThinkingLevel } from "./common";

/** 目录里发现的输入模态（models.dev 有五种，pi-ai 只消费 text / image） */
export type CatalogModality = "text" | "image" | "pdf" | "audio" | "video";

/** 思考档位是从哪来的：pi-ai 目录 / 由 reasoning 标志推断 / 无信息 */
export type ThinkingSource = "pi-ai" | "reasoning" | null;

/**
 * 模型能力匹配结果，字段已对齐 ModelEntry。
 *
 * 两份目录各出各的：models.dev 给名称、上下文窗口与输出上限；pi-ai 给图片支持与
 * **支持的思考档位**（它的标准模型目录里每个模型带 thinkingLevelMap，`null` = 不支持）。
 * 合并规则见 models-catalog.ts 的 mergeCatalogEntry。
 */
export interface ModelCatalogEntry {
  /** 目录里的完整 id，如 deepseek/deepseek-v4-flash；pi-ai 只有时为其模型 id */
  catalogId: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** 目录声明的输入模态（原样保留五种，便于将来接入） */
  input: CatalogModality[];
  /** 是否支持图片输入：pi-ai 的 input 优先，其次看 models.dev 的模态列表 */
  supportsImages: boolean;
  /** 支持的思考档位（含 "off"）；始终非空 */
  supportedThinking: ThinkingLevel[];
  /** supportedThinking 的来源，界面据此说明「这是目录值还是推断值」 */
  thinkingSource: ThinkingSource;
}

/** 查询结果：ok=false 表示目录不可用（网络/缓存问题），match=null 表示已查到但未收录 */
export type ModelLookupResult =
  | { ok: true; match: ModelCatalogEntry | null }
  | { ok: false; reason: string };
