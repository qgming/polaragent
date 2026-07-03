// 轻量 LLM 调用工具
// src/ai/llm-call.ts
//
// 用统一的非流式 HTTP 请求调用当前模型路由，并为轻量结构化任务提供：
//   - openai-completions
//   - openai-responses
//   - anthropic-messages
//
// 设计目标：
//   1. 始终走非流式请求
//   2. jsonMode=true 时始终显式请求 JSON 对象输出
//   3. 对兼容接口保留尽可能完整的浏览器调试日志
//   4. 即使服务端误返回 SSE，也尽量提取正文并保留原始响应

import type { RoutedModelService } from "./model-router";
import { MAX_RETRIES, RETRY_DELAYS, sleep } from "./retry";

export interface LlmCallOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /** 强制 JSON 输出 */
  jsonMode?: boolean;
  /** 调试标签：输出到浏览器控制台，便于定位调用来源 */
  debugLabel?: string;
}

export async function callLlm(
  service: RoutedModelService,
  options: LlmCallOptions,
): Promise<string> {
  const requestId = buildLlmRequestId(options.debugLabel ?? "lightweight");

  logLlmDebug(`${requestId} request`, {
    providerId: service.provider.id,
    providerName: service.provider.name,
    providerType: service.provider.type,
    modelId: service.model.id,
    modelName: service.model.name,
    baseUrl: service.model.baseUrl,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    jsonMode: options.jsonMode === true,
    systemPrompt: options.systemPrompt,
    userPrompt: options.userPrompt,
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const result = await dispatchNonStreamingCall(service, options, requestId, controller.signal);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);

      logLlmDebug(`${requestId} error`, {
        attempt: attempt + 1,
        maxAttempts: MAX_RETRIES + 1,
        error: error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : String(error),
      });

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt];
        console.warn(
          `LLM调用失败，${delay}ms 后重试 (${attempt + 1}/${MAX_RETRIES}):`,
          error instanceof Error ? error.message : String(error),
        );
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw new Error("LLM 调用失败：已耗尽重试次数");
}

async function dispatchNonStreamingCall(
  service: RoutedModelService,
  options: LlmCallOptions,
  requestId: string,
  signal: AbortSignal,
): Promise<string> {
  switch (service.provider.type) {
    case "openai-completions":
      return callOpenAiCompletions(service, options, requestId, signal);
    case "openai-responses":
      return callOpenAiResponses(service, options, requestId, signal);
    case "anthropic-messages":
      return callAnthropicMessages(service, options, requestId, signal);
    default:
      throw new Error(`不支持的轻量调用 provider 类型: ${service.provider.type}`);
  }
}

async function callOpenAiCompletions(
  service: RoutedModelService,
  options: LlmCallOptions,
  requestId: string,
  signal: AbortSignal,
): Promise<string> {
  const payload: Record<string, unknown> = {
    model: service.model.id,
    messages: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userPrompt },
    ],
  };

  if (options.temperature !== undefined) {
    payload.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    const tokenField = prefersMaxCompletionTokens(service) ? "max_completion_tokens" : "max_tokens";
    payload[tokenField] = options.maxTokens;
  }
  if (options.jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  logLlmDebug(`${requestId} payload`, payload);

  const responseData = await postJsonLike({
    url: buildOpenAiCompletionsUrl(service.model.baseUrl),
    headers: buildProviderHeaders(service, "openai"),
    payload,
    signal,
    requestId,
  });

  logLlmDebug(`${requestId} assistant-message`, responseData.parsed ?? null);
  if (responseData.sseEvents.length > 0) {
    logLlmDebug(`${requestId} sse-events`, responseData.sseEvents);
  }

  const result =
    extractOpenAiCompletionsResult(responseData.parsed) ||
    extractOpenAiCompletionsFromSse(responseData.sseEvents) ||
    responseData.sseText ||
    "";

  logLlmDebug(`${requestId} result-text`, result);
  return result;
}

