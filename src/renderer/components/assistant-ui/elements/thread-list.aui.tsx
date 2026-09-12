"use client";

/**
 * 侧栏会话列表。
 *
 * 相对上游 registry 的**有意偏差**有两处：
 *  · 文字走 i18n 而不是硬编码英文（可见文案与无障碍标签都是），
 *    这一支是本应用的界面语言，不该在中文界面里露出英文；
 *  · 列表按「置顶 / 项目 / 最近」三个分组渲染，分组与置顶都不是上游的概念。
 *
 * 之所以在这里直接 `useTranslation` / 读 store 而不是由调用侧传 props：
 * 列表项是通过 `components={{ ThreadListItem }}` 以**组件引用**交给 primitives 的，
 * 没有可用的 props 通道，硬要传就得给这个引用包一层、逐级把标签与状态透下去 ——
 * 那比直接用词条和 store 更绕。
 *
 * 分组数据取 chat-store（会话）与 projects-store（项目列表），不取 aui 的 item 状态：
 * 归组要用到每个会话自己的工作目录，那是本应用自己的字段。两个 store 都是订阅式的，
 * 置顶一次或绑定一个项目后立刻重排，不需要额外的同步。
 */

import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArchiveIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "lucide-react";
import {
  type ComponentPropsWithoutRef,
  type FC,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/renderer/components/ui/dropdown-menu";
import { Input } from "@/renderer/components/ui/input";
import { Skeleton } from "@/renderer/components/ui/skeleton";
import { buildSidebarSections, type ProjectSection } from "@/renderer/lib/projects";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useProjectsStore } from "@/renderer/stores/projects-store";
import type { Project } from "@/shared/contracts";

export const ThreadList: FC = () => {
  const [search, setSearch] = useState("");
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);

  return (
    <ThreadListRoot>
      <ThreadListNew />
      {hasThreads && <ThreadListSearch value={search} onValueChange={setSearch} />}
      <ThreadListItems searchQuery={hasThreads ? search : ""} />
    </ThreadListRoot>
  );
};

/**
 * 带搜索框的列表版本：侧栏不用它（侧栏的搜索是 Ctrl+K 的搜索模态窗），
 * 保留给需要「列表内即时筛选」的调用方。
 */
export const ThreadListSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentPropsWithoutRef<typeof Input>, "value" | "onChange"> & {
    value: string;
    onValueChange: (value: string) => void;
  }
>(({ className, value, onValueChange, ...props }, ref) => {
  return (
    <div data-slot="aui_thread-list-search" className="relative px-0.5 py-1">
      <SearchIcon
        data-slot="aui_thread-list-search-icon"
        className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2"
      />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        aria-label="Search threads"
        placeholder="Search threads"
        className={cn("h-8 ps-8 text-sm", className)}
        {...props}
      />
    </div>
  );
});

ThreadListSearch.displayName = "ThreadListSearch";

