// 图片工具 —— image_generation / image_edit
// 接口标准由用户在「设置 > 通用 > 图片模式」中选择（openai-images / openai-chat / gemini）。
// 前端与 AI 对外显示「比例（aspectRatio）+ 分辨率（resolution）」；
// 设置保存与实际请求使用各标准自己的真实参数：OpenAI size，Gemini aspectRatio/imageSize。
// 其余特殊参数（质量、格式、背景等）不主动发送，交给具体模型默认值。
// 不支持编辑的标准（openai-chat）下，image_edit 工具不会被注册（见 tools/index.ts）。

import { Type, type TProperties } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  corsFetch,
  downloadUrlAsBase64,
  openAiImageEdit,
  readBase64File,
  writeBase64File,
} from "@/lib/electron/electron-api";
import type {
  ImageApiStandard,
  ImageAspectRatio,
  ImageGenerationConfig,
  ImageResolution,
} from "@/types/config";
import {
  openAiSizeFromDisplay,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
} from "@/lib/image-params";
import { useConfigStore } from "@/stores/config-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import { useTeamMonitorStore } from "@/stores/team/team-monitor-store";
import { fileName, resolvePath, text, type ToolContext } from "./tool-context";

const IMAGE_REQUEST_TIMEOUT_MS = 1800000; // 30 分钟
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// ===== 动态参数 schema =====
// 对外统一只暴露 aspectRatio + resolution（外加 prompt / n / fileName）。
// 编辑工具在 openai-images 下额外提供可选 maskPath。

function buildGenerationParams() {
  const props: TProperties = {
    prompt: Type.String({
      description: "图片生成提示词，描述主体、风格、构图、光线等要求",
    }),
    aspectRatio: Type.Optional(
      Type.Union(IMAGE_ASPECT_RATIOS.map((r) => Type.Literal(r)), {
        description:
          "可选画幅比例：1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 2:3 / 3:2 / 21:9。" +
          "无明确比例需求时请省略，由模型自行决定（部分模型不支持指定比例，强行指定会报错）。",
      }),
    ),
    resolution: Type.Optional(
      Type.Union(IMAGE_RESOLUTIONS.map((r) => Type.Literal(r)), {
        description: "可选分辨率：1K / 2K / 4K。无明确分辨率需求时请省略，由模型自行决定。",
      }),
    ),
    n: Type.Optional(
      Type.Number({ description: "生成张数，1-4，默认 1", minimum: 1, maximum: 4 }),
    ),
    fileName: Type.Optional(
      Type.String({ description: "保存文件名，支持 png/webp/jpg/jpeg；留空自动命名" }),
    ),
  };
  return Type.Object(props);
}

function buildEditParams(provider: ImageApiStandard) {
  const props: TProperties = {
    imagePath: Type.String({
      description: "要编辑的源图片路径，相对工作目录或绝对路径；支持 png/webp/jpg/jpeg",
    }),
    prompt: Type.String({
      description: "图片编辑提示词，说明要保留什么、修改什么、目标风格或构图",
    }),
  };

  if (provider === "openai-images") {
    props.maskPath = Type.Optional(
      Type.String({
        description: "可选蒙版图片路径；透明区域表示可编辑区域，需与源图尺寸一致",
      }),
    );
  }

  props.aspectRatio = Type.Optional(
    Type.Union(IMAGE_ASPECT_RATIOS.map((r) => Type.Literal(r)), {
      description:
        "可选画幅比例：1:1 / 16:9 / 9:16 / 4:3 / 3:4 等。" +
        "无明确比例需求时请省略，由模型自行决定（部分模型不支持指定比例，强行指定会报错）。",
    }),
  );
  props.resolution = Type.Optional(
    Type.Union(IMAGE_RESOLUTIONS.map((r) => Type.Literal(r)), {
      description: "可选分辨率：1K / 2K / 4K。无明确分辨率需求时请省略，由模型自行决定。",
    }),
  );
  props.n = Type.Optional(
    Type.Number({ description: "生成张数，1-4，默认 1", minimum: 1, maximum: 4 }),
  );
  props.fileName = Type.Optional(
    Type.String({ description: "保存文件名，支持 png/webp/jpg/jpeg；留空自动命名" }),
  );
  return Type.Object(props);
}

// 工具运行时收到的参数（对外统一两参数）
interface GenParams {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
  resolution?: ImageResolution;
  n?: number;
  fileName?: string;
}

interface EditParams {
  imagePath: string;
  prompt: string;
  maskPath?: string;
  aspectRatio?: ImageAspectRatio;
  resolution?: ImageResolution;
  n?: number;
  fileName?: string;
}