async function callOpenAiResponses(
  service: RoutedModelService,
  options: LlmCallOptions,
  requestId: string,
  signal: AbortSignal,
): Promise<string> {
  const payload: Record<string, unknown> = {
    model: service.model.id,
    instructions: options.systemPrompt,
    input: [
      {
        role: "user",
        content: options.userPrompt,
      },
    ],
  };

  if (options.temperature !== undefined) {
    payload.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    payload.max_output_tokens = options.maxTokens;
  }
  if (options.jsonMode) {
    payload.text = { format: { type: "json_object" } };
  }

  logLlmDebug(`${requestId} payload`, payload);

  const responseData = await postJsonLike({
    url: buildOpenAiResponsesUrl(service.model.baseUrl),
    headers: buildProviderHeaders(service, "openai"),
    payload,
    signal,
    requestId,
  });

  logLlmDebug(`${requestId} assistant-message`, responseData.parsed ?? null);
  if (responseData.sseEvents.length > 0) {
    logLlmDebug(`${requestId} sse-events`, responseData.sseEvents);
  }

  const result =
    extractOpenAiResponsesResult(responseData.parsed) ||
    extractOpenAiResponsesFromSse(responseData.sseEvents) ||
    responseData.sseText ||
    "";

  logLlmDebug(`${requestId} result-text`, result);
  return result;
}

async function callAnthropicMessages(
  service: RoutedModelService,
  options: LlmCallOptions,
  requestId: string,
  signal: AbortSignal,
): Promise<string> {
  const payload: Record<string, unknown> = {
    model: service.model.id,
    max_tokens: options.maxTokens ?? service.model.maxTokens ?? 1024,
    system: options.systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: options.userPrompt,
          },
        ],
      },
    ],
    stream: false,
  };

  if (options.temperature !== undefined) {
    payload.temperature = options.temperature;
  }

  logLlmDebug(`${requestId} payload`, payload);

  const responseData = await postJsonLike({
    url: buildAnthropicMessagesUrl(service.model.baseUrl),
    headers: buildProviderHeaders(service, "anthropic"),
    payload,
    signal,
    requestId,
  });

  logLlmDebug(`${requestId} assistant-message`, responseData.parsed ?? null);
  if (responseData.sseEvents.length > 0) {
    logLlmDebug(`${requestId} sse-events`, responseData.sseEvents);
  }

  const result =
    extractAnthropicMessagesResult(responseData.parsed) ||
    extractAnthropicFromSse(responseData.sseEvents) ||
    responseData.sseText ||
    "";

  logLlmDebug(`${requestId} result-text`, result);
  return result;
}

interface PostJsonLikeParams {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  requestId: string;
}

interface JsonLikeResponse {
  parsed: unknown;
  rawText: string;
  contentType: string;
  sseEvents: unknown[];
  sseText: string;
}

