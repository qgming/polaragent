// 团队编辑模态窗：编辑团队的头像/名称/简介/协作模式/成员/领导/系统提示词/团队技能/工作区目录
// 仿 AgentEditorModal，基于通用 Modal 组件居中弹出

import { Bot, FolderOpen, Sparkles, Star, Users, Wrench, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Field, SettingDropdown } from "@/components/settings/settings-shared";
import { Button } from "@/components/ui/button";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { Switch } from "@/components/ui/switch";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalTitle,
} from "@/components/ui/modal";
import { pickWorkingDirectory } from "@/lib/electron/electron-api";
import { useConfigStore } from "@/stores/config-store";
import { useSkillsStore } from "@/stores/skills/skills-store";
import type { TeamConfig } from "@/types/config";

type TeamMode = TeamConfig["mode"];

export function TeamEditorModal({
  team,
  onClose,
  onSave,
}: {
  team: TeamConfig;
  onClose: () => void;
  onSave: (team: TeamConfig) => void;
}) {
  const { t } = useTranslation("team");
  const [name, setName] = useState(team.name);
  const [avatar, setAvatar] = useState(team.avatar || "👥");
  const [description, setDescription] = useState(team.description);
  const [mode, setMode] = useState<TeamMode>(team.mode);
  const [memberIds, setMemberIds] = useState<string[]>(team.memberIds);
  const [leaderId, setLeaderId] = useState(team.leaderId);
  const [systemPrompt, setSystemPrompt] = useState(team.systemPrompt);
  const [enabledSkills, setEnabledSkills] = useState<string[]>(
    team.enabledSkills,
  );
  const [workspaceDir, setWorkspaceDir] = useState(team.workspaceDir ?? "");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 可选成员 = 全部助手（内置+已安装）；技能 = 全部技能
  const agents = useConfigStore((state) => state.agents);
  const skills = useSkillsStore((state) => state.skills);

  const modeOptions = useMemo(
    () => [
      { value: "leader", label: t("editor.mode.leaderOption") },
      { value: "equal", label: t("editor.mode.equalOption") },
    ],
    [t],
  );

  // 已选成员的领导下拉选项
  const leaderOptions = useMemo(
    () =>
      agents
        .filter((agent) => memberIds.includes(agent.id))
        .map((agent) => ({
          value: agent.id,
          label: `${agent.avatar || "⚡"} ${agent.name}`,
        })),
    [agents, memberIds],
  );

  const toggleMember = (agentId: string) => {
    setMemberIds((current) => {
      const next = current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId];
      // 领导被移除时回退为第一个成员（无成员则清空）
      setLeaderId((leader) =>
        next.includes(leader) ? leader : next[0] ?? "",
      );
      return next;
    });
  };

  const toggleSkill = (skillId: string) => {
    setEnabledSkills((current) =>
      current.includes(skillId)
        ? current.filter((id) => id !== skillId)
        : [...current, skillId],
    );
  };

  const handlePickDir = async () => {
    const dir = await pickWorkingDirectory();
    if (dir) setWorkspaceDir(dir);
  };

  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("editor.errors.nameRequired"));
      return;
    }
    if (memberIds.length < 2) {
      setError(t("editor.errors.minMembers"));
      return;
    }
    // 领导兜底：未指定或不在成员里时取第一个成员（领导模式需要）
    const finalLeader = memberIds.includes(leaderId) ? leaderId : memberIds[0];

    onSave({
      id: team.id,
      version: team.version,
      name: trimmedName,
      avatar: avatar.trim() || "👥",
      description: description.trim(),
      mode,
      leaderId: finalLeader,
      memberIds,
      systemPrompt: systemPrompt.trim(),
      enabledSkills,
      workspaceDir: workspaceDir.trim() || undefined,
    });
  };

  // 工作目录显示：仅末级名称
  const dirLabel = workspaceDir
    ? workspaceDir.split(/[\\/]/).filter(Boolean).pop() || workspaceDir
    : t("editor.workspace.select");

  return (
    <Modal open onOpenChange={(next) => { if (!next) onClose(); }}>
      <ModalContent size="2xl" showCloseButton={true} className="h-[min(760px,calc(100vh-4rem))] max-h-[calc(100vh-4rem)] max-w-[min(1180px,calc(100%-2rem))] rounded-lg bg-background">
        <ModalTitle className="sr-only">{t("editor.title")}</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <Users className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">{t("editor.title")}</span>
        </header>

        <ModalBody className="bg-background">
          <div className="space-y-6">
            {/* 头像与名称 */}
            <Field icon={Sparkles} label={t("editor.identity.label")}>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(true)}
                  className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-input bg-muted/60 text-2xl transition-colors hover:border-ring hover:bg-muted"
                  title={t("editor.identity.pickEmoji")}
                >
                  {avatar || "👥"}
                </button>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-12 flex-1 rounded-lg border border-input bg-background px-4 text-base outline-none transition-colors focus:border-ring"
                  placeholder={t("editor.identity.namePlaceholder")}
                />
              </div>
            </Field>

            {/* 团队简介 */}
            <Field icon={Bot} label={t("editor.description.label")}>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="app-scrollbar min-h-[80px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-ring"
                placeholder={t("editor.description.placeholder")}
              />
            </Field>

            {/* 协作模式 */}
            <Field icon={Zap} label={t("editor.mode.label")}>
              <SettingDropdown
                value={mode}
                placeholder={t("editor.mode.placeholder")}
                options={modeOptions}
                onChange={(value) => setMode(value as TeamMode)}
                className="h-11 w-full justify-between"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {mode === "leader"
                  ? t("editor.mode.leaderDescription")
                  : t("editor.mode.equalDescription")}
              </p>
            </Field>

            {/* 团队成员 */}
            <Field icon={Users} label={t("editor.members.label")}>
              <div className="app-scrollbar max-h-[300px] overflow-y-auto rounded-lg border border-border bg-card shadow-sm">
                {agents.length > 0 ? (
                  agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex min-h-[60px] items-center gap-4 border-b border-border px-5 py-3 transition-colors last:border-b-0 hover:bg-muted/30"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-xl">
                        {agent.avatar || "⚡"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">
                          {agent.name}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {agent.description || t("common.noDescription")}
                        </span>
                      </span>
                      <Switch
                        checked={memberIds.includes(agent.id)}
                        onCheckedChange={() => toggleMember(agent.id)}
                      />
                    </div>
                  ))
                ) : (
                  <div className="flex min-h-[100px] items-center justify-center text-sm text-muted-foreground">
                    {t("editor.members.empty")}
                  </div>
                )}
              </div>
            </Field>

            {/* 领导（仅领导模式） */}
            {mode === "leader" && (
              <Field icon={Star} label={t("editor.leader.label")}>
                {leaderOptions.length > 0 ? (
                  <SettingDropdown
                    value={leaderId}
                    placeholder={t("editor.leader.placeholder")}
                    options={leaderOptions}
                    onChange={setLeaderId}
                    className="h-11 w-full justify-between"
                  />
                ) : (
                  <div className="flex h-11 items-center rounded-lg border border-dashed border-border px-4 text-sm text-muted-foreground">
                    {t("editor.leader.empty")}
                  </div>
                )}
              </Field>
            )}

            {/* 团队系统提示词 */}
            <Field icon={Bot} label={t("editor.systemPrompt.label")}>
              <textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                className="app-scrollbar min-h-[160px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-ring"
                placeholder={t("editor.systemPrompt.placeholder")}
              />
            </Field>

            {/* 团队技能 */}
            <Field icon={Wrench} label={t("editor.skills.label")}>
              <div className="app-scrollbar max-h-[300px] overflow-y-auto rounded-lg border border-border bg-card shadow-sm">
                {skills.length > 0 ? (
                  skills.map((skill) => (
                    <div
                      key={skill.id}
                      className="flex min-h-[64px] items-center gap-4 border-b border-border px-5 py-3 transition-colors last:border-b-0 hover:bg-muted/30"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">
                          {skill.name}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                          {skill.description}
                        </span>
                      </span>
                      <Switch
                        checked={enabledSkills.includes(skill.id)}
                        onCheckedChange={() => toggleSkill(skill.id)}
                      />
                    </div>
                  ))
                ) : (
                  <div className="flex min-h-[100px] items-center justify-center text-sm text-muted-foreground">
                    {t("editor.skills.empty")}
                  </div>
                )}
              </div>
            </Field>

            {/* 工作区目录 */}
            <Field icon={FolderOpen} label={t("editor.workspace.label")}>
              <Button
                variant="outline"
                className="h-11 w-full justify-start gap-2 px-4 font-normal"
                onClick={() => void handlePickDir()}
                title={workspaceDir || t("editor.workspace.select")}
              >
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{dirLabel}</span>
              </Button>
            </Field>

            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
          </div>
        </ModalBody>

        <ModalFooter>
          <Button variant="outline" onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          <Button
            variant="default"
            onClick={save}
            disabled={memberIds.length < 2 || !name.trim()}
          >
            {t("actions.save")}
          </Button>
        </ModalFooter>
      </ModalContent>

      <EmojiPicker
        open={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        onSelect={(emoji) => setAvatar(emoji)}
      />
    </Modal>
  );
}