export const ThreadListRoot: FC<ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>> = ({
  className,
  ...props
}) => {
  return (
    <ThreadListPrimitive.Root
      data-slot="aui_thread-list-root"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
};

export const ThreadListItems: FC<ComponentPropsWithoutRef<"div"> & { searchQuery?: string }> = ({
  className,
  searchQuery = "",
  ...props
}) => {
  return (
    <div
      data-slot="aui_thread-list-items"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    >
      <AuiIf condition={(s) => s.threads.isLoading}>
        <ThreadListSkeleton />
      </AuiIf>
      <AuiIf condition={(s) => !s.threads.isLoading}>
        <ThreadListSections searchQuery={searchQuery} />
      </AuiIf>
    </div>
  );
};

/** 项目分组默认预览条数：再多就收在「展开显示」后面，侧栏不至于被一个项目撑满 */
const PROJECT_PREVIEW_LIMIT = 5;

type SectionId = "pinned" | "projects" | "recent";

/**
 * 三个分组的内容。置顶组没有会话时整个不出现（空的分组只是噪音）；
 * 项目组恒在——它标题右侧的加号就是「绑定项目」的入口；最近组恒在。
 */
export const ThreadListSections: FC<{ searchQuery?: string }> = ({ searchQuery = "" }) => {
  const { t } = useTranslation();
  const sessions = useChatStore((state) => state.sessions);
  const projects = useProjectsStore((state) => state.projects);
  const threadIds = useAuiState((state) => state.threads.threadIds);
  const [collapsed, setCollapsed] = useState<Partial<Record<SectionId, boolean>>>({});

  const toggleSection = useCallback((id: SectionId) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // aui 的列表项按下标渲染，这里把会话 id 映射到它在 threads 里的下标
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    threadIds.forEach((id, index) => {
      map.set(id, index);
    });
    return map;
  }, [threadIds]);

  const query = searchQuery.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (query === "") return sessions;
    // 无标题的会话照它**显示出来的**兜底文字参与匹配，否则搜「新对话」搜不到
    return sessions.filter((session) =>
      (session.title ?? t("sidebar.newChat")).toLowerCase().includes(query),
    );
  }, [sessions, query, t]);

  const sections = useMemo(() => buildSidebarSections(filtered, projects), [filtered, projects]);

  const renderItems = useCallback(
    (ids: readonly string[]): ReactNode[] =>
      ids.flatMap((id) => {
        const index = indexById.get(id);
        // 会话刚建好、aui 那边还没收到时先跳过：下一帧下标就有了
        if (index === undefined) return [];
        return [
          <ThreadListPrimitive.ItemByIndex
            key={id}
            index={index}
            components={{ ThreadListItem }}
          />,
        ];
      }),
    [indexById],
  );

  // 有搜索词时不做分组：命中的是一小撮结果，按分组折叠反而会把结果埋起来
  if (query !== "") {
    if (filtered.length === 0) {
      return (
        <div
          data-slot="aui_thread-list-empty"
          className="text-muted-foreground px-2.5 py-4 text-sm"
        >
          {t("sidebar.noThreadsFound")}
        </div>
      );
    }
    return <>{renderItems(filtered.map((session) => session.id))}</>;
  }

  return (
    <>
      {sections.pinned.length > 0 && (
        <ThreadListSection
          label={t("sidebar.pinned")}
          collapsed={collapsed.pinned === true}
          onToggle={() => toggleSection("pinned")}
        >
          {renderItems(sections.pinned.map((session) => session.id))}
        </ThreadListSection>
      )}

      <ThreadListSection
        label={t("sidebar.projects")}
        collapsed={collapsed.projects === true}
        onToggle={() => toggleSection("projects")}
        action={<AddProjectButton />}
      >
        {sections.projects.length === 0 ? (
          <SectionHint>{t("sidebar.emptyProjects")}</SectionHint>
        ) : (
          sections.projects.map((section) => (
            <ProjectGroup key={section.project.id} section={section} renderItems={renderItems} />
          ))
        )}
      </ThreadListSection>

      <ThreadListSection
        label={t("sidebar.recent")}
        collapsed={collapsed.recent === true}
        onToggle={() => toggleSection("recent")}
        action={
          // 最近标题右侧的加号 = 新对话：仍走官方的 New primitive，
          // 与顶部的「新对话」是同一个入口（不是直接调 store，免得绕过 runtime 的切换逻辑）
          <ThreadListPrimitive.New asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("sidebar.newChat")}
              className="text-muted-foreground hover:text-foreground"
            >
              <PlusIcon className="size-4" />
            </Button>
          </ThreadListPrimitive.New>
        }
      >
        {renderItems(sections.recent.map((session) => session.id))}
      </ThreadListSection>
    </>
  );
};

