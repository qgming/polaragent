// 图片工具 —— image_generation / image_edit
// 调用 OpenAI / OpenAI 兼容的 /images/generations 与 /images/edits 接口。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  corsFetch,
  downloadUrlAsBase64,
  openAiImageEdit,
  writeBase64File,
} from "@/lib/electron/electron-api";
import { useConfigStore } from "@/stores/config-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import { useTeamMonitorStore } from "@/stores/team/team-monitor-store";
import { fileName, resolvePath, text, type ToolContext } from "./tool-context";

const IMAGE_REQUEST_TIMEOUT_MS = 600000;

const imageGenerationParams = Type.Object({
  prompt: Type.String({ description: "图片生成提示词，描述主体、风格、构图、光线、画幅等要求" }),
  apiFormat: Type.Optional(
    Type.Union([Type.Literal("images"), Type.Literal("chat_completions")], {
      description:
        "接口格式：images 调用 /images/generations；chat_completions 调用 /chat/completions。根据图片服务商能力选择，默认 images。",
    }),
  ),
  fileName: Type.Optional(
    Type.String({ description: "保存文件名，支持 png/webp/jpg/jpeg；留空自动命名" }),
  ),
  size: Type.Optional(
    Type.String({ description: "图片尺寸，例如 1024x1024、1024x1536、1536x1024、1792x1024" }),
  ),
  quality: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("standard"),
      Type.Literal("hd"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
    ], { description: "质量档位；不同服务商支持项不同。由 AI 按任务选择；不确定可用 auto。" }),
  ),
  style: Type.Optional(
    Type.Union([Type.Literal("natural"), Type.Literal("vivid")], {
      description: "DALL-E 3 等模型支持的风格：natural 或 vivid",
    }),
  ),
  n: Type.Optional(
    Type.Number({ description: "生成张数，1-4，默认 1", minimum: 1, maximum: 4 }),
  ),
  responseFormat: Type.Optional(
    Type.Union([Type.Literal("b64_json"), Type.Literal("url")], {
      description: "返回格式。images 接口常用 b64_json/url；chat_completions 下用于提示模型优先返回 base64 或 URL。",
    }),
  ),
});

const imageEditParams = Type.Object({
  imagePath: Type.String({ description: "要编辑的源图片路径，相对工作目录或绝对路径；支持 png/webp/jpg/jpeg" }),
  prompt: Type.String({ description: "图片编辑提示词，说明要保留什么、修改什么、目标风格或构图" }),
  maskPath: Type.Optional(
    Type.String({ description: "可选蒙版图片路径；透明区域表示可编辑区域，需与源图尺寸一致" }),
  ),
  fileName: Type.Optional(
    Type.String({ description: "保存文件名，支持 png/webp/jpg/jpeg；留空自动命名" }),
  ),
  size: Type.Optional(
    Type.String({ description: "输出尺寸，例如 1024x1024、1024x1536、1536x1024" }),
  ),
  quality: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("standard"),
      Type.Literal("hd"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
    ], { description: "质量档位；不同服务商支持项不同，默认使用设置里的值" }),
  ),
  n: Type.Optional(
    Type.Number({ description: "生成张数，1-4，默认 1", minimum: 1, maximum: 4 }),
  ),
  responseFormat: Type.Optional(
    Type.Union([Type.Literal("b64_json"), Type.Literal("url")], {
      description: "返回格式。/images/edits 常用 b64_json/url；由 AI 按服务商能力选择。",
    }),
  ),
});

type ImageGenerationParams = Static<typeof imageGenerationParams>;
type ImageEditParams = Static<typeof imageEditParams>;

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

