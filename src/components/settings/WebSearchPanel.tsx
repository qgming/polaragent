// 网络搜索设置面板（容器）
// 服务商选择 + 搜索次数统计 + 分发到各服务商配置卡。
// 各服务商配置卡拆分在 ./web-search 子目录。

import type { Settings, WebSearchProvider } from "@/types/config";
import { PageTitle, SettingDropdown } from "./settings-shared";
import { PROVIDER_META } from "./web-search/web-search-meta";
import { TavilyConfigCard } from "./web-search/TavilyConfigCard";
import { ExaConfigCard } from "./web-search/ExaConfigCard";
import { SerperConfigCard } from "./web-search/SerperConfigCard";
import { SearxngConfigCard } from "./web-search/SearxngConfigCard";
import { BraveConfigCard } from "./web-search/BraveConfigCard";

export function WebSearchPanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const webSearch = settings.webSearch ?? {
    provider: "tavily",
    tavily: { apiKey: "" },
    exa: { apiKey: "" },
    serper: { apiKey: "" },
    searxng: { instances: "" },
    brave: { apiKey: "" },
  };

  const setProvider = (provider: WebSearchProvider) =>
    onUpdate({
      webSearch: {
        ...webSearch,
        provider,
      },
    });

  return (
    <section>
      <PageTitle
        title="网络搜索"
        description="配置 AI 使用的网络搜索服务，获取实时信息。"
      />

      <div className="mt-8 rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-4 px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">搜索服务商</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              选择一个服务商，AI 将使用它进行网络搜索。
            </p>
          </div>
          <div className="shrink-0">
            <SettingDropdown
              value={webSearch.provider}
              onChange={(value) => setProvider(value as WebSearchProvider)}
              options={Object.entries(PROVIDER_META).map(([value, meta]) => ({
                value,
                label: meta.label,
              }))}
            />
          </div>
        </div>
      </div>

      {/* 搜索次数统计 */}
      <div className="mt-6 flex items-stretch divide-x divide-border rounded-xl border border-border bg-card overflow-hidden text-xs">
        {Object.entries(PROVIDER_META).map(([key, meta]) => {
          const count = webSearch.usage?.[key as WebSearchProvider] ?? 0;
          return (
            <div
              key={key}
              className="flex flex-1 flex-col items-center justify-center py-2.5"
            >
              <span className="text-muted-foreground">{meta.label}</span>
              <span className="mt-0.5 font-semibold tabular-nums">{count}</span>
            </div>
          );
        })}
      </div>

      {/* 当前服务商的配置表单 */}
      <div className="mt-6">
        {webSearch.provider === "tavily" && (
          <TavilyConfigCard settings={settings} onUpdate={onUpdate} />
        )}
        {webSearch.provider === "exa" && (
          <ExaConfigCard settings={settings} onUpdate={onUpdate} />
        )}
        {webSearch.provider === "serper" && (
          <SerperConfigCard settings={settings} onUpdate={onUpdate} />
        )}
        {webSearch.provider === "searxng" && (
          <SearxngConfigCard settings={settings} onUpdate={onUpdate} />
        )}
        {webSearch.provider === "brave" && (
          <BraveConfigCard settings={settings} onUpdate={onUpdate} />
        )}
      </div>
    </section>
  );
}
