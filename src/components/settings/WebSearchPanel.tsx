// 网络搜索设置面板（服务商选择 + 各服务商配置）
// src/components/settings/WebSearchPanel.tsx

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, Loader2, Save, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Settings, WebSearchProvider } from "@/types/config";
import { PageTitle, SettingDropdown } from "./settings-shared";
import { openExternal } from "@/lib/electron/electron-api";

// 服务商元数据：显示名、免费额度描述、免费额度数值
const PROVIDER_META: Record<
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

// Tavily 配置卡片
function TavilyConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const config = settings.webSearch?.tavily ?? { apiKey: "" };
  const [apiKey, setApiKey] = useState(config.apiKey ?? "");
  const [searchDepth, setSearchDepth] = useState<"basic" | "advanced">(
    config.searchDepth ?? "basic",
  );
  const [includeDomains, setIncludeDomains] = useState(
    config.includeDomains ?? "",
  );
  const [excludeDomains, setExcludeDomains] = useState(
    config.excludeDomains ?? "",
  );
  const [includeAnswer, setIncludeAnswer] = useState(
    config.includeAnswer ?? false,
  );
  const [includeRawContent, setIncludeRawContent] = useState(
    config.includeRawContent ?? false,
  );
  const [includeImages, setIncludeImages] = useState(
    config.includeImages ?? false,
  );
  const [show, setShow] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );

  useEffect(() => {
    const config = settings.webSearch?.tavily ?? { apiKey: "" };
    setApiKey(config.apiKey ?? "");
    setSearchDepth(config.searchDepth ?? "basic");
    setIncludeDomains(config.includeDomains ?? "");
    setExcludeDomains(config.excludeDomains ?? "");
    setIncludeAnswer(config.includeAnswer ?? false);
    setIncludeRawContent(config.includeRawContent ?? false);
    setIncludeImages(config.includeImages ?? false);
  }, [settings.webSearch?.tavily]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        tavily: {
          apiKey: apiKey.trim(),
          searchDepth,
          includeDomains: includeDomains.trim(),
          excludeDomains: excludeDomains.trim(),
          includeAnswer,
          includeRawContent,
          includeImages,
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Tavily 配置</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          访问{" "}
          <button
            type="button"
            onClick={() => void openExternal("https://tavily.com")}
            className="text-primary hover:underline cursor-pointer"
          >
            tavily.com
          </button>{" "}
          注册并获取 API Key。免费账户每月 1,000 次搜索。
        </p>

        <div className="mt-4 space-y-4">
          {/* API Key */}
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              API Key
            </label>
            <div className="relative flex items-center gap-2">
              <input
                type={show ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="tvly-..."
                className="h-10 flex-1 rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-14 text-muted-foreground hover:text-foreground"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          {/* Search Depth */}
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              搜索深度
            </label>
            <SettingDropdown
              value={searchDepth}
              onChange={(v) => setSearchDepth(v as "basic" | "advanced")}
              options={[
                { value: "basic", label: "基础（更快）" },
                { value: "advanced", label: "深度（更全面）" },
              ]}
              className="w-full"
            />
          </div>

          {/* Include Domains */}
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              限定域名（可选）
            </label>
            <input
              type="text"
              value={includeDomains}
              onChange={(e) => setIncludeDomains(e.target.value)}
              placeholder="example.com, docs.example.com"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              仅搜索这些域名，多个用逗号分隔。
            </p>
          </div>

          {/* Exclude Domains */}
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              排除域名（可选）
            </label>
            <input
              type="text"
              value={excludeDomains}
              onChange={(e) => setExcludeDomains(e.target.value)}
              placeholder="spam.com, ads.com"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              排除这些域名，多个用逗号分隔。
            </p>
          </div>

          {/* 完整内容选项 */}
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <h4 className="mb-3 text-xs font-semibold text-foreground">
              完整内容选项（增强搜索结果）
            </h4>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeAnswer}
                  onChange={(e) => setIncludeAnswer(e.target.checked)}
                  className="size-4"
                />
                <span>包含 AI 生成的答案</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeRawContent}
                  onChange={(e) => setIncludeRawContent(e.target.checked)}
                  className="size-4"
                />
                <span>包含原始网页内容</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeImages}
                  onChange={(e) => setIncludeImages(e.target.checked)}
                  className="size-4"
                />
                <span>包含图片链接</span>
              </label>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              注意：启用这些选项会返回更多内容，但会消耗更多 token。
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={() => void handleSave()} disabled={saveState === "saving"}>
              {saveState === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : saveState === "saved" ? (
                <Check className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              保存配置
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Exa 配置卡片
function ExaConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const config = settings.webSearch?.exa ?? { apiKey: "" };
  const [apiKey, setApiKey] = useState(config.apiKey ?? "");
  const [type, setType] = useState<"neural" | "keyword">(config.type ?? "neural");
  const [useAutoprompt, setUseAutoprompt] = useState(config.useAutoprompt ?? false);
  const [category, setCategory] = useState(config.category ?? "");
  const [includeText, setIncludeText] = useState(config.includeText ?? false);
  const [includeHighlights, setIncludeHighlights] = useState(
    config.includeHighlights ?? false,
  );
  const [includeSummary, setIncludeSummary] = useState(
    config.includeSummary ?? false,
  );
  const [show, setShow] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    const config = settings.webSearch?.exa ?? { apiKey: "" };
    setApiKey(config.apiKey ?? "");
    setType(config.type ?? "neural");
    setUseAutoprompt(config.useAutoprompt ?? false);
    setCategory(config.category ?? "");
    setIncludeText(config.includeText ?? false);
    setIncludeHighlights(config.includeHighlights ?? false);
    setIncludeSummary(config.includeSummary ?? false);
  }, [settings.webSearch?.exa]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        exa: {
          apiKey: apiKey.trim(),
          type,
          useAutoprompt,
          category: category.trim(),
          includeText,
          includeHighlights,
          includeSummary,
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Exa 配置</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          访问{" "}
          <button
            type="button"
            onClick={() => void openExternal("https://exa.ai")}
            className="text-primary hover:underline cursor-pointer"
          >
            exa.ai
          </button>{" "}
          注册并获取 API Key。免费账户每月 1,000 次搜索。
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              API Key
            </label>
            <div className="relative flex items-center gap-2">
              <input
                type={show ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="exa_..."
                className="h-10 flex-1 rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-14 text-muted-foreground hover:text-foreground"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              搜索类型
            </label>
            <SettingDropdown
              value={type}
              onChange={(v) => setType(v as "neural" | "keyword")}
              options={[
                { value: "neural", label: "神经网络（语义理解）" },
                { value: "keyword", label: "关键词匹配" },
              ]}
              className="w-full"
            />
          </div>

          <div>
            <label className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <input
                type="checkbox"
                checked={useAutoprompt}
                onChange={(e) => setUseAutoprompt(e.target.checked)}
                className="size-4"
              />
              使用 Autoprompt（AI 自动优化查询）
            </label>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              分类过滤（可选）
            </label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="news, research, company"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>

          {/* 完整内容选项 */}
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <h4 className="mb-3 text-xs font-semibold text-foreground">
              完整内容选项（增强搜索结果）
            </h4>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeText}
                  onChange={(e) => setIncludeText(e.target.checked)}
                  className="size-4"
                />
                <span>包含完整文本内容</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeHighlights}
                  onChange={(e) => setIncludeHighlights(e.target.checked)}
                  className="size-4"
                />
                <span>包含高亮摘要</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={includeSummary}
                  onChange={(e) => setIncludeSummary(e.target.checked)}
                  className="size-4"
                />
                <span>包含 AI 生成的摘要</span>
              </label>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              注意：启用这些选项会返回更多内容，但会消耗更多 token。
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={() => void handleSave()} disabled={saveState === "saving"}>
              {saveState === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : saveState === "saved" ? (
                <Check className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              保存配置
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Serper 配置卡片
function SerperConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const config = settings.webSearch?.serper ?? { apiKey: "" };
  const [apiKey, setApiKey] = useState(config.apiKey ?? "");
  const [gl, setGl] = useState(config.gl ?? "cn");
  const [hl, setHl] = useState(config.hl ?? "zh-cn");
  const [show, setShow] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    const config = settings.webSearch?.serper ?? { apiKey: "" };
    setApiKey(config.apiKey ?? "");
    setGl(config.gl ?? "cn");
    setHl(config.hl ?? "zh-cn");
  }, [settings.webSearch?.serper]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        serper: {
          apiKey: apiKey.trim(),
          gl: gl.trim(),
          hl: hl.trim(),
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Serper 配置</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          访问{" "}
          <button
            type="button"
            onClick={() => void openExternal("https://serper.dev")}
            className="text-primary hover:underline cursor-pointer"
          >
            serper.dev
          </button>{" "}
          注册并获取 API Key。免费账户每月 2,500 次搜索。
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              API Key
            </label>
            <div className="relative flex items-center gap-2">
              <input
                type={show ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="..."
                className="h-10 flex-1 rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-14 text-muted-foreground hover:text-foreground"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              国家代码（gl）
            </label>
            <input
              type="text"
              value={gl}
              onChange={(e) => setGl(e.target.value)}
              placeholder="cn"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              如 cn（中国）、us（美国）、jp（日本）
            </p>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              语言代码（hl）
            </label>
            <input
              type="text"
              value={hl}
              onChange={(e) => setHl(e.target.value)}
              placeholder="zh-cn"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              如 zh-cn（简体中文）、en（英语）、ja（日语）
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={() => void handleSave()} disabled={saveState === "saving"}>
              {saveState === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : saveState === "saved" ? (
                <Check className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              保存配置
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// SearXNG 配置卡片
function SearxngConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const config = settings.webSearch?.searxng ?? { instances: "" };
  const [instances, setInstances] = useState(config.instances ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    const config = settings.webSearch?.searxng ?? { instances: "" };
    setInstances(config.instances ?? "");
  }, [settings.webSearch?.searxng]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        searxng: {
          instances: instances.trim(),
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">SearXNG 配置</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          SearXNG 是开源元搜索引擎，无需 API
          Key。可使用公共实例或自建服务。留空则使用内置默认实例。
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              实例地址
            </label>
            <textarea
              value={instances}
              onChange={(e) => setInstances(e.target.value)}
              placeholder="https://searx.example.com&#10;https://search.example.org"
              rows={4}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              每行一个实例 URL，或用逗号分隔。留空使用默认实例。
            </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground">
              💡 推荐公共实例：
              <button
                type="button"
                onClick={() => void openExternal("https://searx.be")}
                className="ml-1 text-primary hover:underline cursor-pointer"
              >
                searx.be
              </button>
              、
              <button
                type="button"
                onClick={() => void openExternal("https://searx.work")}
                className="text-primary hover:underline cursor-pointer"
              >
                searx.work
              </button>
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={() => void handleSave()} disabled={saveState === "saving"}>
              {saveState === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : saveState === "saved" ? (
                <Check className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              保存配置
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Brave 配置卡片
function BraveConfigCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const config = settings.webSearch?.brave ?? { apiKey: "" };
  const [apiKey, setApiKey] = useState(config.apiKey ?? "");
  const [country, setCountry] = useState(config.country ?? "");
  const [searchLang, setSearchLang] = useState(config.searchLang ?? "");
  const [show, setShow] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    const config = settings.webSearch?.brave ?? { apiKey: "" };
    setApiKey(config.apiKey ?? "");
    setCountry(config.country ?? "");
    setSearchLang(config.searchLang ?? "");
  }, [settings.webSearch?.brave]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({
      webSearch: {
        ...settings.webSearch!,
        brave: {
          apiKey: apiKey.trim(),
          country: country.trim(),
          searchLang: searchLang.trim(),
        },
      },
    });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Brave Search 配置</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          访问{" "}
          <button
            type="button"
            onClick={() => void openExternal("https://brave.com/search/api/")}
            className="text-primary hover:underline cursor-pointer"
          >
            Brave Search API
          </button>{" "}
          注册并获取 API Key。免费账户每月 2,000 次搜索。
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              API Key
            </label>
            <div className="relative flex items-center gap-2">
              <input
                type={show ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="BSA..."
                className="h-10 flex-1 rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-14 text-muted-foreground hover:text-foreground"
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              国家代码（可选）
            </label>
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="cn"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              如 cn（中国）、us（美国）
            </p>
          </div>

          <div>
            <label className="mb-2 block text-xs font-medium text-muted-foreground">
              搜索语言（可选）
            </label>
            <input
              type="text"
              value={searchLang}
              onChange={(e) => setSearchLang(e.target.value)}
              placeholder="zh"
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              如 zh（中文）、en（英语）
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={() => void handleSave()} disabled={saveState === "saving"}>
              {saveState === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : saveState === "saved" ? (
                <Check className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              保存配置
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
