import { ChevronDown, Folder, FolderPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import { Popover, PopoverContent, PopoverTrigger } from "@/renderer/components/ui/popover";
import { ipcErrorMessage } from "@/renderer/features/settings/settings-shared";
import { findProjectForCwd } from "@/renderer/lib/projects";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useProjectsStore } from "@/renderer/stores/projects-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import { chipTrigger, menuPanel, PickerItem } from "./composer-chrome";

/**
 * 新会话页输入框**顶部**那一行：这个会话跑在哪个项目里。
 *
 * ## 为什么需要它
 *
 * 会话的工作目录是创建时就定下的（在项目里点「+」→ 绑定项目目录；直接「新对话」→
 * 本会话的临时工作区）。于是在「先开一个空白会话、再想起来要放进某个项目」这条路上，
 * 用户只能去侧栏重新点一次 —— 而那一刻他正对着输入框。
 *
 * ## 为什么是「改绑定」而不是「创建时传参」
 *
 * 空会话在界面上**已经存在**（新建对话是立即落盘的），所以这里能做的只有把它的根换掉
 * （`sessions:set-cwd`）。唯一不需要换的场景是「连会话都还没有」（刚启动、或刚删掉当前
 * 会话）—— 那时直接带着 cwd 建一个，省一次往返。
 *
 * 两条路径的可见结果完全相同：一个绑定到该项目、还没有消息的会话。
 *
 * ## 只在没有消息时可用
 *
 * 主进程那条通道自己也会拒（见 session-store 的 setCwd），这里再加一道运行中禁用：
 * 界面上这个入口本来就只在空会话页出现，多拦一道是为了不给「点下去必然失败」留门。
 */
export function ComposerContextRow(): React.JSX.Element {
  const { t } = useTranslation();
  const projects = useProjectsStore((s) => s.projects);
  const addByPicker = useProjectsStore((s) => s.addByPicker);
  /**
   * 只订阅 cwd 这一个字符串：zustand 按 Object.is 比较，返回整个 session 对象会让
   * 每次 sessions 变化（流式期每轮 touch 都会换数组）都重渲染这一行。
   */
  const sessionCwd = useChatStore(
    (s) => s.sessions.find((item) => item.id === s.activeSessionId)?.cwd,
  );
  const running = useChatStore(
    (s) => s.activeSessionId !== null && s.runningBySession[s.activeSessionId] === true,
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  /** 命中多个项目时取路径最长的那个（见 findProjectForCwd）；没绑定就是 null */
  const current = findProjectForCwd(sessionCwd ?? "", projects);

  const bind = async (path: string) => {
    setBusy(true);
    const store = useChatStore.getState();
    try {
      if (store.activeSessionId === null) await store.createSession({ cwd: path });
      else await store.setSessionCwd(store.activeSessionId, path);
      setOpen(false);
    } catch (error) {
      /**
       * 失败**不关菜单**：原因要看得见（目录没了 / 会话已经有消息），
       * 关掉菜单再报错会让用户以为「点了没反应」。提示落在输入框上方那行。
       */
      useUiStore.getState().notifyComposer({
        messageKey: "chat.welcomeProjectFailed",
        params: { reason: ipcErrorMessage(error) },
        level: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-slot="composer-context" className="flex items-center px-2 pt-1.5 pb-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(chipTrigger, (running || busy) && "cursor-not-allowed opacity-40")}
            aria-expanded={open}
            aria-label={t("chat.welcomeProject")}
            // 完整路径放 title：chip 上只放得下项目名，而「到底在哪个目录」是它的实质
            title={sessionCwd === undefined || sessionCwd === "" ? undefined : sessionCwd}
            disabled={running || busy}
          >
            <Folder className="size-3.5 shrink-0 opacity-70" />
            <span className="max-w-52 truncate">
              {current === null ? t("chat.welcomeProjectNone") : current.name}
            </span>
            <ChevronDown className="size-3 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className={cn(menuPanel, "w-72")}>
          <p className={cn(typeEyebrow, "px-2.5 pt-2 pb-1")}>{t("chat.welcomeProjectPicker")}</p>
          <p className="text-ink-3 px-2.5 pb-1.5 text-[11.5px] leading-snug">
            {t("chat.welcomeProjectHint")}
          </p>
          {projects.map((project) => (
            <PickerItem
              key={project.id}
              selected={project.id === current?.id}
              onSelect={() => void bind(project.path)}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate">{project.name}</span>
                {/* 同名项目是可能的（不同父目录下的同名文件夹），路径是唯一能分辨的那一行 */}
                <span className="text-ink-4 truncate font-mono text-[11px]">{project.path}</span>
              </span>
            </PickerItem>
          ))}
          {/*
            一个项目都还没有时，只给一句说明 + 同一个添加入口 —— 空菜单配一个「添加」
            比什么都不显示更让人知道下一步该干什么。
          */}
          {projects.length === 0 && (
            <p className="text-ink-3 px-2.5 py-2 text-[12.5px] leading-snug">
              {t("chat.welcomeProjectEmpty")}
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void addByPicker()}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-start text-[13.5px] outline-none transition-colors",
              "hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-foreground/20",
              "disabled:pointer-events-none disabled:opacity-40",
            )}
          >
            <FolderPlus className="text-ink-3 size-4 shrink-0" />
            {t("sidebar.addProject")}
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
