// 团队编辑模态窗：编辑团队的头像/名称/简介/协作模式/成员/领导/系统提示词/团队技能/工作区目录
// 仿 AgentEditorModal，基于通用 Modal 组件居中弹出

import { Bot, FolderOpen, Sparkles, Star, Users, Wrench, Zap } from "lucide-react";
import { useMemo, useState } from "react";

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

// 协作模式选项
const MODE_OPTIONS = [
  { value: "leader", label: "👑 领导模式 - 中心化调度" },
  { value: "equal", label: "💡 头脑风暴 - 平等发散" },
  { value: "parallel", label: "⚡ 并行模式 - 多助手同时触发" },
];

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
      setError("请填写团队名称");
      return;
    }
    if (memberIds.length < 2) {
      setError("团队至少需要 2 名成员");
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
    : "选择工作目录";

  return (
    <Modal open onOpenChange={(next) => { if (!next) onClose(); }}>
      <ModalContent size="2xl" showCloseButton={true} className="h-[min(760px,calc(100vh-4rem))] max-h-[calc(100vh-4rem)] max-w-[min(1180px,calc(100%-2rem))] rounded-lg bg-background">
        <ModalTitle className="sr-only">团队详情</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <Users className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">团队详情</span>
        </header>

        <ModalBody className="bg-background">
          <div className="space-y-6">
            {/* 头像与名称 */}
            <Field icon={Sparkles} label="头像与名称">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(true)}
                  className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-input bg-muted/60 text-2xl transition-colors hover:border-ring hover:bg-muted"
                  title="点击选择 Emoji"
                >
                  {avatar || "👥"}
                </button>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-12 flex-1 rounded-lg border border-input bg-background px-4 text-base outline-none transition-colors focus:border-ring"
                  placeholder="团队名称"
                />
              </div>
            </Field>

            {/* 团队简介 */}
            <Field icon={Bot} label="团队简介">
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="app-scrollbar min-h-[80px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-ring"
                placeholder="描述这个团队适合处理什么任务"
              />
            </Field>

            {/* 协作模式 */}
            <Field icon={Zap} label="协作模式">
              <SettingDropdown
                value={mode}
                placeholder="选择协作模式"
                options={MODE_OPTIONS}
                onChange={(value) => setMode(value as TeamMode)}
                className="h-11 w-full justify-between"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {mode === "leader"
                  ? "中心化调度，成员通过控制工具交接或结束，适合复杂项目推进"
                  : mode === "parallel"
                    ? "多个成员同时处理同一任务，完成后由领导汇总，适合调研、评审和方案比较"
                    : "平等发散观点，成员通过控制工具交接或收束，适合头脑风暴和方向探索"}
              </p>
            </Field>

            {/* 团队成员 */}
            <Field icon={Users} label="团队成员（从内置/已安装助手中选）">
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
                          {agent.description || "暂无描述"}
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
                    暂无可选助手，请先在「助手」页创建或安装
                  </div>
                )}
              </div>
            </Field>

            {/* 领导（仅领导模式） */}
            {mode === "leader" && (
              <Field icon={Star} label="领导（从已选成员里指定）">
                {leaderOptions.length > 0 ? (
                  <SettingDropdown
                    value={leaderId}
                    placeholder="选择领导"
                    options={leaderOptions}
                    onChange={setLeaderId}
                    className="h-11 w-full justify-between"
                  />
                ) : (
                  <div className="flex h-11 items-center rounded-lg border border-dashed border-border px-4 text-sm text-muted-foreground">
                    请先选择至少一名成员
                  </div>
                )}
              </Field>
            )}

            {/* 团队系统提示词 */}
            <Field icon={Bot} label="团队系统提示词">
              <textarea
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                className="app-scrollbar min-h-[160px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-ring"
                placeholder="定义团队协作目标、分工与边界（会叠加到每位成员的系统提示词）"
              />
            </Field>

            {/* 团队技能 */}
            <Field icon={Wrench} label="团队技能（对全员可用，即使成员自身未启用）">
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
                    暂无可用技能
                  </div>
                )}
              </div>
            </Field>

            {/* 工作区目录 */}
            <Field icon={FolderOpen} label="工作区目录">
              <Button
                variant="outline"
                className="h-11 w-full justify-start gap-2 px-4 font-normal"
                onClick={() => void handlePickDir()}
                title={workspaceDir || "选择工作目录"}
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
            取消
          </Button>
          <Button
            variant="default"
            onClick={save}
            disabled={memberIds.length < 2 || !name.trim()}
          >
            保存
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
