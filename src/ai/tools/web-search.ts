// 网络搜索工具 —— search_web
// src/ai/tools/web-search.ts
//
// 隶属 web-search 技能。通过 Rust 后端代理请求 SearXNG（避开 WebView 跨域），
// 实例列表优先用用户在设置页配置的，留空则用后端内置的默认实例。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { webSearch, webRead } from "@/lib/electron-api";
import { useConfigStore } from "@/stores/config-store";
import { text, type ToolContext } from "./context";

// 把设置里以换行/逗号分隔的实例文本解析为数组
function parseInstances(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

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
    name: "search_web",
    label: "网络搜索",
    description:
      "在互联网上检索信息，返回若干条结果（标题、链接、摘要）。用于获取最新资讯、核实事实、查找线上资源。",
    parameters: searchWebParams,
    execute: async (_id, params: Static<typeof searchWebParams>) => {
      const instances = parseInstances(
        useConfigStore.getState().settings.searxngInstances,
      );

      const response = await webSearch({
        query: params.query,
        limit: params.limit,
        instances,
      });

      if (!response.success || response.results.length === 0) {
        return {
          content: text(
            `未检索到结果${response.error ? `（${response.error}）` : ""}。`,
          ),
          details: { query: params.query, error: response.error },
        };
      }

      // 拼成对模型友好的文本：序号 + 标题 + 链接 + 摘要
      const formatted = response.results
        .map(
          (item, index) =>
            `${index + 1}. ${item.title || "(无标题)"}\n${item.url}\n${item.snippet || ""}`.trim(),
        )
        .join("\n\n");

      return {
        content: text(formatted),
        details: {
          query: params.query,
          instance: response.instance,
          count: response.results.length,
          results: response.results,
        },
      };
    },
  };
}

const readWebParams = Type.Object({
  url: Type.String({ description: "要读取的网页链接（http/https）" }),
  maxChars: Type.Optional(
    Type.Number({
      description: "正文最大字符数，1000-30000，默认 12000",
      minimum: 1000,
      maximum: 30000,
    }),
  ),
});

export function readWebTool(_ctx: ToolContext): AgentTool<typeof readWebParams> {
  return {
    name: "read_web",
    label: "读取网页",
    description:
      "读取指定网页的正文内容（转为 Markdown）。在搜索拿到链接后，用它获取页面详情以便核实与引用。",
    parameters: readWebParams,
    execute: async (_id, params: Static<typeof readWebParams>) => {
      const response = await webRead({
        url: params.url,
        maxChars: params.maxChars,
      });

      if (!response.success || !response.markdown.trim()) {
        return {
          content: text(
            `无法读取网页${response.error ? `（${response.error}）` : ""}。`,
          ),
          details: { url: params.url, error: response.error },
        };
      }

      const header = response.title ? `# ${response.title}\n\n` : "";
      const tail = response.truncated
        ? `\n\n（正文较长已截断，共 ${response.totalChars} 字符）`
        : "";
      const fullText = `${header}${response.markdown}${tail}`;

      return {
        // content 即完整正文（含标题与截断尾注），供模型阅读，也作为步骤展开的结果文本
        content: text(fullText),
        details: {
          url: response.url,
          title: response.title,
          method: response.actualMethod,
          truncated: response.truncated,
          totalChars: response.totalChars,
          // 同步保留完整正文，供 UI 步骤展开兜底取用
          markdown: fullText,
        },
      };
    },
  };
}
