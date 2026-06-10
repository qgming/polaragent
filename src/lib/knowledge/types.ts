// 知识库类型定义

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  chunkSize: number;
  overlap: number;
  fileCount: number;
  chunkCount: number;
}

export interface KnowledgeFile {
  id: string;
  kbId: string;
  name: string;
  path: string;
  size: number;
  type: string;
  status: "pending" | "processing" | "ready" | "error" | "incompatible";
  error?: string;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeSearchResult {
  id: string;
  file: string;
  chunk: number;
  text: string;
  score: number;
}
