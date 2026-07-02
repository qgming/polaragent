import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind CSS 类名
 * @param inputs - 类名列表
 * @returns 合并后的类名字符串
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(...inputs));
}

/**
 * 计算两个向量的余弦相似度
 * @param a - 向量 A
 * @param b - 向量 B
 * @returns 余弦相似度，范围 [-1, 1]；维度不匹配时返回 0
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) {
    console.warn(`向量维度不匹配: ${a?.length} vs ${b?.length}`);
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  // 零向量保护：避免 0/0 返回 NaN 污染下游排序逻辑
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 将数值限制在指定范围 [min, max] 内，并四舍五入为整数
 * @param value - 输入值
 * @param fallback - 无效时的回退值
 * @param min - 最小值
 * @param max - 最大值
 * @returns 限制后的整数值
 */
export function clampNumber(
  value: number,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