interface ImageResponseItem {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

function normalizeImageBaseUrl(baseURL: string) {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("图片生成 Base URL 未配置");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function imageErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return "服务返回错误";
  const obj = payload as Record<string, any>;
  return obj.error?.message || obj.message || obj.error || "服务返回错误";
}

function safeImageFileName(
  input: string | undefined,
  index: number,
  total: number,
  prefix: string,
  extension = "png",
) {
  const fallback = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const raw = (input?.trim() || fallback).replace(/[<>:"|?*\x00-\x1f]/g, "-");
  const safeExt = /^(png|webp|jpe?g|gif)$/i.test(extension) ? extension.toLowerCase() : "png";
  const withExt = /\.(png|webp|jpe?g|gif)$/i.test(raw)
    ? raw
    : `${raw.replace(/\.+$/, "")}.${safeExt}`;
  if (total <= 1) return withExt;
  return withExt.replace(/(\.(png|webp|jpe?g|gif))$/i, `-${String(index + 1).padStart(2, "0")}$1`);
}

function parseJsonResponse(body: string, status: number, label: string) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label}接口返回了非 JSON 内容（HTTP ${status}）`);
  }
}

function normalizeBase64Image(value: string) {
  const trimmed = value.trim();
  const dataUrl = trimmed.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([a-zA-Z0-9+/=\r\n]+)$/);
  return (dataUrl?.[1] ?? trimmed).replace(/\s/g, "");
}

function imageExtensionFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    const ext = match?.[1]?.toLowerCase();
    return /^(png|webp|jpe?g|gif)$/.test(ext ?? "") ? ext : undefined;
  } catch {
    return undefined;
  }
}

function addImageArtifact(ctx: ToolContext, path: string) {
  const artifact = { path, name: fileName(path), kind: "final" as const };
  if (ctx.isTeam) {
    useTeamMonitorStore.getState().addArtifact(ctx.threadId, artifact);
  } else {
    useTaskMonitorStore.getState().addArtifact(ctx.threadId, artifact);
  }
}

function extractChatContent(payload: any) {
  const message = payload?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text ?? "";
        if (part?.type === "image_url") return part.image_url?.url ?? "";
        if (part?.type === "output_image") return part.b64_json ?? part.url ?? "";
        return part?.text ?? part?.url ?? part?.b64_json ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return payload?.choices?.[0]?.text ?? "";
}

function extractImagesFromChatPayload(payload: any): ImageResponseItem[] {
  const items: ImageResponseItem[] = [];
  const content = extractChatContent(payload);
  const seen = new Set<string>();

  const addUrl = (url: string) => {
    const clean = url.trim().replace(/[)>\]"']+$/g, "");
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    items.push({ url: clean });
  };
  const addBase64 = (base64: string) => {
    const clean = normalizeBase64Image(base64);
    if (!clean || clean.length < 80 || seen.has(clean)) return;
    seen.add(clean);
    items.push({ b64_json: clean });
  };

  for (const match of content.matchAll(/data:image\/[a-zA-Z0-9.+-]+;base64,([a-zA-Z0-9+/=\r\n]+)/g)) {
    addBase64(match[1]);
  }
  for (const match of content.matchAll(/https?:\/\/[^\s)>'"]+/g)) {
    addUrl(match[0]);
  }

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? content;
  try {
    const parsed = JSON.parse(fenced);
    const candidates = Array.isArray(parsed) ? parsed : parsed.images ?? parsed.data ?? [parsed];
    for (const item of Array.isArray(candidates) ? candidates : [candidates]) {
      if (typeof item === "string") {
        if (/^https?:\/\//i.test(item.trim())) addUrl(item);
        else addBase64(item);
      } else if (item && typeof item === "object") {
        if (typeof item.url === "string") addUrl(item.url);
        if (typeof item.image_url === "string") addUrl(item.image_url);
        if (typeof item.b64_json === "string") addBase64(item.b64_json);
        if (typeof item.base64 === "string") addBase64(item.base64);
      }
    }
  } catch {
    // 文本不是 JSON 很常见，前面的 URL/data URL 提取已经覆盖主路径。
  }

  return items;
}

// 从 Gemini :generateContent 响应中提取 inlineData 图片。
function extractImagesFromGeminiPayload(payload: any): ImageResponseItem[] {
  const items: ImageResponseItem[] = [];
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return items;
  for (const part of parts) {
    const inline = part?.inlineData ?? part?.inline_data;
    const data = inline?.data;
    if (typeof data === "string" && data.length > 0) {
      items.push({ b64_json: normalizeBase64Image(data) });
    }
  }
  return items;
}

// ===== 各接口标准的生成实现 =====

async function callOpenAiImages({
  apiKey,
  baseURL,
  model,
  prompt,
  size,
  n,
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  prompt: string;
  size?: string;
  n: number;
}) {
  // size 缺省时不发送，交给模型默认尺寸（避免对不支持该参数的模型报错）。
  const requestBody: Record<string, unknown> = { model, prompt, n };
  if (size) requestBody.size = size;

  const response = await corsFetch({
    url: `${normalizeImageBaseUrl(baseURL)}/images/generations`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
  });

  const payload = parseJsonResponse(response.body, response.status, "图片生成");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`图片生成失败（${response.status}）：${imageErrorMessage(payload)}`);
  }
  return Array.isArray(payload.data) ? payload.data : [];
}

async function callOpenAiChatImage({
  apiKey,
  baseURL,
  model,
  prompt,
  size,
  n,
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  prompt: string;
  size?: string;
  n: number;
}) {
  const optionHints = [size ? `size=${size}` : null, n > 1 ? `n=${n}` : null].filter(Boolean);

  const response = await corsFetch({
    url: `${normalizeImageBaseUrl(baseURL)}/chat/completions`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "你是图片生成接口。根据用户提示生成图片，不要解释过程。" +
            "请返回图片 base64 data URL 或 JSON：{\"images\":[{\"b64_json\":\"...\"}]}。",
        },
        {
          role: "user",
          content: [prompt, optionHints.length > 0 ? `生成选项：${optionHints.join(", ")}` : null]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    }),
    timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
  });

  const payload = parseJsonResponse(response.body, response.status, "Chat Completions 图片生成");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Chat Completions 图片生成失败（${response.status}）：${imageErrorMessage(payload)}`);
  }
  return extractImagesFromChatPayload(payload);
}

