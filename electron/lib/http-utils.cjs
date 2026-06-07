// 主进程网络/HTTP 共享工具：URL 归一化、错误处理等。

// 归一化 LLM Base URL：去尾斜杠，确保以 /v1 结尾
function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL 不能为空");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// 从错误响应体提取人类可读错误信息
function errorMessage(payload) {
  return payload?.error?.message || payload?.message || "服务返回错误";
}

// 归一化用户输入的 Web URL（补 https，仅允许 http/https）
function normalizeWebUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("url 不能为空");
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!/^https?:\/\//i.test(url)) throw new Error("仅支持 http/https URL");
  return url;
}

module.exports = {
  normalizeBaseUrl,
  errorMessage,
  normalizeWebUrl,
};
