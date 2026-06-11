// 网络搜索设置 —— 服务商元数据
// 各服务商的显示名、免费额度描述与额度数值，供选择器与统计条复用。

import type { WebSearchProvider } from "@/types/config";

export const PROVIDER_META: Record<
  WebSearchProvider,
  { label: string; quota: string; description: string; freeLimit: number | null }
> = {
  tavily: {
    label: "Tavily",
    quota: "免费 1,000 次/月",
    description: "专为 AI 优化的搜索 API，提供高质量的结构化结果。",
    freeLimit: 1000,
  },
  exa: {
    label: "Exa",
    quota: "免费 1,000 次/月",
    description: "语义搜索引擎，使用神经网络理解搜索意图。",
    freeLimit: 1000,
  },
  serper: {
    label: "Serper",
    quota: "免费 2,500 次/月",
    description: "快速的 Google 搜索 API，支持多语言和地区。",
    freeLimit: 2500,
  },
  searxng: {
    label: "SearXNG",
    quota: "完全免费",
    description: "开源元搜索引擎，聚合多个搜索源，无需 API Key。",
    freeLimit: null,
  },
  brave: {
    label: "Brave Search",
    quota: "免费 2,000 次/月",
    description: "注重隐私的独立搜索引擎，无跟踪。",
    freeLimit: 2000,
  },
};