async function callGeminiImage({
  apiKey,
  baseURL,
  model,
  prompt,
  aspectRatio,
  imageSize,
  candidateCount,
  inlineImage,
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  candidateCount?: number;
  // 图片编辑时传入源图，作为多模态输入随提示一起发送
  inlineImage?: { data: string; mimeType: string };
}) {
  const base = (baseURL?.trim() || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (inlineImage) {
    parts.push({ inlineData: { mimeType: inlineImage.mimeType, data: inlineImage.data } });
  }

  // Gemini 3 标准通过 generationConfig.imageConfig 控制画幅与分辨率，
  // candidateCount 控制返回图片数量（多图生成）。
  const generationConfig: Record<string, unknown> = { responseModalities: ["IMAGE"] };
  if (candidateCount !== undefined && candidateCount > 1) {
    generationConfig.candidateCount = candidateCount;
  }
  const imageConfig: Record<string, unknown> = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;
  if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig;

  const response = await corsFetch({
    url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // 使用请求头携带密钥，避免出现在 URL/日志中
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig,
    }),
    timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
  });

  const payload = parseJsonResponse(response.body, response.status, "Gemini 图片生成");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Gemini 图片生成失败（${response.status}）：${imageErrorMessage(payload)}`);
  }
  return extractImagesFromGeminiPayload(payload);
}

async function saveImageResponseItems({
  ctx,
  fileName: outputFileName,
  items,
  prefix,
}: {
  ctx: ToolContext;
  fileName?: string;
  items: ImageResponseItem[];
  prefix: string;
}) {
  const saved: Array<{ path: string; name: string }> = [];
  const urls: string[] = [];
  const revisedPrompts: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.revised_prompt) revisedPrompts.push(item.revised_prompt);
    if (item.url) urls.push(item.url);

    let base64 = item.b64_json ? normalizeBase64Image(item.b64_json) : "";
    let extension = "png";
    if (!base64 && item.url) {
      const downloaded = await downloadUrlAsBase64({ url: item.url, timeoutMs: IMAGE_REQUEST_TIMEOUT_MS });
      base64 = normalizeBase64Image(downloaded.base64);
      extension = imageExtensionFromUrl(item.url) ?? downloaded.extension ?? extension;
    }
    if (!base64) continue;

    const target = resolvePath(
      ctx,
      safeImageFileName(outputFileName, index, items.length, prefix, extension),
    );
    await writeBase64File(target, base64);
    addImageArtifact(ctx, target);
    saved.push({ path: target, name: fileName(target) });
  }

  return { saved, urls, revisedPrompts };
}

function imageResultLines(
  action: "生成" | "编辑",
  result: Awaited<ReturnType<typeof saveImageResponseItems>>,
) {
  return [
    result.saved.length > 0
      ? `已${action}并保存 ${result.saved.length} 张图片：${result.saved.map((item) => item.name).join("、")}`
      : `图片已${action}，但接口只返回了 URL，未写入本地文件。`,
    result.urls.length > 0 ? `图片 URL：\n${result.urls.join("\n")}` : null,
    result.revisedPrompts.length > 0
      ? `修订后的提示词：\n${result.revisedPrompts.join("\n---\n")}`
      : null,
  ].filter(Boolean);
}

// 读取当前图片接口标准（供工具工厂在构建时裁剪参数 schema 用）。
function currentImageProvider(): ImageApiStandard {
  const config = useConfigStore.getState().settings.imageGeneration as
    | ImageGenerationConfig
    | undefined;
  return config?.provider ?? "openai-images";
}

// 当前所选标准是否支持图片编辑：openai-chat 不支持。
export function imageEditAvailable(): boolean {
  const provider = currentImageProvider();
  return provider === "openai-images" || provider === "gemini";
}

// 读取图片配置并校验当前所选标准的必填项，返回标准与对应配置。
function resolveImageConfig(action: "生成" | "编辑") {
  const config = useConfigStore.getState().settings.imageGeneration as
    | ImageGenerationConfig
    | undefined;
  const provider: ImageApiStandard = config?.provider ?? "openai-images";

  if (provider === "gemini") {
    const gemini = config?.gemini;
    if (!gemini?.apiKey?.trim()) throw new Error(`图片${action} API Key 未配置（Gemini）`);
    if (!gemini.model?.trim()) throw new Error(`图片${action}模型未配置（Gemini）`);
    return { provider, gemini } as const;
  }
  if (provider === "openai-chat") {
    const openaiChat = config?.openaiChat;
    if (!openaiChat?.apiKey?.trim()) throw new Error(`图片${action} API Key 未配置（OpenAI Chat）`);
    if (!openaiChat.model?.trim()) throw new Error(`图片${action}模型未配置（OpenAI Chat）`);
    return { provider, openaiChat } as const;
  }
  const openaiImages = config?.openaiImages;
  if (!openaiImages?.apiKey?.trim()) throw new Error(`图片${action} API Key 未配置（OpenAI 图片接口）`);
  if (!openaiImages.model?.trim()) throw new Error(`图片${action}模型未配置（OpenAI 图片接口）`);
  return { provider, openaiImages } as const;
}

// 推断本地图片的 MIME 类型（供 Gemini inlineData 使用）。
function imageMimeFromPath(path: string) {
  const ext = path.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

// 计算 OpenAI 标准的 size（WxH）；返回 undefined 表示不发送 size，交给模型默认尺寸。
// 只有 AI 同时指定比例和分辨率时才计算 size；任一缺失则返回 undefined。
// 按模型能力选择固定尺寸白名单或自由 WxH，避免固定尺寸枚举模型收到非法尺寸而 400。
function openAiSizeFromParams(
  model: string,
  params: Pick<GenParams | EditParams, "aspectRatio" | "resolution">,
): string | undefined {
  if (!params.aspectRatio || !params.resolution) return undefined;
  return openAiSizeFromDisplay(model, params.aspectRatio, params.resolution);
}

// 生成/编辑工具的可用参数说明（比例与分辨率均由 AI 按需填写，省略时交给模型自行决定）。
const IMAGE_PARAM_HINT =
  "可用参数：prompt、aspectRatio（比例 1:1/16:9/9:16/4:3/3:4/2:3/3:2/21:9）、" +
  "resolution（分辨率 1K/2K/4K）、n、fileName。比例与分辨率均为可选，省略时不发送该参数，交给模型自行决定。";

export function generateImageTool(ctx: ToolContext): AgentTool<any> {
  const parameters = buildGenerationParams();

  return {
    name: "image_generation",
    label: "生成图片",
    description: `根据提示词生成图片。${IMAGE_PARAM_HINT}生成图片会保存到工作目录并登记为产物。`,
    parameters,
    execute: async (_id, rawParams) => {
      const params = rawParams as GenParams;
      const resolved = resolveImageConfig("生成");
      const n = Math.min(Math.max(Math.trunc(params.n ?? 1), 1), 4);

      let items: ImageResponseItem[] = [];
      let endpoint = "";

      if (resolved.provider === "gemini") {
        const { gemini } = resolved;
        endpoint = ":generateContent";
        items = await callGeminiImage({
          apiKey: gemini.apiKey.trim(),
          baseURL: gemini.baseURL ?? "",
          model: gemini.model.trim(),
          prompt: params.prompt,
          // AI 优先：AI 未指定时不传递，交给模型自行决定
          aspectRatio: params.aspectRatio,
          imageSize: params.resolution,
          candidateCount: n,
        });
      } else if (resolved.provider === "openai-chat") {
        const { openaiChat } = resolved;
        endpoint = "/chat/completions";
        const model = openaiChat.model.trim();
        items = await callOpenAiChatImage({
          apiKey: openaiChat.apiKey.trim(),
          baseURL: openaiChat.baseURL,
          model,
          prompt: params.prompt,
          size: openAiSizeFromParams(model, params),
          n,
        });
      } else {
        const { openaiImages } = resolved;
        endpoint = "/images/generations";
        const model = openaiImages.model.trim();
        items = await callOpenAiImages({
          apiKey: openaiImages.apiKey.trim(),
          baseURL: openaiImages.baseURL,
          model,
          prompt: params.prompt,
          size: openAiSizeFromParams(model, params),
          n,
        });
      }

      if (items.length === 0) throw new Error("图片生成接口未返回图片数据");

      const imageResult = await saveImageResponseItems({
        ctx,
        fileName: params.fileName,
        items,
        prefix: "generated-image",
      });

      return {
        content: text(imageResultLines("生成", imageResult).join("\n\n")),
        details: {
          provider: resolved.provider,
          endpoint,
          ...imageResult,
        },
      };
    },
  };
}

export function editImageTool(ctx: ToolContext): AgentTool<any> {
  const provider = currentImageProvider();
  const parameters = buildEditParams(provider);

  return {
    name: "image_edit",
    label: "编辑图片",
    description: `编辑已有图片。${IMAGE_PARAM_HINT}openai-images 标准支持可选 mask 蒙版。`,
    parameters,
    execute: async (_id, rawParams) => {
      const params = rawParams as EditParams;
      const resolved = resolveImageConfig("编辑");
      const imagePath = resolvePath(ctx, params.imagePath);
      const n = Math.min(Math.max(Math.trunc(params.n ?? 1), 1), 4);

      let items: ImageResponseItem[] = [];
      let endpoint = "";

      if (resolved.provider === "gemini") {
        const { gemini } = resolved;
        endpoint = ":generateContent";
        // 读取源图并作为 inlineData 随提示一起发送
        const sourceBase64 = await readBase64File(imagePath);
        items = await callGeminiImage({
          apiKey: gemini.apiKey.trim(),
          baseURL: gemini.baseURL ?? "",
          model: gemini.model.trim(),
          prompt: params.prompt,
          // AI 优先：AI 未指定时不传递，交给模型自行决定
          aspectRatio: params.aspectRatio,
          imageSize: params.resolution,
          candidateCount: n,
          inlineImage: {
            data: normalizeBase64Image(sourceBase64),
            mimeType: imageMimeFromPath(imagePath),
          },
        });
      } else if (resolved.provider === "openai-chat") {
        // 兜底：理论上此标准下工具不会被注册（见 tools/index.ts 的 isAvailable）。
        throw new Error(
          "当前接口标准为 OpenAI Chat，不支持图片编辑；请在「设置 > 图片模式」改用 OpenAI 图片接口或 Gemini 标准。",
        );
      } else {
        const { openaiImages } = resolved;
        endpoint = "/images/edits";
        const maskPath = params.maskPath?.trim() ? resolvePath(ctx, params.maskPath) : undefined;
        const model = openaiImages.model.trim();
        const payload = await openAiImageEdit({
          apiKey: openaiImages.apiKey.trim(),
          baseURL: openaiImages.baseURL,
          imagePath,
          maskPath,
          model,
          prompt: params.prompt,
          n,
          size: openAiSizeFromParams(model, params),
        });
        items = Array.isArray(payload.data) ? payload.data : [];
      }

      if (items.length === 0) throw new Error("图片编辑接口未返回图片数据");

      const imageResult = await saveImageResponseItems({
        ctx,
        fileName: params.fileName,
        items,
        prefix: "edited-image",
      });

      return {
        content: text(imageResultLines("编辑", imageResult).join("\n\n")),
        details: {
          provider: resolved.provider,
          endpoint,
          source: imagePath,
          ...imageResult,
        },
      };
    },
  };
}
