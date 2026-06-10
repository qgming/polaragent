// 知识库 Electron API 封装

import type { KnowledgeSearchResult, KnowledgeBase, KnowledgeFile } from "./types";

function api() {
  if (typeof window === "undefined" || !window.polaragent) {
    throw new Error("Electron preload API 未初始化");
  }
  return window.polaragent;
}

export function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.polaragent);
}

export interface CreateKnowledgeBaseRequest {
  kbId: string;
  name: string;
  description?: string;
  chunkSize?: number;
  overlap?: number;
}

export interface AddFilesRequest {
  kbId: string;
  filePaths: string[];
  config: {
    chunkSize?: number;
    overlap?: number;
    embedding: {
      apiKey: string;
      baseURL: string;
      model: string;
      dimension: number;
    };
  };
}

export interface RebuildKnowledgeRequest {
  kbId: string;
  config: {
    embedding: {
      apiKey: string;
      baseURL: string;
      model: string;
      dimension: number;
    };
  };
}

export interface UpdateKnowledgeBaseRequest {
  kbId: string;
  updates: Partial<{
    name: string;
    description: string;
    enabled: boolean;
    chunkSize: number;
    overlap: number;
  }>;
}

export interface QueryKnowledgeRequest {
  kbId: string;
  query: string;
  config: {
    embedding: {
      apiKey: string;
      baseURL: string;
      model: string;
      dimension: number;
    };
  };
  topK?: number;
  threshold?: number;
}

// 创建知识库
export async function createKnowledgeBase(
  request: CreateKnowledgeBaseRequest,
): Promise<{ success: boolean; knowledgeBase: KnowledgeBase }> {
  return api().knowledge.create(request);
}

// 更新知识库配置
export async function updateKnowledgeBase(
  request: UpdateKnowledgeBaseRequest,
): Promise<{ success: boolean; knowledgeBase: KnowledgeBase }> {
  return api().knowledge.update(request);
}

// 添加文件到知识库
export async function addFilesToKnowledge(
  request: AddFilesRequest,
): Promise<{
  success: boolean;
  addedFiles: KnowledgeFile[];
  totalFiles: number;
  totalChunks: number;
}> {
  return api().knowledge.addFiles(request);
}

// 从知识库删除文件
export async function removeFileFromKnowledge(
  kbId: string,
  fileId: string,
): Promise<{ success: boolean }> {
  return api().knowledge.removeFile({ kbId, fileId });
}

// 获取知识库文件列表
export async function getKnowledgeFiles(kbId: string): Promise<KnowledgeFile[]> {
  console.log("api.getKnowledgeFiles called, kbId:", kbId, "type:", typeof kbId);
  if (!kbId) {
    throw new Error("getKnowledgeFiles: kbId is required");
  }
  console.log("calling api().knowledge.getFiles with kbId:", kbId);
  const result = api().knowledge.getFiles(kbId);
  console.log("api().knowledge.getFiles result:", result);
  return result;
}

// 重建知识库索引
export async function rebuildKnowledge(
  request: RebuildKnowledgeRequest,
): Promise<{ success: boolean; fileCount: number; chunkCount: number }> {
  return api().knowledge.rebuild(request);
}

// 查询知识库
export async function queryKnowledge(
  request: QueryKnowledgeRequest,
): Promise<{ success: boolean; results: KnowledgeSearchResult[] }> {
  return api().knowledge.query(request);
}

// 删除知识库
export async function deleteKnowledge(kbId: string): Promise<{ success: boolean }> {
  return api().knowledge.delete(kbId);
}

// 列出所有知识库
export async function listKnowledge(): Promise<KnowledgeBase[]> {
  return api().knowledge.list();
}

// 检查文件兼容性
export async function checkFilesCompatibility(
  kbId: string,
  config: {
    embedding: {
      apiKey: string;
      baseURL: string;
      model: string;
      dimension: number;
    };
  },
): Promise<KnowledgeFile[]> {
  return api().knowledge.checkCompatibility(kbId, config);
}

// 重新嵌入不兼容的文件
export async function reembedIncompatibleFiles(
  request: RebuildKnowledgeRequest,
): Promise<{ success: boolean; reembedded: number }> {
  return api().knowledge.reembedIncompatible(request);
}