function shouldSendResponseFormat(model: string, responseFormat?: string) {
  if (!responseFormat || responseFormat === "auto") return false;
  if (/^gpt-image-/i.test(model)) return false;
  return /dall-e|image|sd|flux|kolors|wan|jimeng|seedream/i.test(model);
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

async function callImageGenerations({
  apiKey,
  baseURL,
  model,
  params,
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  params: ImageGenerationParams;
}) {
  const count = Math.min(Math.max(Math.trunc(params.n ?? 1), 1), 4);
  const requestBody: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    n: count,
  };
  if (params.size) requestBody.size = params.size;
  if (params.quality) requestBody.quality = params.quality;
  if (params.style && /dall-e-3/i.test(model)) requestBody.style = params.style;
  if (shouldSendResponseFormat(model, params.responseFormat)) {
    requestBody.response_format = params.responseFormat;
  }

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

async function callChatCompletionsImage({
  apiKey,
  baseURL,
  model,
  params,
}: {
  apiKey: string;
  baseURL: string;
  model: string;
  params: ImageGenerationParams;
}) {
  const optionHints = [
    params.size ? `size=${params.size}` : null,
    params.quality ? `quality=${params.quality}` : null,
    params.style ? `style=${params.style}` : null,
    params.n ? `n=${Math.min(Math.max(Math.trunc(params.n), 1), 4)}` : null,
    params.responseFormat ? `response_format=${params.responseFormat}` : null,
  ].filter(Boolean);
  const responseHint =
    params.responseFormat === "url"
      ? "请返回图片 URL，最好使用 JSON：{\"images\":[{\"url\":\"...\"}]}。"
      : "请返回图片 base64 data URL 或 JSON：{\"images\":[{\"b64_json\":\"...\"}]}。";

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
            responseHint,
        },
        {
          role: "user",
          content: [
            params.prompt,
            optionHints.length > 0 ? `生成选项：${optionHints.join(", ")}` : null,
          ]
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

export function generateImageTool(ctx: ToolContext): AgentTool<typeof imageGenerationParams> {
  return {
    name: "image_generation",
    label: "生成图片",
    description:
      "根据提示词生成图片。使用设置 > 通用 > 图片模式中的 OpenAI 或 OpenAI 兼容图片生成配置；" +
      "支持 /images/generations 与 /chat/completions 两种格式；返回 b64_json 时会保存到工作目录并登记为产物。",
    parameters: imageGenerationParams,
    execute: async (_id, params: ImageGenerationParams) => {
      const settings = useConfigStore.getState().settings.imageGeneration;
      const openai = settings?.openai;
      if (!openai?.apiKey?.trim()) throw new Error("图片生成 API Key 未配置");
      if (!openai.model?.trim()) throw new Error("图片生成模型未配置");

      const apiFormat = params.apiFormat ?? "images";
      const items: ImageResponseItem[] =
        apiFormat === "chat_completions"
          ? await callChatCompletionsImage({
              apiKey: openai.apiKey.trim(),
              baseURL: openai.baseURL,
              model: openai.model.trim(),
              params,
            })
          : await callImageGenerations({
              apiKey: openai.apiKey.trim(),
              baseURL: openai.baseURL,
              model: openai.model.trim(),
              params,
            });
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
          provider: settings?.provider ?? "openai",
          model: openai.model,
          endpoint: apiFormat === "chat_completions" ? "/chat/completions" : "/images/generations",
          apiFormat,
          ...imageResult,
        },
      };
    },
  };
}

export function editImageTool(ctx: ToolContext): AgentTool<typeof imageEditParams> {
  return {
    name: "image_edit",
    label: "编辑图片",
    description:
      "编辑已有图片。使用设置 > 通用 > 图片模式中的 OpenAI 或 OpenAI 兼容图片编辑配置；" +
      "调用 /images/edits，支持可选 mask 蒙版，返回 b64_json 时保存到工作目录。",
    parameters: imageEditParams,
    execute: async (_id, params: ImageEditParams) => {
      const settings = useConfigStore.getState().settings.imageGeneration;
      const openai = settings?.openai;
      if (!openai?.apiKey?.trim()) throw new Error("图片编辑 API Key 未配置");
      if (!openai.model?.trim()) throw new Error("图片编辑模型未配置");

      const imagePath = resolvePath(ctx, params.imagePath);
      const maskPath = params.maskPath?.trim()
        ? resolvePath(ctx, params.maskPath)
        : undefined;
      const count = Math.min(Math.max(Math.trunc(params.n ?? 1), 1), 4);

      const payload = await openAiImageEdit({
        apiKey: openai.apiKey.trim(),
        baseURL: openai.baseURL,
        imagePath,
        maskPath,
        model: openai.model.trim(),
        prompt: params.prompt,
        n: count,
        size: params.size,
        quality: params.quality,
        responseFormat: shouldSendResponseFormat(openai.model, params.responseFormat)
          ? params.responseFormat
          : undefined,
      });

      const items: ImageResponseItem[] = Array.isArray(payload.data) ? payload.data : [];
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
          provider: settings?.provider ?? "openai",
          model: openai.model,
          endpoint: "/images/edits",
          source: imagePath,
          mask: maskPath,
          ...imageResult,
        },
      };
    },
  };
}
