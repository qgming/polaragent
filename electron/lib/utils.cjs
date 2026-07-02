// 主进程通用工具函数库

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} a - 向量 A
 * @param {number[]} b - 向量 B
 * @returns {number} 余弦相似度，范围 [-1, 1]；维度不匹配时返回 0
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`向量维度不匹配: ${a?.length} vs ${b?.length}`);
    }
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
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 将数值限制在指定范围 [min, max] 内，并四舍五入为整数
 * @param {any} value - 输入值
 * @param {number} fallback - 无效时的回退值
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number} 限制后的整数值
 */
function clampNumber(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

module.exports = {
  cosineSimilarity,
  clampNumber,
};