/** 分组标题行：标题 +（标题右侧的）折叠箭头在左，可选动作按钮贴最右 */
const ThreadListSection: FC<{
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}> = ({ label, collapsed, onToggle, action, children }) => {
  return (
    <section data-slot="aui_thread-list-section" className="flex flex-col pt-1">
      <div data-slot="aui_thread-list-group-label" className="flex h-7 items-center gap-0.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-1 rounded-md px-2.5 text-xs font-medium outline-none focus-visible:ring-1"
        >
          <span className="truncate">{label}</span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
              collapsed && "-rotate-90",
            )}
          />
        </button>
        {action}
      </div>
      {/* 内层自己排版：折叠动画只负责「高度」，内容间距与缩进由这里给 */}
      <CollapsiblePanel open={!collapsed}>{children}</CollapsiblePanel>
    </section>
  );
};

/**
 * 展开/收起容器：grid-template-rows 0fr↔1fr 是纯 CSS 的高度动画，
 * 不需要测量内容高度，内容变化时也不会算错。
 *
 * 折叠期间内容只是被剪掉，仍会被 Tab 命中、仍在辅助技术树里，
 * 所以显式 inert 掉整棵子树。
 */
const CollapsiblePanel: FC<{ open: boolean; className?: string; children: ReactNode }> = ({
  open,
  className,
  children,
}) => {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div inert={!open} className="flex min-h-0 flex-col gap-0.5 overflow-hidden">
        {children}
      </div>
    </div>
  );
};

const SectionHint: FC<{ children: ReactNode }> = ({ children }) => {
  return <p className="text-muted-foreground px-2.5 py-1.5 text-xs">{children}</p>;
};

/** 「项目」标题右侧的加号：选一个文件夹并绑定成项目 */
const AddProjectButton: FC = () => {
  const { t } = useTranslation();
  const addByPicker = useProjectsStore((state) => state.addByPicker);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={t("sidebar.addProject")}
      className="text-muted-foreground hover:text-foreground"
      onClick={() => {
        // 用户取消选择不是错误（store 返回 null）；真正的失败（目录被删等）只记日志
        void addByPicker().catch((error: unknown) => {
          console.warn(`绑定项目失败：${String(error)}`);
        });
      }}
    >
      <PlusIcon className="size-4" />
    </Button>
  );
};

/** 一个项目：项目行 + 归属它的会话（缩进显示，超过预览条数收在「展开显示」后面） */
const ProjectGroup: FC<{
  section: ProjectSection;
  renderItems: (ids: readonly string[]) => ReactNode[];
}> = ({ section, renderItems }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const { project, sessions } = section;
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const containsActive = sessions.some((session) => session.id === activeSessionId);

  const visible = showAll ? sessions : sessions.slice(0, PROJECT_PREVIEW_LIMIT);
  const canExpand = sessions.length > PROJECT_PREVIEW_LIMIT;

  return (
    <div data-slot="aui_thread-list-project" className="group/project flex flex-col">
      <div
        className={cn(
          "flex h-8 items-center gap-0.5 rounded-md pe-1 hover:bg-muted",
          // 当前会话所属的项目行给一层底色：一眼看出「我正在这个项目里干活」
          containsActive && "bg-muted",
        )}
      >
        {/* 展开/收起不画箭头：状态由左侧文件夹图标表达（合上 / 打开） */}
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-start text-sm outline-none focus-visible:ring-1"
        >
          {expanded ? (
            <FolderOpenIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
          ) : (
            <FolderIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
          )}
          <span data-slot="aui_thread-list-project-name" className="min-w-0 flex-1 truncate">
            {project.name}
          </span>
        </button>
        <ProjectMenu project={project} />
        <NewProjectChatButton project={project} />
      </div>

      {/* 会话缩进到与项目名对齐（跳过文件夹图标那一档） */}
      <CollapsiblePanel open={expanded} className="ps-5">
        {sessions.length === 0 && section.pinnedCount === 0 && (
          <SectionHint>{t("sidebar.emptyProjectSessions")}</SectionHint>
        )}
        {renderItems(visible.map((session) => session.id))}
        {canExpand && (
          <button
            type="button"
            onClick={() => setShowAll((prev) => !prev)}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 h-7 shrink-0 rounded-md px-2.5 text-start text-xs outline-none focus-visible:ring-1"
          >
            {showAll ? t("sidebar.showLess") : t("sidebar.showMore")}
          </button>
        )}
      </CollapsiblePanel>
    </div>
  );
};

