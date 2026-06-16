// Skills 管理页面
// src/pages/SkillsPage.tsx

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/hooks/useToast";
import { useSkillsStore } from "@/stores/skills/skills-store";
import {
  MARKET_CATEGORIES,
  useSkillsMarketStore,
} from "@/stores/skills/skills-market-store";
import { SkillDetailModal } from "@/components/skill/SkillDetailModal";
import { PageHero } from "@/components/PageHero";
import { SkillInstallDialog } from "@/components/skill/SkillInstallDialog";
import type { SkillConfig } from "@/types/config";
import type { MarketSkill } from "@/lib/electron/electron-api";
import { cn } from "@/lib/utils";

type SkillTab = "market" | "builtin" | "custom" | "global";

export function SkillsPage() {
  const skills = useSkillsStore((state) => state.skills);
  const isLoading = useSkillsStore((state) => state.isLoading);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const toggleSkill = useSkillsStore((state) => state.toggleSkill);
  const uninstallSkill = useSkillsStore((state) => state.uninstallSkill);

  const [activeTab, setActiveTab] = useState<SkillTab>("market");
  const [search, setSearch] = useState("");
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillConfig | null>(null);
  const [deletingSkill, setDeletingSkill] = useState<SkillConfig | null>(null);
  const toast = useToast();

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const builtinSkills = useMemo(
    () => skills.filter((skill) => skill.type === "builtin"),
    [skills],
  );
  const customSkills = useMemo(
    () => skills.filter((skill) => skill.type === "custom"),
    [skills],
  );
  const globalSkills = useMemo(
    () => skills.filter((skill) => (skill.type as any) === "global"),
    [skills],
  );
  const visibleBuiltin = filterSkills(builtinSkills, search);
  const visibleCustom = filterSkills(customSkills, search);
  const visibleGlobal = filterSkills(globalSkills, search);

  // 已安装技能名集合（用于技能广场标记「已安装」）
  const installedNames = useMemo(
    () =>
      new Set(
        skills.map((skill) =>
          (skill.name || skill.id).toLowerCase().replace(/\s+/g, ""),
        ),
      ),
    [skills],
  );

  // 搜索框回车时，若在技能广场则触发云端搜索
  const searchMarket = useSkillsMarketStore((state) => state.searchByQuery);
  const refreshMarket = useSkillsMarketStore((state) => state.refreshAll);
  const handleSearchSubmit = () => {
    if (activeTab === "market" && search.trim().length >= 2) {
      void searchMarket(search.trim());
    }
  };

  // 刷新：技能广场页强制全量刷新云端，其余页重载本地技能
  const handleRefresh = () => {
    if (activeTab === "market") {
      void refreshMarket(true);
    } else {
      void loadSkills();
    }
  };

  // 删除技能
  const handleDeleteSkill = async () => {
    if (!deletingSkill) return;

    const success = await uninstallSkill(deletingSkill.id);
    if (success) {
      toast.success(`已删除技能：${deletingSkill.name || deletingSkill.id}`);
      setDeletingSkill(null);
    } else {
      toast.error(`删除技能失败：${deletingSkill.name || deletingSkill.id}`);
    }
  };

  return (
    <div className="app-scrollbar h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-6">
        <TopToolbar
          isLoading={isLoading}
          onInstall={() => setShowInstallDialog(true)}
          onRefresh={handleRefresh}
          onSearchSubmit={handleSearchSubmit}
          search={search}
          setSearch={setSearch}
        />

        <PageHero
          title="技能"
          bannerTitle="让助手学会更多本事"
          bannerDescription="装上合适的技能，写作、检索、整理这些事就能放心交给它。"
          icon={Zap}
          kitLabel="Skill Hub"
          rotate="left"
        />

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SkillTab)}>
          <TabsList className="mt-3 h-9 bg-transparent p-0">
            <TabTrigger value="market">广场</TabTrigger>
            <TabTrigger value="builtin">内置</TabTrigger>
            <TabTrigger value="custom">
              已安装
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {customSkills.length}
              </span>
            </TabTrigger>
            <TabTrigger value="global">
              全局
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {globalSkills.length}
              </span>
            </TabTrigger>
          </TabsList>
        </Tabs>

        {activeTab === "market" ? (
          <MarketView
            installedNames={installedNames}
            onInstalled={() => void loadSkills()}
          />
        ) : null}

        {activeTab === "builtin" ? (
          <>
            {visibleBuiltin.length > 0 ? (
              <section className="mt-5 rounded-xl border border-border bg-card">
                {visibleBuiltin.map((skill) => (
                  <InstalledSkillRow
                    key={skill.id}
                    skill={skill}
                    onEdit={() => setEditingSkill(skill)}
                    onToggle={() => toggleSkill(skill.id, !skill.enabled)}
                  />
                ))}
              </section>
            ) : (
              <EmptyCloudState
                title="没有找到内置技能"
                description="启动时会自动同步资源目录中的内置技能。"
                compact
              />
            )}
          </>
        ) : null}

        {activeTab === "custom" ? (
          <>
            {visibleCustom.length > 0 ? (
              <section className="mt-5 rounded-xl border border-border bg-card">
                {visibleCustom.map((skill) => (
                  <InstalledSkillRow
                    key={skill.id}
                    removable
                    skill={skill}
                    onEdit={() => setEditingSkill(skill)}
                    onDelete={() => setDeletingSkill(skill)}
                    onToggle={() => toggleSkill(skill.id, !skill.enabled)}
                  />
                ))}
              </section>
            ) : (
              <EmptyCloudState
                title="还没有安装自定义技能"
                description="点击「从 Git 安装」或「从本地安装」添加自定义技能。"
                compact
              />
            )}
          </>
        ) : null}

        {activeTab === "global" ? (
          <>
            {visibleGlobal.length > 0 ? (
              <section className="mt-5 rounded-xl border border-border bg-card">
                {visibleGlobal.map((skill) => (
                  <InstalledSkillRow
                    key={skill.id}
                    skill={skill}
                    onEdit={() => setEditingSkill(skill)}
                    onToggle={() => toggleSkill(skill.id, !skill.enabled)}
                  />
                ))}
              </section>
            ) : (
              <EmptyCloudState
                title="没有找到全局技能"
                description="使用 npx skills add 安装全局技能。"
                compact
              />
            )}
          </>
        ) : null}

        <SkillInstallDialog
          isOpen={showInstallDialog}
          onClose={() => setShowInstallDialog(false)}
          onInstallSuccess={() => void loadSkills()}
        />
        <SkillDetailModal
          isOpen={editingSkill !== null}
          skill={editingSkill}
          onClose={() => setEditingSkill(null)}
          onSaved={() => void loadSkills()}
        />
        <ConfirmDialog
          open={deletingSkill !== null}
          onOpenChange={(open) => !open && setDeletingSkill(null)}
          title="删除技能"
          message={`确定删除「${deletingSkill?.name || deletingSkill?.id}」吗？此操作不可撤销。`}
          confirmLabel="删除"
          variant="destructive"
          onConfirm={handleDeleteSkill}
        />
      </div>
    </div>
  );
}

