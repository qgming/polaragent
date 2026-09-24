import { create } from "zustand";
import { ipcErrorMessage } from "@/renderer/features/settings/settings-shared";
import type { UsageStatsReport } from "@/shared/contracts/stats";

/**
 * 用量统计在渲染层的唯一来源。
 *
 * ## 为什么有轮询
 *
 * 历史折叠是**分拍**做的（主进程每次请求有预算，见 main/stats/usage-stats.ts）：
 * 第一次打开统计时，报告里的 `scanning.active` 为真，意思是「还有会话没折到」。
 * 那不是一个错误状态，也不该让用户手点刷新 —— 这里自己按一个短间隔再问一次，
 * 每次都会推进游标，直到折完。界面上同时给出进度，用户知道正在发生什么。
 *
 * ## 为什么报告不随模态窗关闭清空
 *
 * 关掉再打开时先用旧数据把界面填上（几百毫秒的刷新在后台进行），
 * 而不是让用户再看一次骨架屏 —— 这份数据是「越来越准」的，旧的并不算错。
 *
 * ## 失败态与空态分得开
 *
 * `error` 非空 = 这次 IPC 失败（界面给重试）；`report` 为 null 且无错 = 还没加载完。
 * 主进程那边还刻意区分了「会话列表读不到」（抛错 → 走 error）与「真的没有任何会话」
 * （正常返回全 0 的报告），两者在界面上长得完全不一样。
 */
interface StatsState {
  /** 最近一次成功读取的报告；null = 还没有读到过 */
  report: UsageStatsReport | null;
  /** 首次加载中（报告还没有任何数据可显示时用骨架屏）；轮询期间是 false */
  loading: boolean;
  /** 失败原因；null = 没有失败 */
  error: string | null;

  /** 读取报告；`scanning.active` 时自动安排下一次（幂等，可重复调用） */
  load(): Promise<void>;
  /** 关掉模态窗时调：停掉轮询。**不清报告**（下次打开先拿它填界面） */
  stop(): void;
}

/** 轮询间隔：一次折叠的预算大约几十毫秒，350ms 足够让用户看不到空窗又不占着主进程 */
const POLL_INTERVAL_MS = 350;

/** 只增不减的请求序号：任何一次回到 store 之前都要先确认自己仍是「最新那一次」 */
let requestSeq = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function clearPoll(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

export const useStatsStore = create<StatsState>()((set, get) => ({
  report: null,
  loading: false,
  error: null,

  load: async () => {
    clearPoll();
    requestSeq += 1;
    const token = requestSeq;
    // 已有数据时不进加载态：刷新是静默的，不该把界面换成骨架屏
    if (get().report === null) set({ loading: true });

    try {
      const report = await window.oint.stats.report();
      if (token !== requestSeq) return;
      set({ report, loading: false, error: null });
      if (report.scanning.active) {
        pollTimer = setTimeout(() => {
          pollTimer = null;
          void get().load();
        }, POLL_INTERVAL_MS);
      }
    } catch (error) {
      if (token !== requestSeq) return;
      set({ loading: false, error: ipcErrorMessage(error) });
    }
  },

  stop: () => {
    // 递增序号让在途请求的结果作废，避免关掉模态窗之后还被写一次状态
    requestSeq += 1;
    clearPoll();
    set({ loading: false });
  },
}));

/** 供测试用：清掉模块级的轮询与序号（zustand store 本身无法在用例之间重建） */
export function resetStatsStoreForTests(): void {
  clearPoll();
  requestSeq = 0;
  useStatsStore.setState({ report: null, loading: false, error: null });
}