/** 项目行的更多菜单：打开文件夹 / 移除项目（新建会话已移到行右侧的独立按钮） */
const ProjectMenu: FC<{ project: Project }> = ({ project }) => {
  const { t } = useTranslation();
  const removeProject = useProjectsStore((state) => state.remove);

  const openFolder = useCallback(async () => {
    const result = await window.oint.app.openPath(project.path);
    if (!result.ok) console.warn(`打开项目目录失败：${result.reason}`);
  }, [project.path]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("sidebar.moreOptions")}
          title={t("sidebar.moreOptions")}
          className="text-muted-foreground hover:text-foreground data-[state=open]:text-foreground"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={6} className="min-w-44">
        <DropdownMenuItem onSelect={() => void openFolder()}>
          <FolderOpenIcon />
          {t("sidebar.openProjectFolder")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            // 只解绑：会话与它们的绑定目录都不动，解绑后回到「最近」
            void removeProject(project.id).catch((error: unknown) => {
              console.warn(`移除项目失败：${String(error)}`);
            });
          }}
        >
          <TrashIcon />
          {t("sidebar.removeProject")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * 项目行右侧的「新对话」：带 cwd 建会话 —— 会话因此归属这个项目，
 * Agent 也直接在这个目录里干活。
 */
const NewProjectChatButton: FC<{ project: Project }> = ({ project }) => {
  const { t } = useTranslation();
  const createSession = useChatStore((state) => state.createSession);
  const label = t("sidebar.newChatInProject");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className="text-muted-foreground hover:text-foreground"
      onClick={() => {
        void createSession({ cwd: project.path }).catch((error: unknown) => {
          console.warn(`在项目里新建会话失败：${String(error)}`);
        });
      }}
    >
      <PlusIcon className="size-4" />
    </Button>
  );
};

export const ThreadListNew = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof Button> & { labelClassName?: string }
>(({ className, labelClassName, children, ...props }, ref) => {
  return (
    <ThreadListPrimitive.New asChild>
      <Button
        ref={ref}
        variant="ghost"
        data-slot="aui_thread-list-new"
        className={cn(
          "hover:bg-muted data-active:bg-muted h-8 justify-start gap-2 rounded-md px-2.5 text-sm font-normal",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <PlusIcon data-slot="aui_thread-list-new-icon" className="size-4 shrink-0" />
            <span
              data-slot="aui_thread-list-new-label"
              className={cn("whitespace-nowrap", labelClassName)}
            >
              New Thread
            </span>
          </>
        )}
      </Button>
    </ThreadListPrimitive.New>
  );
});

ThreadListNew.displayName = "ThreadListNew";

const ThreadListSkeleton: FC = () => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          role="status"
          aria-label={t("sidebar.loadingThreads")}
          data-slot="aui_thread-list-skeleton-wrapper"
          className="flex h-8 items-center px-2.5"
        >
          <Skeleton data-slot="aui_thread-list-skeleton" className="h-3.5 w-full" />
        </div>
      ))}
    </div>
  );
};

