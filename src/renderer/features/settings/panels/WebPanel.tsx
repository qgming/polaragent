import { CheckCircle2, ExternalLink, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";
import { Input } from "@/renderer/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/renderer/components/ui/select";
import { Skeleton } from "@/renderer/components/ui/skeleton";
import { Switch } from "@/renderer/components/ui/switch";
import { Textarea } from "@/renderer/components/ui/textarea";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import {
  DEFAULT_SEARXNG_INSTANCES,
  DEFAULT_WEB_SEARCH_SETTINGS,
  WEB_SEARCH_PROVIDER_META,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
  type WebSearchProviderConfig,
  type WebSearchSettings,
  type WebTestResult,
} from "@/shared/contracts/web";
import {
  PanelLoading,
  SettingsField,
  SettingsSection,
  secondaryButton,
  settingsInput,
  settingsTextarea,
} from "../settings-shared";

/**
 * 网络搜索设置面板。
 *
 * 两个刻意的设计：
 *   1. **provider 是必选单值**（没有「不选」状态）—— 与 settings.ts 的语义一致，
 *      免掉了「未选择时用什么」这个额外的判断分支；
 *   2. **API Key 不回显**：读到的 Key 只用于判断「有没有配」，
 *      输入框留空表示保留原值（与 ServicesPanel 的 Key 处理同款）。
 *      这既避免把密钥渲染到界面上，也避免用户以为「空 = 清空」。
 */
export function WebPanel() {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);

  /** 草稿：编辑中的 provider 配置（未保存）。保存前的改动只在这里 */
  const [draft, setDraft] = useState<WebSearchSettings | null>(null);
  /** API Key 输入框的内容：空串表示「不改动」 */
  const [keyInput, setKeyInput] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebTestResult | null>(null);

  // 设置加载完成（或从外部变化）时同步草稿
  useEffect(() => {
    if (settings === null) return;
    setDraft(settings.webSearch);
  }, [settings]);

  const provider: WebSearchProvider = draft?.provider ?? "searxng";
  const meta = WEB_SEARCH_PROVIDER_META[provider];

  /** 当前 provider 是否已配好（searxng 永远算配好） */
  const configured = useMemo(() => {
    if (draft === null) return false;
    if (!meta.needsKey) return true;
    return draft[provider].apiKey.trim() !== "" || keyInput.trim() !== "";
  }, [draft, meta.needsKey, provider, keyInput]);

  /** 把草稿（含 Key 输入框）落盘 */
  const persist = useCallback(
    async (next: WebSearchSettings, key: string): Promise<void> => {
      // Key 为空时保留原值：空串是「不改动」而不是「清空」
      const withKey: WebSearchSettings = {
        ...next,
        [next.provider]: {
          ...next[next.provider],
          ...(key.trim() === "" ? {} : { apiKey: key.trim() }),
        },
      };
      setDraft(withKey);
      setKeyInput("");
      await update({ webSearch: withKey });
    },
    [update],
  );

  const patchProvider = useCallback((patch: Partial<WebSearchProviderConfig>) => {
    setDraft((current) => {
      if (current === null) return current;
      return {
        ...current,
        [current.provider]: { ...current[current.provider], ...patch },
      };
    });
    // 换 provider 时清掉测试结果：上一条结论属于上一个服务
    setTestResult(null);
  }, []);

  /** 切换 provider：立即保存选择（它是个单选，没有「未保存」的中间态） */
  const pickProvider = useCallback(
    (next: WebSearchProvider) => {
      setDraft((current) => (current === null ? current : { ...current, provider: next }));
      setKeyInput("");
      setTestResult(null);
      if (draft !== null) void update({ webSearch: { ...draft, provider: next } });
    },
    [draft, update],
  );

  /**
   * 测试连接：用**草稿**配置（含尚未保存的 Key 输入）。
   *
   * 这是这个按钮存在的全部意义 —— 若只测已保存的配置，用户就得先存一个
   * 可能是错的 Key 才能验证它。
   */
  const runTest = useCallback(async () => {
    if (draft === null) return;
    setTesting(true);
    setTestResult(null);
    try {
      const config: WebSearchProviderConfig = {
        ...draft[provider],
        ...(keyInput.trim() === "" ? {} : { apiKey: keyInput.trim() }),
      };
      setTestResult(await window.oint.web.test({ provider, config }));
    } catch (error) {
      setTestResult({
        ok: false,
        code: "WEB_TEST_FAILED",
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  }, [draft, keyInput, provider]);

  if (settings === null || draft === null) return <PanelLoading />;

  const config = draft[provider];
  const keySaved = config.apiKey.trim() !== "";

  return (
    <div className="space-y-5">
      <SettingsSection title={t("settings.webSearchSection")}>
        <SettingsField
          label={t("settings.webEnabled")}
          description={t("settings.webEnabledDesc")}
          control={
            <Switch
              size="sm"
              checked={draft.enabled}
              onCheckedChange={(checked) => void persist({ ...draft, enabled: checked }, "")}
            />
          }
        />

        <SettingsField
          label={t("settings.webProvider")}
          description={meta.hint}
          control={
            <Select
              value={provider}
              onValueChange={(value) => pickProvider(value as WebSearchProvider)}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEB_SEARCH_PROVIDERS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {WEB_SEARCH_PROVIDER_META[id].label}
                    {WEB_SEARCH_PROVIDER_META[id].needsKey ? "" : ` · ${t("settings.webNoKey")}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        {provider === "searxng" ? (
          <SettingsField
            label={t("settings.webInstances")}
            description={t("settings.webInstancesHint")}
            control={null}
          />
        ) : (
          <SettingsField
            label={t("settings.webApiKey")}
            description={
              keySaved
                ? t("settings.webApiKeySaved")
                : meta.keyUrl === undefined
                  ? undefined
                  : t("settings.webApiKeyGet")
            }
            control={
              <div className="flex items-center gap-2">
                {meta.keyUrl === undefined ? null : (
                  <a
                    href={meta.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink-3 hover:text-ink-1"
                    aria-label={t("settings.webApiKeyGet")}
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
                <Input
                  type="password"
                  value={keyInput}
                  className={cn(settingsInput, "w-52")}
                  placeholder={keySaved ? "••••••••" : ""}
                  onChange={(event) => {
                    setKeyInput(event.target.value);
                    setTestResult(null);
                  }}
                  onBlur={() => {
                    // 失焦即保存：Key 是一个「填完就走」的字段，没有单独的保存按钮
                    if (keyInput.trim() !== "") void persist(draft, keyInput);
                  }}
                />
              </div>
            }
          />
        )}

        {provider === "searxng" ? (
          <Textarea
            value={config.instances ?? ""}
            className={settingsTextarea}
            rows={3}
            placeholder={DEFAULT_SEARXNG_INSTANCES.join("\n")}
            onChange={(event) => patchProvider({ instances: event.target.value })}
            onBlur={() => void persist(draft, "")}
          />
        ) : null}

        {provider === "searxng" ? (
          <p className="text-xs text-ink-3">
            {t("settings.webInstancesBuiltin", { count: DEFAULT_SEARXNG_INSTANCES.length })}
          </p>
        ) : null}

        {provider === "tavily" ? (
          <>
            <SettingsField
              label={t("settings.webTavilyDepth")}
              control={
                <Select
                  value={config.searchDepth ?? "basic"}
                  onValueChange={(value) => {
                    patchProvider({ searchDepth: value as "basic" | "advanced" });
                    void persist(
                      {
                        ...draft,
                        tavily: { ...config, searchDepth: value as "basic" | "advanced" },
                      },
                      "",
                    );
                  }}
                >
                  <SelectTrigger size="sm" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="basic">basic</SelectItem>
                    <SelectItem value="advanced">advanced</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <SettingsField
              label={t("settings.webTavilyAnswer")}
              description={t("settings.webTavilyAnswerDesc")}
              control={
                <Switch
                  size="sm"
                  checked={config.includeAnswer === true}
                  onCheckedChange={(checked) => {
                    patchProvider({ includeAnswer: checked });
                    void persist({ ...draft, tavily: { ...config, includeAnswer: checked } }, "");
                  }}
                />
              }
            />
          </>
        ) : null}

        {provider === "serper" ? (
          <div className="flex items-center gap-3">
            <Input
              value={config.gl ?? ""}
              className={cn(settingsInput, "w-24")}
              placeholder="cn"
              aria-label={t("settings.webSerperGl")}
              onChange={(event) => patchProvider({ gl: event.target.value })}
              onBlur={() => void persist(draft, "")}
            />
            <Input
              value={config.hl ?? ""}
              className={cn(settingsInput, "w-28")}
              placeholder="zh-cn"
              aria-label={t("settings.webSerperHl")}
              onChange={(event) => patchProvider({ hl: event.target.value })}
              onBlur={() => void persist(draft, "")}
            />
          </div>
        ) : null}

        {provider === "exa" ? (
          <SettingsField
            label={t("settings.webExaType")}
            control={
              <Select
                value={config.type ?? "neural"}
                onValueChange={(value) => {
                  patchProvider({ type: value as "neural" | "keyword" });
                  void persist(
                    { ...draft, exa: { ...config, type: value as "neural" | "keyword" } },
                    "",
                  );
                }}
              >
                <SelectTrigger size="sm" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="neural">neural</SelectItem>
                  <SelectItem value="keyword">keyword</SelectItem>
                </SelectContent>
              </Select>
            }
          />
        ) : null}

        {provider === "brave" ? (
          <div className="flex items-center gap-3">
            <Input
              value={config.country ?? ""}
              className={cn(settingsInput, "w-24")}
              placeholder="CN"
              aria-label={t("settings.webBraveCountry")}
              onChange={(event) => patchProvider({ country: event.target.value })}
              onBlur={() => void persist(draft, "")}
            />
            <Input
              value={config.searchLang ?? ""}
              className={cn(settingsInput, "w-24")}
              placeholder="zh"
              aria-label={t("settings.webBraveLang")}
              onChange={(event) => patchProvider({ searchLang: event.target.value })}
              onBlur={() => void persist(draft, "")}
            />
          </div>
        ) : null}

        <div className="flex items-center gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryButton}
            disabled={testing || !configured}
            onClick={() => void runTest()}
          >
            {testing ? t("settings.webTesting") : t("settings.webTest")}
          </Button>
          {testResult === null ? null : testResult.ok ? (
            <span className="flex items-center gap-1.5 text-xs text-ink-2">
              <CheckCircle2 className="size-3.5 text-emerald-600" aria-hidden="true" />
              {t("settings.webTestOk", { count: testResult.count })}
              {testResult.sample === undefined ? "" : ` · ${testResult.sample}`}
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-destructive">
              <XCircle className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="line-clamp-2">{testResult.reason}</span>
            </span>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("settings.webLimitsSection")}
        description={t("settings.webLimitsDesc")}
      >
        <SettingsField
          label={t("settings.webMaxResults")}
          description={t("settings.webMaxResultsDesc")}
          control={
            <Input
              type="number"
              min={1}
              max={20}
              value={draft.maxResults}
              className={cn(settingsInput, "w-24")}
              onChange={(event) => setDraft({ ...draft, maxResults: Number(event.target.value) })}
              onBlur={() => void persist(draft, "")}
            />
          }
        />
        <SettingsField
          label={t("settings.webFetchChars")}
          description={t("settings.webFetchCharsDesc")}
          control={
            <Input
              type="number"
              min={1000}
              max={1_000_000}
              step={1000}
              value={draft.fetchMaxOutputChars}
              className={cn(settingsInput, "w-28")}
              onChange={(event) =>
                setDraft({ ...draft, fetchMaxOutputChars: Number(event.target.value) })
              }
              onBlur={() => void persist(draft, "")}
            />
          }
        />
        <SettingsField
          label={t("settings.webFetchTimeout")}
          description={t("settings.webFetchTimeoutDesc")}
          control={
            <Input
              type="number"
              min={1}
              max={120}
              value={Math.round(draft.fetchTimeoutMs / 1000)}
              className={cn(settingsInput, "w-24")}
              onChange={(event) =>
                setDraft({ ...draft, fetchTimeoutMs: Number(event.target.value) * 1000 })
              }
              onBlur={() => void persist(draft, "")}
            />
          }
        />
      </SettingsSection>

      <p className="text-xs text-ink-3">{t("settings.webFooter")}</p>
    </div>
  );
}

/** 供测试与调用方复用的初始值（与 store 的默认值同源） */
export const WEB_PANEL_DEFAULTS = DEFAULT_WEB_SEARCH_SETTINGS;

/** 加载态：与其它面板一致用 Skeleton 而不是 spinner */
export function WebPanelLoading() {
  return <Skeleton className="h-32 w-full" />;
}
