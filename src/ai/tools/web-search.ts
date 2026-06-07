// 网络搜索工具 —— 支持多个搜索服务商
// src/ai/tools/web-search.ts
//
// 根据用户在设置中配置的服务商（Tavily/Exa/Serper/SearXNG/Brave）路由搜索请求。
// 每个服务商有独立的配置（API Key、特定参数），由 Electron 主进程统一调用。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { webSearch, type WebSearchRequest } from "@/lib/electron/electron-api";
import { useConfigStore } from "@/stores/config-store";
import { text, type ToolContext } from "./tool-context";

const searchWebParams = Type.Object({
  query: Type.String({ description: "搜索关键词，尽量具体（可含时间、版本等）" }),
  limit: Type.Optional(
    Type.Number({ description: "返回结果条数，1-10，默认 5", minimum: 1, maximum: 10 }),
  ),
});

export function searchWebTool(
  _ctx: ToolContext,
): AgentTool<typeof searchWebParams> {
  return {
    name: "web_search",
    label: "网络搜索",
    description:
      "在互联网上检索信息，返回若干条结果（标题、链接、摘要）。用于获取最新资讯、核实事实、查找线上资源。",
    parameters: searchWebParams,
    execute: async (_id, params: Static<typeof searchWebParams>) => {
      const settings = useConfigStore.getState().settings;
      const webSearchConfig = settings.webSearch;

      if (!webSearchConfig) {
        return {
          content: text("网络搜索未配置。请前往设置 > 网络搜索配置服务商。"),
          details: { error: "未配置" },
        };
      }

      const provider = webSearchConfig.provider;
      const providerConfig = webSearchConfig[provider];

      // 构建请求参数
      const request: WebSearchRequest = {
        provider,
        query: params.query,
        limit: params.limit,
      };

      // 根据不同服务商添加配置参数
      switch (provider) {
        case "tavily": {
          const config = providerConfig as { apiKey: string; searchDepth?: "basic" | "advanced"; includeDomains?: string; excludeDomains?: string; includeAnswer?: boolean; includeRawContent?: boolean; includeImages?: boolean } | undefined;
          if (!config?.apiKey) {
            return {
              content: text("Tavily API Key 未配置。请前往设置 > 网络搜索配置。"),
              details: { error: "API Key 缺失" },
            };
          }
          request.apiKey = config.apiKey;
          request.searchDepth = config.searchDepth;
          request.includeDomains = config.includeDomains;
          request.excludeDomains = config.excludeDomains;
          request.includeAnswer = config.includeAnswer;
          request.includeRawContent = config.includeRawContent;
          request.includeImages = config.includeImages;
          break;
        }

        case "exa": {
          const config = providerConfig as { apiKey: string; type?: "neural" | "keyword"; useAutoprompt?: boolean; category?: string; includeText?: boolean; includeHighlights?: boolean; includeSummary?: boolean } | undefined;
          if (!config?.apiKey) {
            return {
              content: text("Exa API Key 未配置。请前往设置 > 网络搜索配置。"),
              details: { error: "API Key 缺失" },
            };
          }
          request.apiKey = config.apiKey;
          request.type = config.type;
          request.useAutoprompt = config.useAutoprompt;
          request.category = config.category;
          request.includeText = config.includeText;
          request.includeHighlights = config.includeHighlights;
          request.includeSummary = config.includeSummary;
          break;
        }

        case "serper": {
          const config = providerConfig as { apiKey: string; gl?: string; hl?: string } | undefined;
          if (!config?.apiKey) {
            return {
              content: text("Serper API Key 未配置。请前往设置 > 网络搜索配置。"),
              details: { error: "API Key 缺失" },
            };
          }
          request.apiKey = config.apiKey;
          request.gl = config.gl;
          request.hl = config.hl;
          break;
        }

        case "searxng": {
          // SearXNG 不需要 API Key
          const config = providerConfig as { instances: string } | undefined;
          request.instances = config?.instances;
          break;
        }

        case "brave": {
          const config = providerConfig as { apiKey: string; country?: string; searchLang?: string } | undefined;
          if (!config?.apiKey) {
            return {
              content: text("Brave Search API Key 未配置。请前往设置 > 网络搜索配置。"),
              details: { error: "API Key 缺失" },
            };
          }
          request.apiKey = config.apiKey;
          request.country = config.country;
          request.searchLang = config.searchLang;
          break;
        }
      }

      try {
        const response = await webSearch(request);

        if (!response.success || response.results.length === 0) {
          return {
            content: text("未检索到结果。"),
            details: { query: params.query, provider },
          };
        }

        // 搜索成功后，增加使用次数统计
        const settings = useConfigStore.getState().settings;
        const currentUsage = settings.webSearch?.usage ?? {};
        const newUsage = {
          ...currentUsage,
          [provider]: (currentUsage[provider] ?? 0) + 1,
        };

        // 异步更新统计，不阻塞工具返回
        useConfigStore.getState().updateSettings({
          webSearch: {
            ...settings.webSearch!,
            usage: newUsage,
          },
        }).catch((error) => {
          console.error("更新搜索次数统计失败:", error);
        });

        // 拼成对模型友好的文本：序号 + 标题 + 链接 + 摘要 + 完整内容（如果有）
        const formatResult = (item: any, index: number) => {
          let result = `${index + 1}. ${item.title || "(无标题)"}\n${item.url}\n${item.snippet || ""}`;

          // Tavily 完整内容
          if (item.rawContent) {
            result += `\n\n完整内容：\n${item.rawContent}`;
          }
          if (item.images && item.images.length > 0) {
            result += `\n\n图片：${item.images.join(", ")}`;
          }

          // Exa 完整内容
          if (item.text) {
            result += `\n\n完整文本：\n${item.text}`;
          }
          if (item.highlights && item.highlights.length > 0) {
            result += `\n\n高亮片段：\n${item.highlights.join("\n- ")}`;
          }
          if (item.summary) {
            result += `\n\nAI 摘要：${item.summary}`;
          }

          return result.trim();
        };

        let formatted = response.results.map((item, index) => formatResult(item, index)).join("\n\n");

        // 如果 Tavily 返回了 AI 答案，放在最前面
        if (response.answer) {
          formatted = `AI 答案：${response.answer}\n\n相关来源：\n\n${formatted}`;
        }

        return {
          content: text(formatted),
          details: {
            query: params.query,
            provider: response.provider,
            instance: response.instance,
            count: response.results.length,
            results: response.results,
            answer: response.answer,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: text(`搜索失败：${errorMessage}`),
          details: { query: params.query, provider, error: errorMessage },
        };
      }
    },
  };
}

