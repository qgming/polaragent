import { getUsageStatsService } from "@/main/stats/usage-stats";
import { IPC } from "@/shared/contracts/ipc";
import { handle } from "./handler";

/**
 * 注册统计域通道；只有一个只读通道 —— 其余全是渲染层自己的视图状态
 *（时间范围、热力图口径），不需要往主进程跑。
 *
 * 服务**惰性获取**：注册发生在应用引导早期，而它依赖会话库单例，
 * 与 sessions 那条通道同一个口径（注册时不建，用时才建）。
 */
export function registerStatsIpc(): void {
  handle(IPC.stats.report, "读取用量统计", () => getUsageStatsService().report());
}
