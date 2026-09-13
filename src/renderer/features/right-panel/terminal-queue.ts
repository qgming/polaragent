import type { TerminalChunk } from "@/shared/contracts/terminal";

/**
 * 终端输出「按 seq 连续写出」的纯逻辑。
 *
 * 抽出来的理由：同一个终端的输出从**两条路**到达 —— 事件推送（terminal-data）与
 * 回放（replay，异步）。回放返回前事件可能已经写进 xterm，于是同一段会被写两次、
 * 游标还会被回放的旧 nextSeq 往回带。把它们合流成一条按 seq 排序的流之后，
 * 「谁该写、谁该丢、谁该等」就变成一段与 React、xterm 都无关的纯计算，
 * 可以直接喂数据断言（见 terminal-queue.test.ts）。
 *
 * 判定规则只有三条：
 *   · seq < 游标 → 已被覆盖的重复段，丢弃；
 *   · seq > 游标 → 中间有缺口，从这里开始等（缺口一定会被回放补上：
 *                  主进程每段输出都是「先入环形缓冲、再发事件」，两条路同源）；
 *   · seq = 游标 → 写出，游标 +1。
 */
export interface DrainResult {
  /** 应当按序写出的输出（已按 seq 升序） */
  writable: readonly TerminalChunk[];
  /** 推进后的游标：下一个期望的 seq */
  cursor: number;
  /** 还没轮到写出的段（缺口及其之后），下次再试 */
  remaining: readonly TerminalChunk[];
}

/** 按 seq 升序排列的副本；顺序错乱会让连续性判定失效，所以入队后必须先排序 */
export function sortChunks(chunks: readonly TerminalChunk[]): TerminalChunk[] {
  return [...chunks].sort((a, b) => a.seq - b.seq);
}

/**
 * 第一个可用的 seq。
 *
 * 主进程的 ReplayBuffer 从 1 开始编号（见 main/terminal/service.ts 的 nextSeq 初值），
 * 所以「下一个期望的 seq」初值也是 1 —— 写成 0 会让 drainQueue 永远匹配不上
 * 第一段（1 > 0 被当成缺口），表现为**终端一片空白且永远不刷新**。
 */
export const FIRST_SEQ = 1;

export function drainQueue(queue: readonly TerminalChunk[], cursor: number): DrainResult {
  const writable: TerminalChunk[] = [];
  /*
    把游标夹到合法范围：小于 FIRST_SEQ 的值（例如忘了初始化的 0）会让第一段
    永远被当成「缺口」而卡死整条流 —— 这个失败模式是「界面全空白且毫无提示」，
    代价远大于在这里多一行夹取。
  */
  let next = Math.max(cursor, FIRST_SEQ);
  let consumed = 0;

  for (const chunk of queue) {
    if (chunk.seq < next) {
      // 重复段：回放里已经写过一次
      consumed += 1;
      continue;
    }
    if (chunk.seq > next) break; // 缺口：等回放补齐
    writable.push(chunk);
    next = chunk.seq + 1;
    consumed += 1;
  }

  return { writable, cursor: next, remaining: queue.slice(consumed) };
}
