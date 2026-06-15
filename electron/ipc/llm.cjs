// IPC：LLM 调用（chat completion 同步/流式、模型列表）
// 走 OpenAI 兼容接口。
const { net } = require("electron");
const { normalizeBaseUrl, errorMessage } = require("../lib/http-utils.cjs");
const { REMOTE_CONCURRENCY, withConcurrency } = require("../lib/concurrency.cjs");

// LLM 请求全局并发控制：同时最多 2 个请求在打向上游，降低 429 风险
const llmRunner = withConcurrency(REMOTE_CONCURRENCY);

// 429 限流重试间隔（毫秒），默认重试 5 次
const RETRY_DELAYS = [1000, 3000, 5000, 10000, 30000];

// 判断是否因 429 限流导致的错误
function isRateLimitError(error) {
  if (!error || !error.message) return false;
  return /429|Too Many Requests|rate_limit/i.test(error.message);
}

// 带 429 自动静默重试包装：捕获 429 错误后按递增间隔重试
async function with429Retry(fn) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) throw error;
      if (attempt >= RETRY_DELAYS.length) throw error;
      const delay = RETRY_DELAYS[attempt];
      console.log(`[LLM] 429 限流，${attempt + 1}/${RETRY_DELAYS.length} 次重试，等待 ${delay}ms ...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function electronFetch(url, options) {
  return net.fetch(url, options);
}

// 组装 messages（system + 非空内容的对话消息）
function buildMessages(systemPrompt, messages) {
  const result = [];
  if (String(systemPrompt || "").trim()) {
    result.push({ role: "system", content: systemPrompt });
  }
  for (const message of messages || []) {
    if (String(message.content || "").trim()) {
      result.push({ role: message.role, content: message.content });
    }
  }
  return result;
}

// 组装请求体
function llmBody(request, stream) {
  const body = {
    model: String(request.model || "").trim(),
    messages: buildMessages(request.systemPrompt, request.messages),
    stream,
    temperature: request.temperature ?? 0.7,
    max_tokens: request.maxTokens ?? 4096,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (request.responseFormat === "json_object") body.response_format = { type: "json_object" };
  return body;
}

// 归一化 usage 字段
function usageFrom(raw) {
  const input = Number(raw?.prompt_tokens || 0);
  const output = Number(raw?.completion_tokens || 0);
  const totalTokens = Number(raw?.total_tokens || input + output);
  return { input, output, totalTokens };
}

// 同步 chat completion
async function chatCompletion(request) {
  return with429Retry(() => llmRunner(async () => {
    if (!String(request.apiKey || "").trim()) throw new Error("API Key 不能为空");
    if (!String(request.model || "").trim()) throw new Error("模型名称不能为空");
    const response = await electronFetch(`${normalizeBaseUrl(request.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(llmBody(request, false)),
      signal: AbortSignal.timeout(120000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`模型请求失败（${response.status}）：${errorMessage(payload)}`);
    return {
      content: payload.choices?.[0]?.message?.content || "",
      model: payload.model || request.model,
      usage: usageFrom(payload.usage),
    };
  }));
}

// 流式 chat completion：解析 SSE，逐段通过 llm:chat-stream 推送
async function chatCompletionStream(event, request) {
  return with429Retry(() => llmRunner(async () => {
    if (!String(request.apiKey || "").trim()) throw new Error("API Key 不能为空");
    if (!String(request.model || "").trim()) throw new Error("模型名称不能为空");
    const requestId = request.requestId || `llm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await electronFetch(`${normalizeBaseUrl(request.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(llmBody({ ...request, requestId }, true)),
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(`模型请求失败（${response.status}）：${errorMessage(payload)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let model = request.model;
    let usage = { input: 0, output: 0, totalTokens: 0 };

    const emit = (payload) => event.sender.send("llm:chat-stream", payload);
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of block.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          // 个别坏行（心跳、注释、被切断的 JSON）不应中断整个流：解析失败则跳过该行
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (payload.model) model = payload.model;
          if (payload.usage) usage = usageFrom(payload.usage);
          const delta = payload.choices?.[0]?.delta?.content;
          if (delta) emit({ requestId, delta, done: false });
        }
      }
    }
    emit({ requestId, done: true, model, usage });
  }));
}

// 读取模型列表
async function listModels(request) {
  if (!String(request.apiKey || "").trim()) throw new Error("API Key 不能为空");
  const response = await electronFetch(`${normalizeBaseUrl(request.baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${request.apiKey.trim()}` },
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`读取模型列表失败（${response.status}）：${errorMessage(payload)}`);
  return (payload.data || []).map((item) => item.id).filter(Boolean);
}

function register(ipcMain) {
  ipcMain.handle("llm:chat-completion", (_event, { request }) => chatCompletion(request));
  ipcMain.handle("llm:chat-completion-stream", (event, { request }) => chatCompletionStream(event, request));
  ipcMain.handle("llm:list-models", (_event, { request }) => listModels(request));
}

module.exports = { register };
