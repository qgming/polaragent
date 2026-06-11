// 图片模式设置 —— 常量与默认值
// 接口标准元数据与兜底默认配置。比例/分辨率不再在设置中预设，统一由 AI 调用时填写。

import type { ImageApiStandard, ImageGenerationConfig } from "@/types/config";
import { defaultSettings } from "@/config/defaults";

// 三种接口标准的展示信息
// hint 为卡片副标题：不点名具体模型，强调最新模式、AI 自适应参数与编辑能力。
export const STANDARDS: Array<{
  id: ImageApiStandard;
  label: string;
  hint: string;
}> = [
  {
    id: "openai-images",
    label: "OpenAI 图片接口",
    hint: "兼容主流图像生成模型，AI 自动选择比例与分辨率，支持图片编辑。",
  },
  {
    id: "openai-chat",
    label: "OpenAI Chat",
    hint: "多模态对话出图，AI 自动适配生成参数，不支持图片编辑。",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    hint: "支持最新 Gemini 图像模式，AI 自动选择比例与分辨率，支持图片编辑。",
  },
];

export function imageGenerationDefaults(): ImageGenerationConfig {
  return defaultSettings.imageGeneration!;
}