async function postJsonLike(params: PostJsonLikeParams): Promise<JsonLikeResponse> {
  const response = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify(params.payload),
    signal: params.signal,
  });

  const rawText = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  logLlmDebug(`${params.requestId} provider-response`, {
    status: response.status,
    statusText: response.statusText,
    url: params.url,
    headers: headersToObject(response.headers),
  });
  logLlmDebug(`${params.requestId} raw-response-text`, rawText);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${rawText || "请求失败"}`);
  }

  const parsedJson = safeParseJson(rawText);
  if (parsedJson !== null) {
    return {
      parsed: parsedJson,
      rawText,
      contentType,
      sseEvents: [],
      sseText: "",
    };
  }

  if (looksLikeSse(rawText, contentType)) {
    const sse = parseSsePayloads(rawText);
    logLlmDebug(`${params.requestId} parsed-sse`, sse);

    const finalParsed = sse.parsedEvents.length > 0
      ? sse.parsedEvents[sse.parsedEvents.length - 1]
      : null;

    return {
      parsed: finalParsed,
      rawText,
      contentType,
      sseEvents: sse.parsedEvents,
      sseText: sse.text,
    };
  }

  throw new Error("响应不是合法 JSON，且无法按 SSE 解析");
}

function extractOpenAiCompletionsResult(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";

  const record = parsed as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const parts: string[] = [];

  for (const choice of choices) {
    const text = extractOpenAiChoiceText(choice);
    if (text.trim()) parts.push(text);
  }

  if (parts.length > 0) {
    return parts.join("\n");
  }

  return extractTextByKeySearch(parsed, [
    "output_text",
    "content",
    "text",
    "reasoning_content",
    "reasoning",
  ]);
}

function extractOpenAiCompletionsFromSse(events: unknown[]): string {
  const parts: string[] = [];

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    const choices = Array.isArray(record.choices) ? record.choices : [];

    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const choiceRecord = choice as Record<string, unknown>;
      const delta = choiceRecord.delta && typeof choiceRecord.delta === "object"
        ? (choiceRecord.delta as Record<string, unknown>)
        : null;

      const deltaText = extractOpenAiMessageText(delta?.content) ||
        extractOpenAiMessageText(delta?.text) ||
        stringOrEmpty(delta?.reasoning_content) ||
        stringOrEmpty(delta?.reasoning);
      if (deltaText.trim()) {
        parts.push(deltaText);
        continue;
      }

      const messageText = extractOpenAiChoiceText(choice);
      if (messageText.trim()) {
        parts.push(messageText);
      }
    }
  }

  return parts.join("");
}

function extractOpenAiResponsesResult(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";

  const record = parsed as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text;
  }

  const direct = extractTextByKeySearch(parsed, ["output_text", "text", "content"]);
  if (direct.trim()) return direct;

  return extractOpenAiResponsesOutput(record.output);
}

function extractOpenAiResponsesFromSse(events: unknown[]): string {
  const parts: string[] = [];

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;

    if (typeof record.delta === "string" && record.delta.trim()) {
      parts.push(record.delta);
      continue;
    }

    const type = typeof record.type === "string" ? record.type : "";
    if (type.includes("output_text") || type.includes("response.output_text")) {
      const text = extractTextByKeySearch(record, ["delta", "text", "output_text"]);
      if (text.trim()) {
        parts.push(text);
      }
      continue;
    }

    const fallback = extractOpenAiResponsesResult(record);
    if (fallback.trim()) {
      parts.push(fallback);
    }
  }

  return parts.join("");
}

function extractAnthropicMessagesResult(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";

  const record = parsed as Record<string, unknown>;
  const contentText = extractAnthropicText(record.content);
  if (contentText.trim()) {
    return contentText;
  }

  return extractTextByKeySearch(parsed, ["output_text", "text", "content"]);
}

function extractAnthropicFromSse(events: unknown[]): string {
  const parts: string[] = [];

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";

    if (type === "content_block_delta") {
      const delta = record.delta && typeof record.delta === "object"
        ? (record.delta as Record<string, unknown>)
        : null;
      const text = stringOrEmpty(delta?.text);
      if (text.trim()) {
        parts.push(text);
      }
      continue;
    }

    const fallback = extractAnthropicMessagesResult(record);
    if (fallback.trim()) {
      parts.push(fallback);
    }
  }

  return parts.join("");
}

function extractOpenAiChoiceText(choice: unknown): string {
  if (!choice || typeof choice !== "object") return "";

  const record = choice as Record<string, unknown>;
  const message = record.message && typeof record.message === "object"
    ? (record.message as Record<string, unknown>)
    : null;
  const delta = record.delta && typeof record.delta === "object"
    ? (record.delta as Record<string, unknown>)
    : null;

  const candidates = [
    message?.content,
    message?.reasoning_content,
    message?.reasoning,
    message?.text,
    delta?.content,
    delta?.reasoning_content,
    delta?.reasoning,
    delta?.text,
    record.content,
    record.text,
  ];

  for (const candidate of candidates) {
    const text = extractOpenAiMessageText(candidate);
    if (text.trim()) return text;
  }

  return "";
}

function extractOpenAiMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      if (record.text && typeof record.text === "object") {
        const nested = record.text as Record<string, unknown>;
        if (typeof nested.value === "string") return nested.value;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractOpenAiResponsesOutput(output: unknown): string {
  if (!Array.isArray(output)) return "";

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      for (const contentItem of record.content) {
        if (!contentItem || typeof contentItem !== "object") continue;
        const contentRecord = contentItem as Record<string, unknown>;
        if (typeof contentRecord.text === "string") {
          parts.push(contentRecord.text);
          continue;
        }
        if (contentRecord.text && typeof contentRecord.text === "object") {
          const nestedText = (contentRecord.text as Record<string, unknown>).value;
          if (typeof nestedText === "string") {
            parts.push(nestedText);
          }
        }
      }
    }
  }

  return parts.join("\n");
}

function extractAnthropicText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractTextByKeySearch(value: unknown, preferredKeys: string[], depth = 0): string {
  if (depth > 5 || value == null) return "";
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextByKeySearch(item, preferredKeys, depth + 1))
      .filter((item) => item.trim().length > 0);
    return parts.join("\n");
  }

  if (typeof value !== "object") return "";

  const record = value as Record<string, unknown>;

  for (const key of preferredKeys) {
    if (!(key in record)) continue;
    const text = extractTextByKeySearch(record[key], preferredKeys, depth + 1);
    if (text.trim()) return text;
  }

  for (const nested of Object.values(record)) {
    const text = extractTextByKeySearch(nested, preferredKeys, depth + 1);
    if (text.trim()) return text;
  }

  return "";
}

function looksLikeSse(rawText: string, contentType: string): boolean {
  return contentType.includes("text/event-stream") || /^\s*data:/m.test(rawText);
}

function parseSsePayloads(rawText: string): { parsedEvents: unknown[]; text: string } {
  const chunks = rawText.split(/\r?\n\r?\n/);
  const parsedEvents: unknown[] = [];
  const textParts: string[] = [];

  for (const chunk of chunks) {
    const dataLines = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;

    const parsed = safeParseJson(payload);
    if (parsed !== null) {
      parsedEvents.push(parsed);

      const text =
        extractOpenAiCompletionsResult(parsed) ||
        extractOpenAiResponsesResult(parsed) ||
        extractAnthropicMessagesResult(parsed) ||
        extractTextByKeySearch(parsed, ["delta", "output_text", "text", "content"]);
      if (text.trim()) {
        textParts.push(text);
      }
      continue;
    }

    textParts.push(payload);
  }

  return {
    parsedEvents,
    text: textParts.join(""),
  };
}

function buildProviderHeaders(
  service: RoutedModelService,
  kind: "openai" | "anthropic",
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const apiKey = service.provider.apiKey;
  if (!apiKey) {
    throw new Error("模型服务缺少 API Key");
  }

  const host = `${service.provider.name} ${service.provider.baseURL} ${service.model.baseUrl} ${service.model.provider}`.toLowerCase();
  const isXiaomiStyle = host.includes("xiaomi") || host.includes("mimo");

  if (kind === "anthropic") {
    headers[isXiaomiStyle ? "api-key" : "x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    if (isXiaomiStyle) {
      headers["api-key"] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  if (service.model.headers) {
    Object.assign(headers, service.model.headers);
  }

  return headers;
}

function buildOpenAiCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function buildOpenAiResponsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/messages")) {
    return trimmed;
  }
  if (/\/v\d+(?:beta\d+)?$/i.test(trimmed)) {
    return `${trimmed}/messages`;
  }
  return `${trimmed}/v1/messages`;
}

function prefersMaxCompletionTokens(service: RoutedModelService): boolean {
  const host = `${service.provider.name} ${service.provider.baseURL} ${service.model.baseUrl} ${service.model.provider}`.toLowerCase();
  return host.includes("xiaomi") || host.includes("mimo");
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function buildLlmRequestId(debugLabel: string): string {
  return `[llm-call:${debugLabel}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}]`;
}

function logLlmDebug(label: string, value: unknown): void {
  try {
    console.log(label, serializeForDebug(value));
  } catch (error) {
    console.log(label, value, "(debug serialize failed)", error);
  }
}

function serializeForDebug(value: unknown): unknown {
  if (typeof value === "string") return value;
  return JSON.parse(JSON.stringify(value, createDebugReplacer()));
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function createDebugReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
