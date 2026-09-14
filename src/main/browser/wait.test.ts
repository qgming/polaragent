// 「等稍后就绪的东西」的单测。
//
// 这段逻辑支撑的是「模型自己能叫出浏览器面板」：模型调用工具的那一刻面板可能还没挂载，
// 而面板挂载 → 建元素 → did-attach-webview 是一条异步链路。这里覆盖三种真实会发生的形状：
//   · 已经就绪 → 不该等（最常见路径，等一个轮询间隔就是白让人感觉卡）；
//   · 稍后就绪 → 拿到值，且中途按轮次重发请求（用户可能又把面板收起来）；
//   · 一直不就绪 → 返回 null 让调用方报错，**不能**静默返回半成品。
// 用注入的时钟与 sleep，所以这些测试是即时跑完的，不依赖真实时间。

import { describe, expect, it } from "vitest";
import { DEFAULT_WAIT_POLL_MS, DEFAULT_WAIT_TIMEOUT_MS, waitFor } from "./wait";

/** 可控时钟：sleep 直接把虚拟时间往前推，于是超时判定与真实时间无关 */
function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe("waitFor", () => {
  it("已经就绪时不等待，也不重发请求", async () => {
    let retries = 0;
    const result = await waitFor({
      probe: () => "ready",
      onRetry: () => {
        retries += 1;
      },
      ...clock(),
    });

    expect(result).toBe("ready");
    // 关键：一次都不该重试 —— 白等一个轮询间隔就是白让用户感觉卡顿
    expect(retries).toBe(0);
  });

  it("稍后就绪时拿到值，并按轮次重发请求（用户中途收起面板也能纠正）", async () => {
    const time = clock();
    let attempts = 0;
    const result = await waitFor({
      // 第 3 次探测才就绪
      probe: () => {
        attempts += 1;
        return attempts >= 3 ? "arrived" : null;
      },
      onRetry: () => undefined,
      timeoutMs: 10_000,
      pollMs: 50,
      ...time,
    });

    expect(result).toBe("arrived");
    expect(attempts).toBe(3);
  });

  it("超时返回 null，而不是半成品（调用方据此报错）", async () => {
    const time = clock();
    let retries = 0;
    const result = await waitFor({
      probe: () => null,
      onRetry: () => {
        retries += 1;
      },
      timeoutMs: 200,
      pollMs: 50,
      ...time,
    });

    expect(result).toBeNull();
    // 每轮都催一次：等待期间用户可能把面板又收起来
    expect(retries).toBeGreaterThan(0);
  });

  it("retryEveryMs 把通知压到更低的频率，但不影响探测频率", async () => {
    // 探测要快（早拿到早干活），通知没必要跟着那么密：
    // 一个幂等的副作用重复几十次不改变结果，只在出问题时把日志淹掉。
    const time = clock();
    let probes = 0;
    let retries = 0;
    await waitFor({
      probe: () => {
        probes += 1;
        return null;
      },
      onRetry: () => {
        retries += 1;
      },
      timeoutMs: 1_000,
      pollMs: 50,
      retryEveryMs: 500,
      ...time,
    });

    // 1 秒 / 50ms = 20 轮探测，但通知只该发 2~3 次（t=0 那次 + 每 500ms 一次）
    expect(probes).toBeGreaterThanOrEqual(15);
    expect(retries).toBeLessThanOrEqual(3);
    expect(retries).toBeGreaterThan(0);
  });

  it("缺省时 retryEveryMs 等于 pollMs（行为与加这个参数之前一致）", async () => {
    const time = clock();
    let retries = 0;
    await waitFor({
      probe: () => null,
      onRetry: () => {
        retries += 1;
      },
      timeoutMs: 250,
      pollMs: 50,
      ...time,
    });

    // 5 轮 → 5 次通知
    expect(retries).toBe(5);
  });

  it("探测抛错按「未就绪」处理，不让整个等待崩掉", async () => {
    // guest 在两次探测之间被销毁是常态（切走面板就会销毁），不是异常
    const time = clock();
    let attempts = 0;
    const result = await waitFor({
      probe: () => {
        attempts += 1;
        if (attempts < 3) throw new Error("guest 已销毁");
        return "recovered";
      },
      timeoutMs: 5_000,
      pollMs: 50,
      ...time,
    });

    expect(result).toBe("recovered");
  });

  it("默认值是可用量级：5 秒上限、50ms 轮询", () => {
    // 上限太短会在「界面正忙」时误报失败，太长会让工具调用显得卡死
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_WAIT_POLL_MS).toBe(50);
  });

  it("异步探针：几轮后才 resolve 出值时能拿到该值", async () => {
    // 页面内的探针只能异步取（一次 executeJavaScript），所以 probe 允许返回 Promise
    const time = clock();
    let attempts = 0;
    const result = await waitFor({
      probe: async () => {
        attempts += 1;
        return attempts >= 3 ? "arrived" : null;
      },
      timeoutMs: 5_000,
      pollMs: 50,
      ...time,
    });

    expect(result).toBe("arrived");
    expect(attempts).toBe(3);
  });

  it("异步探针先抛错、再返回 null、最后成功：一次拒绝只算「未就绪」", async () => {
    // guest 在两次探测之间被销毁、页面导航中求值被打断都是常态：一次拒绝不能把整个
    // 等待打崩，否则「面板刚挂载就被切走」会变成一条异常，而不是一次正常的等待
    const time = clock();
    let attempts = 0;
    const result = await waitFor({
      probe: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("guest 在两次探测之间被销毁");
        if (attempts === 2) return null;
        return "recovered";
      },
      timeoutMs: 5_000,
      pollMs: 50,
      ...time,
    });

    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  it("异步探针一直抛错：超时返回 null，不把异常抛给调用方", async () => {
    // 只有调用方才知道自己在等什么、该建议用户做什么（等面板要提示手动打开右侧边栏，
    // 等文本要说「页面可能渲染成别的样子」），所以这里必须是 null 而不是异常
    const result = await waitFor({
      probe: async (): Promise<null> => {
        throw new Error("页面导航中求值被中断");
      },
      timeoutMs: 200,
      pollMs: 50,
      ...clock(),
    });

    expect(result).toBeNull();
  });

  it("异步探针一律不就绪：超时仍返回 null，onRetry 与 retryEveryMs 的节流不变", async () => {
    const time = clock();
    let probes = 0;
    let retries = 0;
    const result = await waitFor({
      probe: async () => {
        probes += 1;
        return null;
      },
      onRetry: () => {
        retries += 1;
      },
      timeoutMs: 1_000,
      pollMs: 50,
      retryEveryMs: 500,
      ...time,
    });

    expect(result).toBeNull();
    // 1 秒 / 50ms = 20 轮 + 首次那次；通知却只发 2 次（t=0 的首次 + 每 500ms 一次）：
    // 探测要快（早拿到早干活），通知没必要跟着那么密
    expect(probes).toBe(21);
    expect(retries).toBe(2);
  });
});
