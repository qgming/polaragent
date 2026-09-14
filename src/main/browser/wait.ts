// 「等一个稍后就绪的东西」的轮询逻辑：**纯函数，不依赖 electron**，因此可以直接测。
//
// 为什么单独抽出来：有两处需要轮询，而它们的探针一个同步、一个异步。
//   1. 模型要能自己叫出浏览器面板，就必须在服务侧等一小段时间
//      （发事件 → 面板挂载 → 建元素 → did-attach-webview 是一条异步链路）；
//   2. browser_wait 要在页面里反复求值（等文字出现 / 等选择器可见），而每次求值
//      都是一次 executeJavaScript —— 天生是异步的。
// 合成同一个实现，是为了让「超时怎么报、重发怎么节流、探测抛错怎么办」这些
// 容易写错的地方只有一份：
//   1. **超时返回 null 而不是抛错**：只有调用方才知道自己在等什么、该建议用户做什么
//      （等面板要说「请手动打开右侧边栏」，等文本要说「页面可能渲染成别的样子」）。
//      在这里抛一个通用超时错误会把这份信息压掉。
//   2. **首次探测的结果要用上**：漏掉就会出现「明明已经就绪还要等满一个轮询间隔」。
//   3. 探测本身可能抛错（guest 恰好在两次探测之间被销毁、页面导航中求值被中断），
//      不该让整个等待崩掉 —— 当作「未就绪」继续等就是了。

/** 等待的默认上限（毫秒） */
export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
/** 轮询间隔（毫秒）：按帧级粒度，避免用户看到「点了半天没反应」 */
export const DEFAULT_WAIT_POLL_MS = 50;

export interface WaitForOptions<T> {
  /**
   * 探测一次；未就绪返回 null（也可以直接 throw，已被视为「未就绪」）。
   *
   * 允许返回 Promise 是因为页面内的探针只能异步取（executeJavaScript）；
   * 同步探针（查一个变量、看一眼 guest 在不在）则不必被包成 Promise。
   */
  probe: () => T | null | Promise<T | null>;
  /**
   * 刻意做成可重复调用而不是只调一次：等待期间用户可能把面板又收起来，
   * 重复请求才能纠正过来。调用方应保证这个动作是幂等的。
   */
  onRetry?: () => void;
  /**
   * onRetry 的最小间隔（毫秒）；缺省与 pollMs 相同（即每轮都调）。
   *
   * 探测频率与通知频率是两件事：探测要快（早拿到就早干活），通知未必 ——
   * 一个幂等的副作用重复几十次不改变结果，只会在出问题时把日志淹掉。
   */
  retryEveryMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  /** 供测试注入的时钟；缺省用真实时间 */
  now?: () => number;
  /** 供测试注入的等待实现；缺省用 setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 反复探测直到拿到值或超时。
 *
 * 返回 null 表示超时 —— 由调用方决定错误文案（它才知道自己在等什么、该建议用户做什么）。
 */
export async function waitFor<T>(options: WaitForOptions<T>): Promise<T | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_WAIT_POLL_MS;
  const retryEveryMs = options.retryEveryMs ?? pollMs;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  // 先直接探一次：已经就绪时不该白等一个轮询间隔（这是最常见的路径 ——
  // 面板本来就在浏览器视图上，或页面早就渲染好了）
  const immediate = await tryProbe(options.probe);
  if (immediate !== null) return immediate;

  const deadline = now() + timeoutMs;
  // 首次通知一定发：那一刻正是「刚发现没就绪」的时候，最需要把请求送出去
  let lastRetryAt = Number.NEGATIVE_INFINITY;
  while (now() < deadline) {
    if (now() - lastRetryAt >= retryEveryMs) {
      lastRetryAt = now();
      options.onRetry?.();
    }
    await sleep(pollMs);
    const found = await tryProbe(options.probe);
    if (found !== null) return found;
  }
  return null;
}

/** 探测并把异常当作「未就绪」：guest 在两次探测之间被销毁、页面切换中求值被打断都是常态 */
async function tryProbe<T>(probe: () => T | null | Promise<T | null>): Promise<T | null> {
  try {
    return await probe();
  } catch {
    return null;
  }
}
