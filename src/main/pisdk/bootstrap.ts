import { app, BrowserWindow } from "electron";
import { loadSettings } from "@/main/settings/store";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import { IPC } from "@/shared/contracts/ipc";
import { getBrowserAutomation } from "../browser/service";
import { createProductionWebService } from "../web";
import { createAiApprover } from "./ai-approver";
import { createApprovalService } from "./approvals";
import { createInteractionService } from "./interactions";
import { getMcpServers } from "./mcp-servers";
import { createChatRuntime } from "./runtime";
import { getSessionStore } from "./session-store";
import { createSessionTitleGenerator } from "./title-generator";

type ApprovalService = ReturnType<typeof createApprovalService>;
type InteractionService = ReturnType<typeof createInteractionService>;
type ChatRuntime = ReturnType<typeof createChatRuntime>;

// 模块级持有器：IPC 处理器在 invoke 时取用，bootstrap 之前为 null
let approvalService: ApprovalService | null = null;
// 提问服务与审批一样跨会话共用：IPC 层回填答案必须打到运行时持有的那一份上
let interactionService: InteractionService | null = null;
let chatRuntime: ChatRuntime | null = null;

/** 供 IPC 层读取当前审批服务；服务未就绪时返回 null */
export function getApprovalService(): ApprovalService | null {
  return approvalService;
}

/** 供 IPC 层读取当前提问服务；服务未就绪时返回 null */
export function getInteractionService(): InteractionService | null {
  return interactionService;
}

/**
 * 解析会话工作目录：该会话在索引里绑定的目录（在项目里新建的会话就绑定该项目目录），
 * 没有绑定就回退进程当前目录。
 */
async function resolveWorkingDir(sessionId: string): Promise<string> {
  const bound = await getSessionStore().readCwd(sessionId);
  return bound ?? process.cwd();
}

/**
 * 装配 pisdk 各服务并接线到窗口事件。
 *
 * 返回**幂等的异步**清理函数：调用方（before-quit）必须 await 它，
 * 否则进程会在会话与子进程收尾完成前退出。
 */
export function bootstrapPisdk(options: {
  emit: (payload: ChatEventEnvelope) => void;
}): () => Promise<void> {
  const { emit } = options;
  const sessionStore = getSessionStore();
  // 「帮我审批」模式下由该审批器给出结论（模型取默认路由模型）；其余模式一律等用户确认
  const aiApprover = createAiApprover({ getSettings: loadSettings });
  // 首轮问答结束后用同一模型给会话命名
  const sessionTitles = createSessionTitleGenerator({ getSettings: loadSettings });
  // MCP 连接池：与设置面板共用同一实例（见 ipc/mcp.ts），否则面板状态与运行时工具会对不上
  const mcpServers = getMcpServers();

  approvalService = createApprovalService({ getSettings: loadSettings, emit, aiApprover });
  // 提问服务同样只建一份：运行时用它发起 ask_user，IPC 层用它回填答案（见 ipc/interactions.ts）
  interactionService = createInteractionService({ emit });
  chatRuntime = createChatRuntime({
    getSettings: loadSettings,
    sessionStore,
    emit,
    approvals: approvalService,
    interactions: interactionService,
    /**
     * 子智能体运行事件：与上面的 emit 同一套路，但走 subagents:event 通道。
     *
     * 在这里（而不是 runtime 内）拿 BrowserWindow 是刻意的：runtime 必须能在 node 单测里跑，
     * 而窗口只存在于 Electron 主进程 —— 由装配层注入，runtime 只认「一个发事件的函数」。
     */
    emitSubagent: (envelope) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.subagents.event, envelope);
      }
    },
    sessionTitles,
    resolveWorkingDir,
    // 应用根目录：内置技能住在 <appPath>/resources/skills（随包分发、只读、升级即更新）
    appPath: app.getAppPath(),
    mcp: mcpServers,
    // 内置浏览器自动化：与 IPC 域共用主进程单例，否则面板看到的与工具操作的会是两份状态。
    // 传的是实现对象而不是让 runtime 自己 import —— runtime 要能在 node 单测里跑（见其 deps 说明）。
    browser: getBrowserAutomation(),
    /**
     * 网络搜索 / 网页抓取：同样是注入实现而不是让 runtime 自己 import
     * （实现依赖 node:http(s) 与设置存储，后者会 await import electron 取 safeStorage）。
     *
     * 配置每次调用现取，所以改设置立即生效，不需要重建 service。
     */
    web: createProductionWebService({ getSettings: loadSettings }),
  });

  // 启动后异步连接已启用的 MCP server：单个 server 失败只记日志，不阻断启动。
  // 这里刻意不 await —— 握手要等子进程起来，不该让窗口等到 MCP 就绪才显示。
  void mcpServers.reload().catch((error: unknown) => {
    console.warn(`连接 MCP server 失败：${String(error)}`);
  });

  let disposed = false;
  /**
   * 释放全部资源。
   *
   * **返回 Promise，调用方必须 await**：`dispose()` 要串行关闭每个会话的
   * harness / 存储，并收掉 MCP 子进程 —— 早先这里是 fire-and-forget
   *（`void Promise.resolve(...)`），而 `before-quit` 调完就返回，
   * 进程可能在关闭中途退出：SQLite 没 flush、作业与 MCP 子进程变成孤儿。
   *
   * 幂等：重复调用只会跑一次（disposed 闸门），第二次立即 resolve。
   */
  return async () => {
    if (disposed) return;
    disposed = true;
    try {
      await chatRuntime?.dispose();
    } catch (error) {
      console.warn(`关闭聊天运行时失败：${String(error)}`);
    }
    try {
      // 退出前收掉 MCP 子进程，避免残留进程占着端口/文件句柄
      await mcpServers.dispose();
    } catch (error) {
      console.warn(`关闭 MCP 连接失败：${String(error)}`);
    }
    chatRuntime = null;
    approvalService = null;
    interactionService = null;
  };
}
