import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, RotateCcw, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { TerminalChunk, TerminalInfo } from "@/shared/contracts/terminal";
import { PanelEmpty, PanelError } from "./panel-view";
import { drainQueue, FIRST_SEQ, sortChunks } from "./terminal-queue";
import { useTerminalStore } from "./terminal-store";

/**
 * 终端面板：给用户敲的持久终端（真 PTY）。
 *
 * 与「后台作业」面板（JobPanel）的区别：作业面板显示的是模型起的一次性后台进程，
 * 没有 stdin；这里是交互式 shell，可输入、可 Ctrl+C、可改尺寸。
 *
 * 三件套（主进程侧实现，见 main/terminal/service.ts）在渲染层的一侧表现：
 *   · **回放缓冲** —— 切走标签再切回来，xterm 实例被销毁重建，历史靠 replay 补齐；
 *   · **绝对游标** —— 每个 xterm 实例记着自己消费到哪个 seq，不会重复写、也不会漏段；
 *   · 主进程不做逐视图游标，所以多开几个视图（未来）零成本。
 *
 * xterm 实例的生命周期**绑在标签的选中状态上**，不是绑在组件的挂载上：
 * 视口只有一个，切标签就要把旧实例销毁、给新标签建一个。
 * 保留五个隐藏的实例只会让五个 shell 的渲染管线一起跑（其中四个看不到，纯浪费）。
 */

/**
 * 从 CSS 变量构造 xterm 主题，让它跟着应用的亮/暗主题走。
 *
 * 读的是运行时计算值（getComputedStyle）而不是把色值抄一份：主题由 .dark 类驱动，
 * 抄一份就有两个真相，改了 index.css 终端会变成唯一不同步的地方。
 * ANSI 16 色沿用应用的数据色（--chart-*），没有对应语义的档位给固定的常规值 ——
 * 这一路本来就是「终端该有的颜色」，不该为了统一而把它调成灰阶。
 */
function readTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => {
    const raw = style.getPropertyValue(name).trim();
    return raw === "" ? fallback : raw;
  };

  const background = value("--code-surface", value("--background", "#ffffff"));
  const foreground = value("--foreground", "#1f1f1f");

  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    // 选区用 accent（与界面上其它选中态同一个色），而不是终端默认的亮蓝
    selectionBackground: value("--accent", "rgba(0,0,0,0.12)"),
    black: value("--ink-4", "#3f3f46"),
    red: value("--chart-4", "#dc2626"),
    green: value("--chart-2", "#16a34a"),
    yellow: value("--chart-3", "#d97706"),
    blue: value("--chart-1", "#2563eb"),
    magenta: "#a855f7",
    cyan: value("--chart-5", "#0891b2"),
    white: value("--ink-2", "#e4e4e7"),
    brightBlack: value("--ink-3", "#71717a"),
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fbbf24",
    brightBlue: "#60a5fa",
    brightMagenta: "#c084fc",
    brightCyan: "#22d3ee",
    brightWhite: value("--foreground", "#fafafa"),
  };
}

/**
 * 待写队列的上限（段数）。超过就丢最老的 ——
 * 真正的历史由主进程的 2 MB 环形缓冲兜底，这里只是防止队列本身无限增长。
 */
const MAX_QUEUED_CHUNKS = 5000;

/**
 * 把视口认成「可用尺寸」的最小宽高（像素）。
 *
 * 为什么需要这个阈值：FitAddon 在容器塌成 0×0 时**不会**返回 undefined，
 * 而是返回 `{cols: 2, rows: 1}`（它内部是 Math.max(2, 负数)，实测确认）——
 * cols 的下限被硬编码成 2。于是「收起右侧栏」会把这个尺寸转发给 PTY，
 * 运行中的程序收到 SIGWINCH 后按 2 列重画，那一屏乱码会**永久留在回放缓冲里**。
 * 所以尺寸低于阈值时一律不动 PTY（见 flushResize）。
 */
const MIN_VIEWPORT_PX = 40;

/**
 * 并发闸门：自动建终端只能有一次在飞。
 *
 * 为什么需要：`load()` 是异步的，React 严格模式又会把挂载 effect 跑两遍 ——
 * 两次都在「列表还是空的」那一刻检查，就会建出两个终端。
 * 用一个模块级标记把并发收成一次；建完之后 terminals 不再为空，
 * 后续调用自然不会再建。
 */
