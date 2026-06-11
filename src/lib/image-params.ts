import type { ImageAspectRatio, ImageResolution } from "@/types/config";

export const IMAGE_ASPECT_RATIOS: ImageAspectRatio[] = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "2:3",
  "3:2",
  "21:9",
];

export const IMAGE_RESOLUTIONS: ImageResolution[] = ["1K", "2K", "4K"];

const GPT_IMAGE_2_TARGET_PIXELS: Record<ImageResolution, number> = {
  "1K": 1024 * 1024,
  "2K": 2048 * 2048,
  "4K": 3840 * 2160,
};

const GPT_IMAGE_2_MAX_EDGE = 3840;
const GPT_IMAGE_2_MIN_PIXELS = 655_360;
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;

// 固定尺寸枚举模型：仅接受白名单内的尺寸，自由 WxH 会被接口拒绝（400）。
// 对这些模型按目标比例从白名单里选最接近的一项，而非凭空计算尺寸。
const FIXED_SIZE_MODELS: Array<{ pattern: RegExp; sizes: string[] }> = [
  { pattern: /dall-e-3/i, sizes: ["1024x1024", "1792x1024", "1024x1792"] },
  { pattern: /dall-e-2/i, sizes: ["256x256", "512x512", "1024x1024"] },
  { pattern: /gpt-image-1\b/i, sizes: ["1024x1024", "1536x1024", "1024x1536"] },
];

export function parseAspectRatio(aspectRatio?: string) {
  const [rawW, rawH] = (aspectRatio || "1:1").split(":").map((n) => Number(n));
  const width = Number.isFinite(rawW) && rawW > 0 ? rawW : 1;
  const height = Number.isFinite(rawH) && rawH > 0 ? rawH : 1;
  return { width, height };
}

function roundToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function floorToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

function clampGptImage2Size(width: number, height: number) {
  let nextWidth = width;
  let nextHeight = height;
  const maxEdge = Math.max(nextWidth, nextHeight);
  if (maxEdge > GPT_IMAGE_2_MAX_EDGE) {
    const scale = GPT_IMAGE_2_MAX_EDGE / maxEdge;
    nextWidth *= scale;
    nextHeight *= scale;
  }

  const pixels = nextWidth * nextHeight;
  if (pixels > GPT_IMAGE_2_MAX_PIXELS) {
    const scale = Math.sqrt(GPT_IMAGE_2_MAX_PIXELS / pixels);
    nextWidth *= scale;
    nextHeight *= scale;
  } else if (pixels < GPT_IMAGE_2_MIN_PIXELS) {
    const scale = Math.sqrt(GPT_IMAGE_2_MIN_PIXELS / pixels);
    nextWidth *= scale;
    nextHeight *= scale;
  }

  // 先按四舍五入对齐到 16 的倍数；若取整后越过边长/像素上限，则改为向下取整，
  // 确保最终尺寸始终落在 clamp 约束内（四舍五入可能把已贴近上限的值推到上限之外）。
  let outWidth = roundToMultiple(nextWidth, 16);
  let outHeight = roundToMultiple(nextHeight, 16);
  if (
    Math.max(outWidth, outHeight) > GPT_IMAGE_2_MAX_EDGE ||
    outWidth * outHeight > GPT_IMAGE_2_MAX_PIXELS
  ) {
    outWidth = floorToMultiple(nextWidth, 16);
    outHeight = floorToMultiple(nextHeight, 16);
  }

  return { width: outWidth, height: outHeight };
}

// 从白名单尺寸里按目标比例选最接近的一项（用于固定尺寸枚举模型）。
function closestFixedSize(sizes: string[], aspectRatio: string) {
  const { width, height } = parseAspectRatio(aspectRatio);
  const target = width / height;
  let best = sizes[0];
  let bestDiff = Infinity;
  for (const size of sizes) {
    const [w, h] = size.split("x").map((n) => Number(n));
    if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) continue;
    const diff = Math.abs(w / h - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = size;
    }
  }
  return best;
}

// OpenAI 图片接口：按模型能力换算 size。
// 固定尺寸枚举模型（dall-e-2/3、gpt-image-1）按比例从白名单选最接近的尺寸；
// 其余模型（gpt-image-2 及多数兼容模型）使用自由 WxH。
export function openAiSizeFromDisplay(
  model: string,
  aspectRatio: string = "1:1",
  resolution: ImageResolution = "1K",
) {
  const fixed = FIXED_SIZE_MODELS.find((m) => m.pattern.test(model));
  if (fixed) return closestFixedSize(fixed.sizes, aspectRatio);
  return gptImage2SizeFromDisplay(aspectRatio, resolution);
}

export function gptImage2SizeFromDisplay(
  aspectRatio: string = "1:1",
  resolution: ImageResolution = "1K",
) {
  const { width: ratioW, height: ratioH } = parseAspectRatio(aspectRatio);
  const ratio = ratioW / ratioH;
  const targetPixels = GPT_IMAGE_2_TARGET_PIXELS[resolution] ?? GPT_IMAGE_2_TARGET_PIXELS["1K"];
  const rawWidth = Math.sqrt(targetPixels * ratio);
  const rawHeight = Math.sqrt(targetPixels / ratio);
  const { width, height } = clampGptImage2Size(rawWidth, rawHeight);
  return `${width}x${height}`;
}

export function displayFromImageSize(size?: string): {
  aspectRatio: ImageAspectRatio;
  resolution: ImageResolution;
} {
  const [rawW, rawH] = (size || "").split("x").map((n) => Number(n));
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) {
    return { aspectRatio: "1:1", resolution: "1K" };
  }

  const targetRatio = rawW / rawH;
  let aspectRatio = IMAGE_ASPECT_RATIOS[0];
  let bestRatioDiff = Infinity;
  for (const candidate of IMAGE_ASPECT_RATIOS) {
    const { width, height } = parseAspectRatio(candidate);
    const diff = Math.abs(width / height - targetRatio);
    if (diff < bestRatioDiff) {
      bestRatioDiff = diff;
      aspectRatio = candidate;
    }
  }

  const pixels = rawW * rawH;
  let resolution: ImageResolution = "1K";
  let bestPixelDiff = Infinity;
  for (const candidate of IMAGE_RESOLUTIONS) {
    const diff = Math.abs(GPT_IMAGE_2_TARGET_PIXELS[candidate] - pixels);
    if (diff < bestPixelDiff) {
      bestPixelDiff = diff;
      resolution = candidate;
    }
  }

  return { aspectRatio, resolution };
}