// ===== 技能广场视图 =====

function MarketView({
  installedNames,
  onInstalled,
}: {
  installedNames: Set<string>;
  onInstalled: () => void;
}) {
  const byCategory = useSkillsMarketStore((state) => state.byCategory);
  const searchResults = useSkillsMarketStore((state) => state.searchResults);
  const isLoading = useSkillsMarketStore((state) => state.isLoading);
  const isRefreshing = useSkillsMarketStore((state) => state.isRefreshing);
  const error = useSkillsMarketStore((state) => state.error);
  const activeCategory = useSkillsMarketStore((state) => state.activeCategory);
  const installingIds = useSkillsMarketStore((state) => state.installingIds);
  const loadCategory = useSkillsMarketStore((state) => state.loadCategory);
  const installSkill = useSkillsMarketStore((state) => state.installSkill);
  const toast = useToast();

  // 首次进入：默认选中第一个分类（数据来自启动时的缓存/后台刷新）
  useEffect(() => {
    if (!activeCategory && searchResults === null) {
      void loadCategory(MARKET_CATEGORIES[0].id);
    }
    // 仅在挂载时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 当前展示的列表：自定义搜索优先，否则按分类取缓存
  const isSearching = searchResults !== null;
  const results = isSearching
    ? searchResults ?? []
    : byCategory[activeCategory] ?? [];

  const handleInstall = async (skill: MarketSkill) => {
    const ok = await installSkill(skill);
    if (ok) {
      toast.success(`已安装技能：${skill.name}`);
      onInstalled();
    } else {
      toast.error(`安装技能失败：${skill.name}`);
    }
  };

  const isInstalled = (skill: MarketSkill) =>
    installedNames.has((skill.name || skill.id).toLowerCase().replace(/\s+/g, ""));

  // 等待态：当前分类暂无缓存且正在加载/后台刷新
  const waiting = isLoading || (results.length === 0 && isRefreshing);

  return (
    <div className="mt-5">
      {/* 分类 chip */}
      <div className="flex flex-wrap gap-2">
        {MARKET_CATEGORIES.map((category) => (
          <button
            key={category.id}
            type="button"
            onClick={() => void loadCategory(category.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition-colors",
              !isSearching && activeCategory === category.id
                ? "border-transparent bg-[#f1eafb] text-[#5b3a9e]"
                : "border-border bg-card text-muted-foreground hover:border-[#9b6fe0]/30 hover:text-foreground",
            )}
          >
            <span>{category.icon}</span>
            {category.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      {error && results.length === 0 ? (
        <MarketError message={error} />
      ) : waiting ? (
        <SkillGrid>
          {Array.from({ length: 6 }).map((_, index) => (
            <SkillCardSkeleton key={index} />
          ))}
        </SkillGrid>
      ) : results.length > 0 ? (
        <SkillGrid>
          {results.map((skill) => (
            <MarketSkillCard
              key={skill.id}
              skill={skill}
              installed={isInstalled(skill)}
              installing={installingIds.includes(skill.id)}
              onInstall={() => void handleInstall(skill)}
            />
          ))}
        </SkillGrid>
      ) : (
        <EmptyCloudState
          title="没有匹配的技能"
          description="换个分类或在上方搜索框输入关键词试试。"
        />
      )}
    </div>
  );
}

function SkillGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

function MarketSkillCard({
  skill,
  installed,
  installing,
  onInstall,
}: {
  skill: MarketSkill;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4 transition-all hover:border-[#9b6fe0]/30 hover:shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{skill.name}</h3>
          {skill.source ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {skill.source}
            </p>
          ) : null}
        </div>
        {skill.repoUrl ? (
          <a
            href={skill.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="查看仓库"
          >
            <ExternalLink className="size-4" />
          </a>
        ) : null}
      </div>

      <p className="mt-3 line-clamp-2 min-h-[40px] text-sm leading-5 text-muted-foreground">
        {skill.description || "暂无描述"}
      </p>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {typeof skill.stars === "number" ? (
            <span className="flex items-center gap-1">
              <Star className="size-3.5" />
              {formatCount(skill.stars)}
            </span>
          ) : null}
          {typeof skill.installs === "number" ? (
            <span className="flex items-center gap-1">
              <Download className="size-3.5" />
              {formatCount(skill.installs)}
            </span>
          ) : null}
        </div>
        {installed ? (
          <Button variant="outline" size="sm" disabled>
            <Check className="size-4" />
            已安装
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={onInstall}
            disabled={installing}
          >
            {installing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            安装技能
          </Button>
        )}
      </div>
    </div>
  );
}

function SkillCardSkeleton() {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-muted" />
      <div className="mt-3 space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div className="h-3 w-16 animate-pulse rounded bg-muted" />
        <div className="h-8 w-16 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

function MarketError({ message }: { message: string }) {
  return (
    <div className="mt-5 flex flex-col items-center justify-center rounded-xl border border-dashed border-destructive/40 bg-destructive/5 px-6 py-12 text-center">
      <AlertCircle className="size-9 text-destructive" />
      <h3 className="mt-4 text-base font-semibold">加载技能广场失败</h3>
      <p className="mt-2 max-w-[460px] text-sm leading-6 text-muted-foreground">
        {message}
      </p>
      <p className="mt-3 text-xs text-muted-foreground">
        若频繁失败，可在「设置」中填写 SkillsMP API Key 以提升配额。
      </p>
    </div>
  );
}

function formatCount(value: number): string {
  if (value >= 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

// ===== 公共组件 =====

function TopToolbar({
  isLoading,
  onInstall,
  onRefresh,
  onSearchSubmit,
  search,
  setSearch,
}: {
  isLoading: boolean;
  onInstall: () => void;
  onRefresh: () => void;
  onSearchSubmit: () => void;
  search: string;
  setSearch: (value: string) => void;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
      <Button variant="ghost" size="icon" onClick={onRefresh} disabled={isLoading}>
        <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
      </Button>
      <div className="relative w-[300px] max-w-full">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSearchSubmit();
            }
          }}
          className="h-9 w-full rounded-full border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-ring"
          placeholder="搜索技能（回车搜索广场）"
        />
      </div>
      <Button onClick={onInstall}>
        <Plus className="size-4" />
        安装技能
      </Button>
    </div>
  );
}

function TabTrigger({
  children,
  value,
}: {
  children: React.ReactNode;
  value: SkillTab;
}) {
  return (
    <TabsTrigger
      value={value}
      className="mr-7 h-9 gap-2 rounded-none bg-transparent px-0 text-base font-semibold text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
    >
      {children}
    </TabsTrigger>
  );
}

function InstalledSkillRow({
  removable,
  skill,
  onEdit,
  onDelete,
  onToggle,
}: {
  removable?: boolean;
  skill: SkillConfig;
  onEdit: () => void;
  onDelete?: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="grid min-h-[84px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <h3 className="truncate text-base font-semibold">{skill.name || skill.id}</h3>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {skill.description}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="size-4" />
          编辑
        </Button>
        {removable && onDelete ? (
          <Button variant="outline" size="sm" onClick={onDelete}>
            <Trash2 className="size-4" />
            删除
          </Button>
        ) : null}
        <Switch checked={skill.enabled} onCheckedChange={onToggle} />
      </div>
    </div>
  );
}

function EmptyCloudState({
  compact,
  description,
  title,
}: {
  compact?: boolean;
  description: string;
  title: string;
}) {
  return (
    <div
      className={cn(
        "mt-5 flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 text-center",
        compact ? "min-h-[220px]" : "min-h-[320px]",
      )}
    >
      <FolderOpen className="size-9 text-muted-foreground" />
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-2 max-w-[420px] text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function filterSkills(skills: SkillConfig[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return skills;
  return skills.filter((skill) =>
    `${skill.name} ${skill.id} ${skill.description}`
      .toLowerCase()
      .includes(query),
  );
}