export const ThreadListItem: FC = () => {
  const { t } = useTranslation();
  const auiRunning = useAuiState((s) => s.threadListItem.isRunning);
  const threadId = useAuiState((s) => s.threadListItem.id);
  // 置顶状态取 chat-store：它是唯一真源，置顶后菜单文案立刻变「取消置顶」
  const pinned = useChatStore(
    (state) => state.sessions.find((session) => session.id === threadId)?.pinned ?? false,
  );
  /**
   * 运行中指示取 store 而不是 aui 的 threadListItem.isRunning：后者只认「主线程」，
   * 用户切到别的会话后读不到后台会话的运行状态。主进程里每个会话各有一条独立 lane，
   * 后台会话的事件也带着自己的会话 id 送过来，所以这里能一直显示到它真的跑完。
   */
  const storeRunning = useChatStore((state) => state.runningBySession[threadId] === true);
  const isRunning = auiRunning || storeRunning;
  const [isRenaming, setIsRenaming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (isRenaming || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [isRenaming]);

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      className="group hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
    >
      {isRenaming ? (
        <ThreadListItemRename
          onDone={(restoreFocus) => {
            restoreFocusRef.current = restoreFocus;
            setIsRenaming(false);
          }}
        />
      ) : (
        <ThreadListItemPrimitive.Trigger
          ref={triggerRef}
          data-slot="aui_thread-list-item-trigger"
          className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start text-sm outline-none group-hover:pe-9 group-has-focus-visible:pe-9 group-has-data-[state=open]:pe-9 group-data-active:pe-9 focus-visible:ring-1"
        >
          {isRunning && (
            <Loader2Icon
              aria-hidden
              data-slot="aui_thread-list-item-running"
              className="text-muted-foreground me-1.5 size-3.5 shrink-0 animate-spin"
            />
          )}
          <span data-slot="aui_thread-list-item-title" className="min-w-0 flex-1 truncate">
            <ThreadListItemPrimitive.Title fallback={t("sidebar.newChat")} />
          </span>
          {isRunning && <span className="sr-only">{t("chat.running")}</span>}
        </ThreadListItemPrimitive.Trigger>
      )}
      <ThreadListItemMore
        threadId={threadId}
        pinned={pinned}
        onRename={() => setIsRenaming(true)}
      />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemRename: FC<{
  onDone: (restoreFocus: boolean) => void;
}> = ({ onDone }) => {
  const { t } = useTranslation();
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) ?? "";
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = (restoreFocus: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;

    const next = value.trim();
    if (!next || next === title) {
      onDone(restoreFocus);
      return;
    }

    // Deferred so a synchronous throw lands on the rejection path too.
    Promise.resolve()
      .then(() => aui.threadListItem.rename(next))
      .then(
        () => onDone(restoreFocus),
        () => {
          settledRef.current = false;
          if (restoreFocus) inputRef.current?.focus();
        },
      );
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onDone(true);
  };

  return (
    <Input
      ref={inputRef}
      autoFocus
      data-slot="aui_thread-list-item-rename"
      aria-label={t("sidebar.renameThread")}
      value={value}
      className="h-7 min-w-0 flex-1 ps-2.5 pe-9 text-sm"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
};

/** 会话的更多菜单：置顶/取消置顶 → 重命名 → 归档 → 删除 */
const ThreadListItemMore: FC<{
  threadId: string;
  pinned: boolean;
  onRename: () => void;
}> = ({ threadId, pinned, onRename }) => {
  const { t } = useTranslation();
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">{t("sidebar.moreOptions")}</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className="bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 overflow-hidden rounded-xl border p-1.5"
      >
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          onSelect={() => {
            void useChatStore
              .getState()
              .pinSession(threadId, !pinned)
              .catch((error: unknown) => {
                console.warn(`置顶会话失败：${String(error)}`);
              });
          }}
        >
          {pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
          {pinned ? t("sidebar.unpin") : t("sidebar.pin")}
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemMorePrimitive.Item
          data-slot="aui_thread-list-item-more-item"
          className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          onSelect={onRename}
        >
          <PencilIcon className="size-4" />
          {t("sidebar.rename")}
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemPrimitive.Archive asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          >
            <ArchiveIcon className="size-4" />
            {t("sidebar.archive")}
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Archive>
        <ThreadListItemPrimitive.Delete asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          >
            <TrashIcon className="size-4" />
            {t("sidebar.delete")}
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
