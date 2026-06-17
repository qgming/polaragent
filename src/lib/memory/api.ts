import type {
  ArchiveMemoryRequest,
  CreateMemoryRequest,
  DeleteMemoryRequest,
  ListMemoryRequest,
  MemoryItem,
  MemorySearchResult,
  MemoryStats,
  RebuildMemoryRequest,
  SearchMemoryRequest,
  UpdateMemoryRequest,
} from "./types";

function api() {
  if (typeof window === "undefined" || !window.polaragent) {
    throw new Error("Electron preload API 未初始化");
  }
  return window.polaragent;
}

export function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.polaragent);
}

export function listMemories(request: ListMemoryRequest = {}): Promise<MemoryItem[]> {
  return api().memory.list(request);
}

export function searchMemories(
  request: SearchMemoryRequest,
): Promise<{ success: boolean; results: MemorySearchResult[] }> {
  return api().memory.search(request);
}

export function createMemory(
  request: CreateMemoryRequest,
): Promise<{ success: boolean; memory: MemoryItem; deduped: boolean; score?: number }> {
  return api().memory.create(request);
}

export function updateMemory(
  request: UpdateMemoryRequest,
): Promise<{ success: boolean; memory: MemoryItem }> {
  return api().memory.update(request);
}

export function archiveMemory(
  request: ArchiveMemoryRequest,
): Promise<{ success: boolean; memory: MemoryItem }> {
  return api().memory.archive(request);
}

export function deleteMemory(
  request: DeleteMemoryRequest,
): Promise<{ success: boolean }> {
  return api().memory.delete(request);
}

export function getMemoryStats(): Promise<MemoryStats> {
  return api().memory.stats();
}

export function rebuildMemory(
  request: RebuildMemoryRequest,
): Promise<{ success: boolean; rebuilt: number }> {
  return api().memory.rebuild(request);
}