let autoCreateInFlight = false;

/**
 * 进入终端面板时，若一个终端都没有就自动建一个。
 *
 * 这样点侧边栏里的「终端」直接就能敲命令，不必再点一次「+」。
 * **只在没有终端时建**：用户手动关掉最后一个终端时不会立刻又冒出一个
 *（那会变成「关不掉」），要下次再进来才会补一个。
 */
async function autoCreateIfEmpty(cwd: string | undefined): Promise<void> {
  if (cwd === undefined || autoCreateInFlight) return;
  autoCreateInFlight = true;
  try {
    const store = useTerminalStore.getState();
    // 再查一次真实状态：await 期间可能已经有终端了
    if (store.terminals.length === 0) await store.create(cwd);
  } finally {
    autoCreateInFlight = false;
  }
}

export function TerminalPanel(): React.JSX.Element {
  const { t } = useTranslation();

  const terminals = useTerminalStore((s) => s.terminals);
  const activeId = useTerminalStore((s) => s.activeId);
  const error = useTerminalStore((s) => s.error);
  const loading = useTerminalStore((s) => s.loading);
  const load = useTerminalStore((s) => s.load);
  const create = useTerminalStore((s) => s.create);
  const close = useTerminalStore((s) => s.close);
  const setActive = useTerminalStore((s) => s.setActive);
  const applyEvent = useTerminalStore((s) => s.applyEvent);
  const clearError = useTerminalStore((s) => s.clearError);
  /** 新终端的启动目录：当前会话绑定的工作目录；没有绑定就交给主进程回落 */
  const sessionCwd = useChatStore((s) =>
    s.activeSessionId !== null
      ? s.sessions.find((item) => item.id === s.activeSessionId)?.cwd
      : undefined,
  );
  const cwd = sessionCwd;

  /** cwd 的镜像：自动建终端只用挂载那一刻的目录，而它不该成为 effect 的依赖 */
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  /** xterm 的宿主元素（每个标签一个视口，但同一时刻只挂载一个） */
  const viewportRef = useRef<HTMLDivElement | null>(null);
  /** 当前视口的 xterm 实例与它的 fit 插件；切标签时销毁重建 */
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);

  /**
   * 待写队列：按终端 id 攒着输出，**只在 seq 连续时才写进 xterm**。
   *
   * 为什么要队列而不是「直接写」：同一个终端的输出会从**两条路**同时到达 ——
   * 事件推送（terminal-data）与回放（replay）。回放是异步的，在它返回前事件已经
   * 可能写进去了，于是同一段内容会被写两次、游标还会被回放的旧 nextSeq 往回带。
   * 统一走「入队 → 按序冲刷」之后，两条路合流成一条：
   * seq 小于游标的段是已被覆盖的重复内容（丢掉），大于游标的段说明中间有缺口
   *（等回放补齐再继续），只有正好等于游标的段才写出。
   */
  const queueRef = useRef<Map<string, TerminalChunk[]>>(new Map());

  /**
   * 每个终端「下一个期望的 seq」。
   *
   * **每个 xterm 实例都从 0 重新开始**：切标签会销毁旧实例、建一个空白实例，
   * 所以它需要的是**整份历史**，而不是「上次之后的新增」——
   * 早期实现沿用了上一个实例的游标，结果切回来只能看到后半段输出（已修）。
   */
  const cursorRef = useRef<Map<string, number>>(new Map());

  /** activeId 的镜像：事件回调是长期订阅，闭包里读不到最新的 activeId */
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  /**
   * 把一个终端的待写队列按 seq 顺序冲刷进 xterm。
   *
   * 只有「正好等于当前游标」的段才写出，于是这个函数天然幂等：
   *   · seq < 游标 → 已被回放/写入覆盖过，丢弃；
   *   · seq > 游标 → 中间有缺口（回放还没到），就此打住，等补齐再继续；
   *   · seq = 游标 → 写出并把游标 +1。
   * 缺口一定会被补上：主进程每段输出都是「先入环形缓冲、再发事件」，两条路同源。
   */
  const flushQueue = useCallback((id: string) => {
    const queue = queueRef.current.get(id);
    const term = termRef.current;
    // 不是当前视口（或实例还没建好）就不动：队列留着，等它被选中时再冲
    if (queue === undefined || term === null || activeIdRef.current !== id) return;

    // 判定逻辑在 terminal-queue.ts 里（纯函数，有独立单测覆盖）
    const drained = drainQueue(queue, cursorRef.current.get(id) ?? FIRST_SEQ);
    if (drained.writable.length > 0) {
      // 一次 write 调用写完这一批：xterm 内部按调用顺序排队，
      // 逐段调用会让同一帧的输出分成多次解析，反而更容易被撕裂
      term.term.write(drained.writable.map((chunk) => chunk.data).join(""));
    }

    if (drained.remaining.length === 0) queueRef.current.delete(id);
    else queueRef.current.set(id, [...drained.remaining]);
    cursorRef.current.set(id, drained.cursor);
  }, []);

  /** 把若干段放进队列（保持按 seq 升序），并在当前视口时立刻尝试冲刷 */
  const enqueue = useCallback(
    (id: string, incoming: readonly TerminalChunk[]) => {
      if (incoming.length === 0) return;
      const queue = [...(queueRef.current.get(id) ?? []), ...incoming];
      // 升序：事件流本身有序，但回放的批次可能插在中间
      const sorted = sortChunks(queue);
      // 上限保护：丢最老的（真正的历史由主进程的 2 MB 缓冲兜底）
      const bounded =
        sorted.length > MAX_QUEUED_CHUNKS
          ? sorted.slice(sorted.length - MAX_QUEUED_CHUNKS)
          : sorted;
      queueRef.current.set(id, bounded);
      flushQueue(id);
    },
    [flushQueue],
  );

  /**
   * 进入面板时做两件事：拉一次终端列表，若一个都没有就自动建一个。
   *
   * 「自动建一个」是需求：点侧边栏里的「终端」直接就能敲命令，不必再点一次「+」。
   *
   * cwd 走 ref 而不是依赖：切会话会换 cwd，但那时**不该**重新拉列表、
   * 更不该重订事件流（重订会漏掉订阅间隙里的输出）。自动建只用挂载那一刻的 cwd。
   */
  useEffect(() => {
    void (async () => {
      await load();
      await autoCreateIfEmpty(cwdRef.current);
    })();
  }, [load]);

  /**
   * 订阅终端事件流。
   *
   * 与上面拆成两个 effect 是刻意的：这个只订阅一次（依赖全是稳定引用），
   * 输出永远不会因为「目录变了」这种无关变化而漏掉。
   */
  useEffect(() => {
    return window.oint.terminal.onEvent((event) => {
      if (event.type === "terminal-data") {
        enqueue(event.id, [{ seq: event.seq, data: event.data }]);
        return;
      }
      applyEvent(event);
    });
  }, [enqueue, applyEvent]);

  /**
   * 为当前选中的终端建立（或重建）xterm 实例。
   *
   * 依赖只有 activeId：切换标签时销毁旧的、建新的。
   * 用 useLayoutEffect 而不是 useEffect —— 视口必须在浏览器绘制前就绪，
   * 否则会先看到一帧空白容器，然后终端内容才「跳」出来。
   */
  useLayoutEffect(() => {
    const host = viewportRef.current;
    if (host === null || activeId === null) return undefined;

    const term = new Terminal({
      theme: readTheme(),
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      // 滚动回看：xterm 自己保留一份 scrollback，主进程那份是给「切回来」用的
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // 点终端里的链接：用系统的默认浏览器打开，而不是在应用窗口里导航（那会毁掉整个界面）
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void window.oint.app.openPath(uri);
      }),
    );

    term.open(host);

    // 输入：键盘（含 Ctrl+C 的 \x03）与粘贴都从 onData 出
    const dataDisposable = term.onData((data) => {
      void window.oint.terminal.write(activeId, data);
    });

    termRef.current = { term, fit };

    /*
      **游标归零**：这是一个全新的空 xterm，它需要的是整份历史。

      早期实现沿用「上一个实例消费到哪」的游标，于是 A→B→A 切回来时
      replay(fromSeq) 只返回新增部分，A 的早期输出永久看不见（实测症状：
      切回标签只剩后半段）。所以每个实例都把游标归回第一段、整份重放；
      2 MB 之上由主进程的环形缓冲去截，代价可接受。
    */
    cursorRef.current.set(activeId, FIRST_SEQ);

    /*
      按游标回放：切回来补齐历史（实例销毁重建，xterm 里没有任何内容）。

      `cancelled` 守卫是必需的，不是防御性代码：回放是异步的，而用户可以在它返回前
      切到别的标签 —— 那时 cleanup 已经 dispose 了这个实例。若照旧写进去，
      内容会写进一个已销毁的 xterm（丢失）。

      回放的段**也走 flushQueue**（而不是直接 term.write）：这样它与实时事件
      合流成一条按 seq 排序的流，同一段不会被写两次、游标也不会被往回带。
    */
    let cancelled = false;
    void window.oint.terminal
      .replay(activeId, 0)
      .then((result) => {
        if (cancelled) return;
        enqueue(activeId, result.chunks);
      })
      .catch((failure: unknown) => {
        // 回放失败不该让终端不可用：它只是历史缺一段，新输出照常走事件流
        console.warn(`终端回放失败：${String(failure)}`);
      });

    /*
      尺寸变化：fit 一次并把真实尺寸报给主进程（PTY 才按新列宽折行）。

      **视口塌成 0 时什么都不做** —— 这是「收起右侧栏不影响终端」的关键：
      FitAddon 在 0×0 容器上会返回 {cols:2, rows:1}（不是 undefined，实测确认），
      照它去 resize 会让运行中的程序按 2 列重画，那屏乱码会永久留在回放缓冲里。
      ResizeObserver 在收起动画期间会连发，所以这里同时用 rAF 合并到每帧一次。
    */
    const flushResize = () => {
      const { clientWidth, clientHeight } = host;
      if (clientWidth < MIN_VIEWPORT_PX || clientHeight < MIN_VIEWPORT_PX) return;
      fit.fit();
      void window.oint.terminal.resize(activeId, term.cols, term.rows);
    };

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(flushResize);
    });
    observer.observe(host);

    // 建立时就报一次真实尺寸：主进程默认给的是 80x24，实际视口不是。
    // 注意这里用 requestAnimationFrame 而不是同步调用 —— 本 effect 在布局阶段跑，
    // 此刻 host 的盒模型可能还没定下来（首次展开时宽度是 0），同步 fit 会拿到错误尺寸。
    frame = requestAnimationFrame(() => {
      flushResize();
      // 先冲刷「实例建立前就到达」的输出，再让回放补齐缺口（见 cursorRef 的说明）
      flushQueue(activeId);
      term.focus();
    });

    return () => {
      // 先置取消位：回放可能正在飞，它回来时会看到这个标记而放弃写入（见上方说明）
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      dataDisposable.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [activeId, enqueue, flushQueue]);

  /**
   * 丢弃已关闭终端的驻留状态。
   *
   * 队列与游标都以终端 id 为键，终端被关掉后这些条目就再也没人读 ——
   * 队列里可能还压着几十 KB 输出，不清就是泄漏。
   * 放在这里（而不是 close 的调用点）是为了覆盖所有移除路径：
   * 用户点关闭、以及 store 收到 terminal-removed。
   */
  useEffect(() => {
    const live = new Set(terminals.map((item) => item.id));
    for (const id of queueRef.current.keys()) {
      if (!live.has(id)) queueRef.current.delete(id);
    }
    for (const id of cursorRef.current.keys()) {
      if (!live.has(id)) cursorRef.current.delete(id);
    }
  }, [terminals]);

  /**
   * 主题切换时重上色。
   *
   * xterm 的主题是构造参数，改不了 —— 但可以直接写 options.theme 让它重绘。
   * 监听 <html> 的 class 变化（.dark 由 settings-store 挂上去），
   * 这样系统主题跟随与手动切换两条路都覆盖得到。
   */
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const current = termRef.current;
      if (current !== null) current.term.options.theme = readTheme();
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const activeTerminal = terminals.find((item) => item.id === activeId) ?? null;

  const handleCreate = () => {
    if (cwd === undefined) return;
    // 先按视口真实尺寸建：默认 80x24 会让第一条提示符折行错位，看到就闪一下
    const size =
      termRef.current === null
        ? undefined
        : { cols: termRef.current.term.cols, rows: termRef.current.term.rows };
    void create(cwd, size);
  };

  /** 重启：关掉再开一个。死掉的 PTY 接不回来，也没有「复活」的语义 */
  const handleRestart = (terminal: TerminalInfo) => {
    void close(terminal.id).then(() => create(terminal.cwd));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        标签栏（始终显示，即使只有一个终端）：标签在左，「新建」在右端。

        为什么不再有「终端」标题行：面板头部（RightSidebar）已经显示当前视图名，
        这里重复同一个词就是缺陷。而「新建」本来就属于标签栏的语义
        （新建一个标签），放在这一行右端比单占一条标题行合理。
      */}
      <div className="flex h-8 shrink-0 items-center border-b border-border/60">
        {/* 这一层单独滚动：标签多了横向滚，但不把右侧的新建按钮一起滚走 */}
        <div className="app-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5">
          {terminals.map((terminal) => (
            <TerminalTab
              key={terminal.id}
              terminal={terminal}
              active={terminal.id === activeId}
              onSelect={() => setActive(terminal.id)}
              onClose={() => void close(terminal.id)}
            />
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("rightPanel.terminalNew")}
          title={t("rightPanel.terminalNew")}
          disabled={cwd === undefined}
          onClick={handleCreate}
          className="mr-1 shrink-0"
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {error !== null && (
        <div className="relative">
          <PanelError message={error} />
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={clearError}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-ink-4 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      )}

      {/* 状态行：shell 路径 + pid + 退出码 / 丢弃提示。
          只在有选中终端时出现，信息量小但都是「这个终端到底是什么」的关键事实。 */}
      {activeTerminal !== null && (
        <div className={cn(mono, "flex h-6 shrink-0 items-center gap-2 px-3 text-ink-4")}>
          <span className="min-w-0 truncate" title={activeTerminal.shell}>
            {activeTerminal.title} · pid {activeTerminal.pid}
          </span>
          {activeTerminal.status === "exited" ? (
            <span className="shrink-0">
              {activeTerminal.exitCode === undefined
                ? t("rightPanel.terminalExitedNoCode")
                : t("rightPanel.terminalExited", { code: activeTerminal.exitCode })}
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1">
              {/* 状态点：live 蓝 = 运行中（与全应用同一个语义），不用绿色（那是成功） */}
              <span className="size-1.5 rounded-full bg-live" aria-hidden="true" />
              {t("rightPanel.terminalRunning")}
            </span>
          )}
          {activeTerminal.droppedBytes > 0 && (
            <span className="shrink-0" title={t("rightPanel.terminalDropped")}>
              ⚠
            </span>
          )}
          {activeTerminal.status === "exited" && (
            <button
              type="button"
              onClick={() => handleRestart(activeTerminal)}
              className="ml-auto flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-ink-3 transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <RotateCcw className="size-3" />
              {t("rightPanel.terminalRestart")}
            </button>
          )}
        </div>
      )}

      {/* 视口。`key` 让 React 在切标签时重建宿主节点 —— 与上面的 useLayoutEffect 一起，
          保证「新标签拿到的是一块干净的 DOM」而不是上一个终端残留的 canvas。 */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeId !== null ? (
          /* 视口本身不吃点击：xterm 在它内部接管了鼠标与焦点（点一下自动聚焦它的输入区），
             这里再挂 onClick 只是重复，静态元素挂鼠标处理器也过不了 a11y 规则。 */
          <div key={activeId} ref={viewportRef} className="h-full w-full px-2 pt-1" />
        ) : loading ? (
          <div className={cn(mono, "p-4 text-ink-4")}>{t("common.loading")}</div>
        ) : (
          <PanelEmpty
            icon={SquareTerminal}
            title={t("rightPanel.terminalEmpty")}
            hint={
              cwd === undefined ? t("rightPanel.filesPickRoot") : t("rightPanel.terminalEmptyHint")
            }
          />
        )}
      </div>
    </div>
  );
}

/** 一个终端标签：状态点 + 标题 + 关闭按钮 */
function TerminalTab({
  terminal,
  active,
  onSelect,
  onClose,
}: {
  terminal: TerminalInfo;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "group flex h-6 shrink-0 items-center gap-1.5 rounded-md pr-0.5 pl-2 text-[12px]",
        active
          ? "bg-accent text-accent-foreground"
          : "text-ink-3 hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            terminal.status === "running" ? "bg-live" : "bg-ink-4",
          )}
          aria-hidden="true"
        />
        <span className="max-w-[9rem] truncate">{terminal.title}</span>
      </button>
      <button
        type="button"
        aria-label={t("rightPanel.terminalClose")}
        title={t("rightPanel.terminalClose")}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="rounded p-0.5 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
