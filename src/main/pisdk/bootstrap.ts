import { loadSettings } from "@/main/settings/store";
import type { ChatEventEnvelope } from "@/shared/contracts/chat";
import { createAiApprover } from "./ai-approver";
import { createApprovalService } from "./approvals";
import { createChatRuntime } from "./runtime";
import { getSessionStore } from "./session-store";
import { createSessionTitleGenerator } from "./title-generator";

type ApprovalService = ReturnType<typeof createApprovalService>;
type ChatRuntime = ReturnType<typeof createChatRuntime>;

// 模块级持有器：IPC 处理器在 invoke 时取用，bootstrap 之前为 null
let approvalService: ApprovalService | null = null;
let chatRuntime: ChatRuntime | null = null;

/** 供 IPC 层读取当前审批服务；服务未就绪时返回 null */
export function getApprovalService(): ApprovalService | null {
  return approvalService;
}

/**
 * 解析会话工作目录：优先该会话绑定的目录（索引 cwd），其次设置里的默认工作目录，
 * 最后回退进程当前目录——保证「在项目里新建的会话」跑在该项目目录下。
 */
async function resolveWorkingDir(sessionId: string): Promise<string> {
  const bound = await getSessionStore().readCwd(sessionId);
  if (bound !== null) return bound;
  const settings = await loadSettings();
  return settings.defaultWorkingDir ?? process.cwd();
}

/** 装配 pisdk 各服务并接线到窗口事件；返回幂等清理函数 */
export function bootstrapPisdk(options: {
  emit: (payload: ChatEventEnvelope) => void;
}): () => void {
  const { emit } = options;
  const sessionStore = getSessionStore();
  // 「帮我审批」模式下由该审批器给出结论（模型取默认路由模型）；其余模式一律等用户确认
  const aiApprover = createAiApprover({ getSettings: loadSettings });
  // 首轮问答结束后用同一模型给会话命名
  const sessionTitles = createSessionTitleGenerator({ getSettings: loadSettings });

  approvalService = createApprovalService({ getSettings: loadSettings, emit, aiApprover });
  chatRuntime = createChatRuntime({
    getSettings: loadSettings,
    sessionStore,
    emit,
    approvals: approvalService,
    sessionTitles,
    resolveWorkingDir,
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      void Promise.resolve(chatRuntime?.dispose()).catch((error: unknown) => {
        console.warn(`关闭聊天运行时失败：${String(error)}`);
      });
    } catch (error) {
      console.warn(`关闭聊天运行时失败：${String(error)}`);
    }
    chatRuntime = null;
    approvalService = null;
  };
}
