import { loadSettings } from "@/main/settings/store";
import type { ChatEvent } from "@/shared/contracts/chat";
import { createAiApprover } from "./ai-approver";
import { createApprovalService } from "./approvals";
import { createChatRuntime } from "./runtime";
import { getSessionStore } from "./session-store";

type ApprovalService = ReturnType<typeof createApprovalService>;
type ChatRuntime = ReturnType<typeof createChatRuntime>;

// 模块级持有器：IPC 处理器在 invoke 时取用，bootstrap 之前为 null
let approvalService: ApprovalService | null = null;
let chatRuntime: ChatRuntime | null = null;

/** 供 IPC 层读取当前审批服务；服务未就绪时返回 null */
export function getApprovalService(): ApprovalService | null {
  return approvalService;
}

/** 解析默认工作目录：优先设置项，未配置时回退进程当前目录 */
async function resolveWorkingDir(): Promise<string> {
  const settings = await loadSettings();
  return settings.defaultWorkingDir ?? process.cwd();
}

/** 装配 pisdk 各服务并接线到窗口事件；返回幂等清理函数 */
export function bootstrapPisdk(options: { emit: (event: ChatEvent) => void }): () => void {
  const { emit } = options;
  const sessionStore = getSessionStore();
  // 「帮我审批」模式下由该审批器自动给出结论；其余模式一律等用户确认
  const aiApprover = createAiApprover({ getSettings: loadSettings });

  approvalService = createApprovalService({ getSettings: loadSettings, emit, aiApprover });
  chatRuntime = createChatRuntime({
    getSettings: loadSettings,
    sessionStore,
    emit,
    approvals: approvalService,
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
