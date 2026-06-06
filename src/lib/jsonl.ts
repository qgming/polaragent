// JSONL 工具函数
// src/lib/jsonl.ts

import type { JSONLMessage } from "@/types/config";

/**
 * 解析 JSONL 字符串
 */
export function parseJSONL(content: string): JSONLMessage[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as JSONLMessage;
      } catch (error) {
        console.error("解析 JSONL 行失败:", line, error);
        return null;
      }
    })
    .filter((item): item is JSONLMessage => item !== null);
}

/**
 * 序列化为 JSONL 字符串
 */
export function stringifyJSONL(items: JSONLMessage[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

/**
 * 生成单行 JSONL
 */
export function appendJSONL(item: JSONLMessage): string {
  return JSON.stringify(item) + "\n";
}

/**
 * 从 JSONL 提取元数据
 */
export function extractMetaFromJSONL(content: string): JSONLMessage | null {
  const lines = parseJSONL(content);
  return lines.find((line) => line.type === "meta") || null;
}

/**
 * 从 JSONL 提取消息
 */
export function extractMessagesFromJSONL(content: string): JSONLMessage[] {
  const lines = parseJSONL(content);
  return lines.filter((line) => line.type === "message");
}
