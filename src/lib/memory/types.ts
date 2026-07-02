export type MemoryScope = "global" | "project";

export type MemoryType =
  | "preference"
  | "profile"
  | "project"
  | "instruction"
  | "correction"
  | "communication"
  | "workflow"
  | "tool"
  | "goal"
  | "constraint";

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  sourceThreadId?: string;
  projectKey?: string;
  confidence: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
  archived: boolean;
  indexed?: boolean;
}

export interface MemorySearchResult extends MemoryItem {
  score: number;
  // 降级结果标记：非直接匹配，仅为"最近更新"兜底（score 恒为 0）
  fallback?: boolean;
}

export interface MemoryEmbeddingConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  dimension: number;
}

export interface MemoryApiConfig {
  embedding: MemoryEmbeddingConfig;
}

export interface ListMemoryRequest {
  scopes?: MemoryScope[];
  type?: MemoryType;
  projectKey?: string;
  query?: string;
  includeArchived?: boolean;
}

export interface CreateMemoryRequest {
  memory: Partial<MemoryItem> & {
    scope: MemoryScope;
    type: MemoryType;
    content: string;
  };
  config: MemoryApiConfig;
  dedupeThreshold?: number;
}

export interface UpdateMemoryRequest {
  id: string;
  updates: Partial<Pick<MemoryItem, "content" | "type" | "confidence" | "tags" | "archived">>;
  config?: MemoryApiConfig;
}

export interface SearchMemoryRequest {
  query: string;
  config: MemoryApiConfig;
  scopes?: MemoryScope[];
  projectKey?: string;
  topK?: number;
  threshold?: number;
  includeArchived?: boolean;
  // 无任何命中时是否允许降级返回最近更新的记忆（带 fallback 标记）。
  // 默认关闭；破坏性调用方（如 forget_memory）绝不能开启。
  allowFallback?: boolean;
}

export interface ArchiveMemoryRequest {
  id: string;
  archived?: boolean;
}

export interface DeleteMemoryRequest {
  id: string;
}

export interface RebuildMemoryRequest {
  config: MemoryApiConfig;
  scope?: MemoryScope;
}

export interface MemoryStats {
  success: boolean;
  total: number;
  active: number;
  archived: number;
  byScope: Record<MemoryScope, number>;
  byType: Partial<Record<MemoryType, number>>;
  metadata: {
    global?: {
      embeddingConfig?: { model: string; dimension: number } | null;
      lastError?: string | null;
      updatedAt?: number;
    };
    project?: {
      embeddingConfig?: { model: string; dimension: number } | null;
      lastError?: string | null;
      updatedAt?: number;
    };
  };
}
