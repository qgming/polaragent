// Skills 管理页面
// src/pages/SkillsPage.tsx

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/hooks/useToast";
import { useSkillsStore } from "@/stores/skills/skills-store";
import { SkillDetailModal } from "@/components/skill/SkillDetailModal";
import { PageHero } from "@/components/PageHero";
import { SkillInstallDialog } from "@/components/skill/SkillInstallDialog";
import { SkillProviderDiscovery } from "@/components/skill/SkillProviderDiscovery";
import type { SkillConfig } from "@/types/config";
import { ensureDataDir, openExternal } from "@/lib/electron/electron-api";
import { cn } from "@/lib/utils";

type SkillTab = "discover" | "builtin" | "custom" | "global";

export function SkillsPage() {
  const { t } = useTranslation("skills");
  const skills = useSkillsStore((state) => state.skills);
  const isLoading = useSkillsStore((state) => state.isLoading);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const toggleSkill = useSkillsStore((state) => state.toggleSkill);
  const setSkillsEnabled = useSkillsStore((state) => state.setSkillsEnabled);
  const uninstallSkill = useSkillsStore((state) => state.uninstallSkill);

  const [activeTab, setActiveTab] = useState<SkillTab>("discover");
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
    () => skills.filter((skill) => skill.type === "global"),
    [skills],
  );
  const visibleBuiltin = filterSkills(builtinSkills, search);
  const visibleCustom = filterSkills(customSkills, search);
  const visibleGlobal = filterSkills(globalSkills, search);
  const allGlobalEnabled = globalSkills.length > 0 && globalSkills.every((skill) => skill.enabled);
  const enabledGlobalCount = globalSkills.filter((skill) => skill.enabled).length;

  const handleRefresh = () => {
    void ensureDataDir().then(() => loadSkills());
  };

  const handleOpenUrl = async (url: string) => {
    try {
      await openExternal(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("discover.openFailed"));
    }
  };

  // 删除技能
  const handleDeleteSkill = async () => {
    if (!deletingSkill) return;

    const success = await uninstallSkill(deletingSkill.id);
    if (success) {
      toast.success(t("delete.success", { name: deletingSkill.name || deletingSkill.id }));
      setDeletingSkill(null);
    } else {
      toast.error(t("delete.failed", { name: deletingSkill.name || deletingSkill.id }));
    }
  };

  return (
    <div className="app-scrollbar h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-6">
        <TopToolbar
          showSearch={activeTab !== "discover"}
          isLoading={isLoading}
          onInstall={() => setShowInstallDialog(true)}
          onRefresh={handleRefresh}
          search={search}
          setSearch={setSearch}
        />

        <PageHero
          title={t("page.title")}
          bannerTitle={t("page.bannerTitle")}
          bannerDescription={t("page.bannerDescription")}
          icon={Zap}
          kitLabel={t("page.kitLabel")}
          rotate="left"
        />

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SkillTab)}>
          <TabsList className="mt-3 h-9 bg-transparent p-0">
            <TabTrigger value="discover">{t("tabs.discover")}</TabTrigger>
            <TabTrigger value="builtin">{t("tabs.builtin")}</TabTrigger>
            <TabTrigger value="custom">
              {t("tabs.installed")}
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {customSkills.length}
              </span>
            </TabTrigger>
            <TabTrigger value="global">
              {t("tabs.global")}
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {globalSkills.length}
              </span>
            </TabTrigger>
          </TabsList>
        </Tabs>

        {activeTab === "discover" ? (
          <SkillProviderDiscovery onOpenUrl={(url) => void handleOpenUrl(url)} />
        ) : null}

        {activeTab === "builtin" ? (
          <>
            {visibleBuiltin.length > 0 ? (
              <section className="mt-3 rounded-xl border border-border bg-card">
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
                title={t("empty.builtinTitle")}
                description={t("empty.builtinDesc")}
                compact
              />
            )}
          </>
        ) : null}

        {activeTab === "custom" ? (
          <>
            {visibleCustom.length > 0 ? (
              <section className="mt-3 rounded-xl border border-border bg-card">
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
                title={t("empty.customTitle")}
                description={t("empty.customDesc")}
                compact
              />
            )}
          </>
        ) : null}

        {activeTab === "global" ? (
          <>
            {visibleGlobal.length > 0 ? (
              <section className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
                  <div>
                    <h3 className="text-sm font-semibold">{t("globalControls.title")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("globalControls.summary", {
                        enabled: enabledGlobalCount,
                        total: globalSkills.length,
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {allGlobalEnabled
                        ? t("globalControls.enabled")
                        : t("globalControls.disabled")}
                    </span>
                    <Switch
                      checked={allGlobalEnabled}
                      onCheckedChange={(checked) =>
                        setSkillsEnabled(
                          globalSkills.map((skill) => skill.id),
                          checked,
                        )
                      }
                    />
                  </div>
                </div>
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
                title={t("empty.globalTitle")}
                description={t("empty.globalDesc")}
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
          title={t("delete.title")}
          message={t("delete.message", { name: deletingSkill?.name || deletingSkill?.id || "" })}
          confirmLabel={t("common:delete")}
          variant="destructive"
          onConfirm={handleDeleteSkill}
        />
      </div>
    </div>
  );
}

// ===== 公共组件 =====

function TopToolbar({
  showSearch,
  isLoading,
  onInstall,
  onRefresh,
  search,
  setSearch,
}: {
  showSearch: boolean;
  isLoading: boolean;
  onInstall: () => void;
  onRefresh: () => void;
  search: string;
  setSearch: (value: string) => void;
}) {
  const { t } = useTranslation("skills");
  return (
    <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
      {showSearch ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={isLoading}
            title={t("page.refresh")}
          >
            <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
          </Button>
          <div className="relative w-[300px] max-w-full">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 w-full rounded-full border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              placeholder={t("page.searchPlaceholder")}
            />
          </div>
        </>
      ) : null}
      <Button onClick={onInstall}>
        <Plus className="size-4" />
        {t("page.install")}
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
  const { t } = useTranslation("skills");
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
          {t("list.edit")}
        </Button>
        {removable && onDelete ? (
          <Button variant="outline" size="sm" onClick={onDelete}>
            <Trash2 className="size-4" />
            {t("list.delete")}
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
        "mt-3 flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 text-center",
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
