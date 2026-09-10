// 模型服务辅助通道：从 OpenAI 兼容端点拉取可用模型列表。
// 网络请求在主进程发起，避免渲染进程直连外部服务（保持零特权边界）。

import { ipcMain, net } from "electron";
import type { WireFormat } from "@/shared/contracts/common";
import { IPC } from "@/shared/contracts/ipc";

type FetchModelsResult = { ok: true; modelIds: string[] } | { ok: false; reason: string };

/** 拼接 /models 端点：baseUrl 需自带 /v1，这里只去尾斜杠 */
function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/** 从响应体里提取模型 id 列表，兼容 { data: [...] } 与纯数组两种形态 */
function extractModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (typeof item === "object" && item !== null) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string" && id !== "") ids.push(id);
    }
  }
  return ids;
}

export function registerServicesIpc(): void {
  ipcMain.handle(
    IPC.services.fetchModels,
    async (
      _event,
      request: { baseUrl: string; apiKey: string; wireFormat: WireFormat },
    ): Promise<FetchModelsResult> => {
      if (request.baseUrl.trim() === "") return { ok: false, reason: "BASE_URL_EMPTY" };
      try {
        // 用 Electron net 走系统网络栈，超时由 AbortSignal 控制
        const response = await net.fetch(modelsUrl(request.baseUrl), {
          method: "GET",
          headers: { Authorization: `Bearer ${request.apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          return { ok: false, reason: `HTTP_${response.status}` };
        }
        const payload: unknown = await response.json();
        return { ok: true, modelIds: extractModelIds(payload) };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  );
}
