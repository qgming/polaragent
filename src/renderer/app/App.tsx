import { MotionConfig } from "motion/react";
import { useEffect } from "react";
import { TooltipProvider } from "@/renderer/components/ui/tooltip";
import { useActiveWorkingDir } from "@/renderer/features/chat/use-slash-commands";
import {
  PluginSurfaceModal,
  PluginsModal,
  usePluginPanels,
  usePluginSurfaceClose,
} from "@/renderer/features/plugins";
import { RightSidebar } from "@/renderer/features/right-panel/RightSidebar";
import { SearchModal } from "@/renderer/features/search";
import { SettingsModal } from "@/renderer/features/settings";
import { StatsModal } from "@/renderer/features/stats";
import { useGlobalShortcuts } from "@/renderer/hooks/useGlobalShortcuts";
import { OintRuntimeProvider } from "@/renderer/runtime/OintRuntimeProvider";
import { useChatStore } from "@/renderer/stores/chat-store";
import { usePluginsStore } from "@/renderer/stores/plugins-store";
import { useProjectsStore } from "@/renderer/stores/projects-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { MainShell } from "./MainShell";
import { SidebarShell } from "./SidebarShell";
import { TitleBar } from "./TitleBar";

export function App() {
  // 全局快捷键在应用根部注册一次，模态与面板都由各自 store 控制显隐
  useGlobalShortcuts();

  const pluginViews = usePluginsStore((s) => s.views);
  /*
    插件面板要**跟着插件列表同步进右栏注册表**。
    放在 App 根部而不是插件管理模态里：面板该在装好之后就一直可用，
    而不是"用户打开过一次插件管理之后才出现"—— 后者是最难查的一类症状
    （"我装了啊，怎么没有"）。
  */
  usePluginPanels(pluginViews);

  /*
    插件页面里点"关闭"时，把对应的标签 / 模态窗收掉。

    订阅放在 App 根部（而不是各自界面的宿主组件里）：事件说的是"某个界面该收了"，
    而宿主可能根本没挂载 —— 那时也要把 store 里的状态清掉，否则下次打开会看到
    一个已经被宣布关掉的界面。
  */
  usePluginSurfaceClose();

  const theme = useSettingsStore((s) => s.settings?.theme);
  /*
    主题变化时推给插件界面。

    **推的源头在渲染层，不在主进程** —— 主题的唯一真源是设置，而主进程没有
    "设置变了"的事件源（`loadSettings` 每次现读、没有变更通知）。渲染层每次都真的
    知道这件事，所以由它发起。

    没有插件界面时这次 IPC 是空转（返回 0），代价可以忽略；而不推的后果是
    插件界面在用户切主题之后**一直亮着或一直暗着**。
  */
  useEffect(() => {
    if (theme === undefined) return;
    void window.oint.plugins.broadcastTheme(theme).catch(() => {});
  }, [theme]);

  const workingDir = useActiveWorkingDir();
  /*
    把当前会话的工作目录告诉宿主。

    它决定**项目级插件目录**（`<工作目录>/.oint/plugins/`）扫不扫 —— 而模型写插件
    只能写在会话工作目录里（那是路径围栏允许的范围）。所以"对话创建插件之后
    能在插件管理里看见"这条链，靠的就是这一条。

    只在**工作目录真的变了**时发（`useActiveWorkingDir` 的返回值是稳定的字符串），
    切会话切到同一个目录不会重复发。
  */
  useEffect(() => {
    void window.oint.plugins.setWorkspace(workingDir).catch(() => {});
  }, [workingDir]);

  useEffect(() => {
    // 启动加载：设置（含主题应用与系统主题监听）+ 会话列表 + 项目列表；IPC 失败不影响界面骨架
    void useSettingsStore
      .getState()
      .init()
      .catch(() => {});
    void useChatStore
      .getState()
      .loadSessions()
      .catch(() => {});
    // 项目列表决定侧栏「项目」分组的内容，与会话列表一起在启动时拉一次
    void useProjectsStore
      .getState()
      .load()
      .catch(() => {});
    /*
      插件列表同样在启动时拉一次 —— 上面那个同步钩子需要它，
      而只靠"打开插件管理时再拉"会让插件面板在用户第一次点开插件管理之前都不存在。
      代价是一次目录扫描（主进程那边本来也已经扫过一次算贡献面了）。
    */
    void usePluginsStore
      .getState()
      .load()
      .catch(() => {});
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      {/* reducedMotion="user"：JS 动效统一跟随系统偏好，与 CSS 侧的 prefers-reduced-motion 兜底对齐 */}
      <MotionConfig reducedMotion="user">
        {/* 左右两栏都从窗口顶边开始：侧栏自带顶行（品牌 + 折叠/搜索），内容区顶栏只横跨内容区，
            所以这里是「一行两栏」，而不是原来的「整宽顶栏 + 两栏」。 */}
        <div className="flex h-screen bg-background text-foreground">
          {/* 运行时包住侧栏与主区：侧栏的会话列表走官方 ThreadList primitives，需要 runtime 上下文 */}
          <OintRuntimeProvider>
            <SidebarShell />
            {/* 中间列：顶栏 + 主区。右栏放在这一列之外，让它的高度贯通整窗
                —— 右栏的顶行与左栏、内容区顶栏三者等高，三条横线才连成一致的一条。 */}
            <div className="flex min-w-0 flex-1 flex-col">
              <TitleBar />
              <MainShell />
            </div>
            <RightSidebar />
          </OintRuntimeProvider>
        </div>
        {/* 浮层挂载在布局之外，避免受侧栏/主区的溢出裁剪 */}
        <SettingsModal />
        <PluginsModal />
        {/* 数据统计模态窗：与上面两个并列（同一层浮层、同一套互斥） */}
        <StatsModal />
        {/* 插件自己的模态窗界面（清单里 kind: "modal"）：与上面两个并列，同一层浮层 */}
        <PluginSurfaceModal />
        <SearchModal />
      </MotionConfig>
    </TooltipProvider>
  );
}
