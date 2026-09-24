/**
 * 数据统计面板的渲染测试（ui project / jsdom）。
 *
 * 面板是这一功能的**唯一出口**：上面那堆口径（日/周/累计、7/30 日、模型占比）
 * 到底有没有真的接到界面上，只在这里能验。所以断言都对着**用户看得见的读数**，
 * 而不是内部状态：卡片上的数字、切口径后格子的档位变化、图例里的模型名与占比。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { resetStatsStoreForTests, useStatsStore } from "@/renderer/stores/stats-store";
import type { Settings } from "@/shared/contracts/settings";
import type { UsageStatsReport } from "@/shared/contracts/stats";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { StatsPanel } from "./StatsPanel";

afterEach(cleanup);

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

function settingsFixture(services: Settings["services"] = []): Settings {
  return {
    theme: "light",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services,
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    agentMode: "standard",
    disabledSkillNames: [],
    disabledSubagentNames: [],
    mcpServers: [],
    systemMcpServerEnabled: {},
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
  };
}

/** 两天的数据、两个模型，且第二天明显更重（用来验档位与趋势） */
function reportFixture(overrides: Partial<UsageStatsReport> = {}): UsageStatsReport {
  const today = localDay(new Date());
  const yesterday = localDay(new Date(Date.now() - 86_400_000));
  return {
    generatedAt: Date.now(),
    today,
    totals: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 850, cacheWriteTokens: 0 },
    totalTokens: 1000,
    sessions: {
      total: 5,
      chat: { sessions: 4, tokens: 700 },
      subagent: { sessions: 1, tokens: 300 },
    },
    activeDays: 2,
    peak: { date: today, tokens: 800 },
    longestSession: { sessionId: "s1", title: "最长的那次", ms: 4 * 3_600_000 + 27 * 60_000 },
    streak: { current: 2, longest: 3 },
    days: [
      { date: yesterday, tokens: 200, models: { "svc|deepseek-chat": 200 } },
      {
        date: today,
        tokens: 800,
        models: { "svc|deepseek-chat": 500, "svc|glm-4": 300 },
      },
    ],
    models: [
      {
        key: "svc|deepseek-chat",
        serviceId: "svc",
        modelId: "deepseek-chat",
        tokens: 700,
        share: 0.7,
      },
      { key: "svc|glm-4", serviceId: "svc", modelId: "glm-4", tokens: 300, share: 0.3 },
    ],
    scanning: { active: false, scanned: 5, total: 5 },
    ...overrides,
  };
}

function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

beforeEach(() => {
  resetStatsStoreForTests();
  useSettingsStore.setState({
    settings: settingsFixture([
      {
        id: "svc",
        name: "服务一",
        baseUrl: "",
        apiKey: "",
        wireFormat: "openai-completions",
        models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "glm-4" }],
      },
    ]),
  });
});

describe("概览卡", () => {
  it("五个读数都在：累计 / 峰值 / 最长聊天 / 当前连续 / 最长连续", () => {
    useStatsStore.setState({ report: reportFixture() });
    const { container } = render(<StatsPanel />);

    expect(screen.getByText("累计 Token 数")).toBeTruthy();
    expect(screen.getByText("峰值 Token 数")).toBeTruthy();
    expect(screen.getByText("最长聊天时长")).toBeTruthy();
    expect(screen.getByText("当前连续天数")).toBeTruthy();
    expect(screen.getByText("最长连续天数")).toBeTruthy();

    // 读数的容器整块读：同一个数字在环心也会出现，按整块断言才分得清是哪个卡片
    const summary = container.querySelector('[data-slot="stats-summary"]')?.textContent ?? "";
    // zh-CN 的 compact 记法到「万」才有单位，1000 因此原样显示（英文那边会显示 1K）
    expect(summary).toContain("1000");
    expect(summary).toContain("800");
    expect(summary).toContain("4 小时 27 分钟");
    expect(summary).toContain("2 天");
    expect(summary).toContain("3 天");
    /*
      卡片上没有第三行副读数（用户要求去掉「含缓存读取与写入 / 出现在某天 / 最长那次的会话名」）。
      这条断言按整块文本查：那些文案一旦被谁加回来，这里就会红。
    */
    expect(summary).not.toContain("含缓存读取与写入");
    expect(summary).not.toContain("出现在");
    expect(summary).not.toContain("最长的那次");
  });
});

describe("热力图", () => {
  it("渲染年度网格，且当天的档位是最高的那档", () => {
    const report = reportFixture();
    useStatsStore.setState({ report });
    const { container } = render(<StatsPanel />);

    const cells = container.querySelectorAll('[data-slot="heat-cell"]');
    expect(cells).toHaveLength(53 * 7);
    const todayCell = container.querySelector(
      `[data-slot="heat-cell"][data-date="${report.today}"]`,
    );
    expect(todayCell?.getAttribute("data-level")).toBe("4");
  });

  it("切到「每周」：同一周的两天变成同一个值（那是本周合计）", () => {
    const report = reportFixture();
    useStatsStore.setState({ report });
    const { container } = render(<StatsPanel />);

    const heatValue = (date: string) =>
      Number(
        container
          .querySelector(`[data-slot="heat-cell"][data-date="${date}"]`)
          ?.getAttribute("data-value"),
      );

    const [yesterday, today] = report.days;
    if (yesterday === undefined || today === undefined) throw new Error("用例数据缺失");

    // 每日口径：两天的值不同
    expect(heatValue(yesterday.date)).toBe(200);
    expect(heatValue(today.date)).toBe(800);

    fireEvent.click(screen.getByRole("button", { name: "每周" }));
    // 每周口径：落在同一周的两天共享该周合计（1000）
    const first = heatValue(yesterday.date);
    const second = heatValue(today.date);
    expect(first).toBe(second);
    expect(first).toBe(1000);
  });

  it("切到「累计」：值单调不减", () => {
    useStatsStore.setState({ report: reportFixture() });
    const { container } = render(<StatsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "累计" }));

    const values = [...container.querySelectorAll('[data-slot="heat-cell"]')]
      .map((node) => Number(node.getAttribute("data-value")))
      .filter((value) => value > 0);
    expect([...values].sort((left, right) => left - right)).toEqual(values);
  });

  it("悬浮一格显示那天的读数", () => {
    const report = reportFixture();
    useStatsStore.setState({ report });
    const { container } = render(<StatsPanel />);

    const cell = container.querySelector(`[data-slot="heat-cell"][data-date="${report.today}"]`);
    fireEvent.pointerEnter(cell as Element);
    expect(screen.getByRole("tooltip").textContent).toContain("800");
  });
});

describe("趋势与模型用量", () => {
  it("图例用设置里的模型名，占比与环图同源", () => {
    useStatsStore.setState({ report: reportFixture() });
    render(<StatsPanel />);

    expect(screen.getAllByText("DeepSeek Chat").length).toBeGreaterThan(0);
    // glm-4 没配名字 -> 回落到模型 id
    expect(screen.getAllByText("glm-4").length).toBeGreaterThan(0);
    expect(screen.getByText("70%")).toBeTruthy();
    expect(screen.getByText("30%")).toBeTruthy();
  });

  /**
   * 明细行的 token 数是**概略量级**（万 / 亿），不是逐位数字：
   * 图例是拿来看比例的，九位数要数位才读得出大小。卡片、环心、图例、悬浮提示四处
   * 必须是同一套写法，所以这条同时钉住「有单位」与「不再出现千分位的原文」。
   */
  it("明细行按万/亿概略显示，不铺开逐位数字", () => {
    useStatsStore.setState({
      report: reportFixture({
        totalTokens: 166_543_000,
        models: [
          {
            key: "svc|deepseek-chat",
            serviceId: "svc",
            modelId: "deepseek-chat",
            tokens: 124_000_000,
            share: 0.7446,
          },
          {
            key: "svc|glm-4",
            serviceId: "svc",
            modelId: "glm-4",
            tokens: 42_543_000,
            share: 0.2554,
          },
        ],
      }),
    });
    const { container } = render(<StatsPanel />);

    const legend = container.querySelector('[data-slot="model-legend"]')?.textContent ?? "";
    expect(legend).toContain("1.2亿 tokens");
    expect(legend).toContain("4254.3万 tokens");
    // 逐位原文（带千分位）不该出现
    expect(legend).not.toContain("124,000,000");
    expect(legend).not.toContain("42,543,000");
  });

  it("两条趋势线各带一个模型键（颜色与图例同一槽）", () => {
    useStatsStore.setState({ report: reportFixture() });
    const { container } = render(<StatsPanel />);
    const lines = [...container.querySelectorAll('[data-slot="trend-line"]')];
    expect(lines.map((node) => node.getAttribute("data-model"))).toEqual([
      "svc|deepseek-chat",
      "svc|glm-4",
    ]);
  });

  it("切到近 30 日：横轴覆盖的天数变多（图例不变）", () => {
    useStatsStore.setState({ report: reportFixture() });
    render(<StatsPanel />);

    const labelCount = () =>
      document.querySelectorAll('[data-slot="trend-line"]')[0]?.getAttribute("d")?.match(/C/g)
        ?.length ?? 0;

    const short = labelCount();
    fireEvent.click(screen.getByRole("button", { name: "近 30 日" }));
    const long = labelCount();
    expect(long).toBeGreaterThan(short);
  });

  it("这段时间没有记录时给空态，不画线", () => {
    useStatsStore.setState({
      report: reportFixture({
        days: [],
        models: [],
        totalTokens: 0,
        peak: { date: null, tokens: 0 },
        activeDays: 0,
      }),
    });
    const { container } = render(<StatsPanel />);
    expect(container.querySelectorAll('[data-slot="trend-line"]')).toHaveLength(0);
    expect(screen.getByText("这段时间还没有用量记录")).toBeTruthy();
    expect(screen.getByText("还没有用量记录。开始一次对话，这里就会有数据。")).toBeTruthy();
  });
});

describe("口径行（数据是怎么来的）", () => {
  it("给出会话数、子智能体拆分、活跃天数与缓存读取", () => {
    useStatsStore.setState({ report: reportFixture() });
    render(<StatsPanel />);

    expect(screen.getByText("5 个会话")).toBeTruthy();
    expect(screen.getByText("其中子智能体 1 个 · 300")).toBeTruthy();
    expect(screen.getByText("2 天有记录")).toBeTruthy();
    expect(screen.getByText("缓存读取 850")).toBeTruthy();
  });

  it("历史还在折叠时说明进度", () => {
    useStatsStore.setState({
      report: reportFixture({ scanning: { active: true, scanned: 12, total: 40 } }),
    });
    render(<StatsPanel />);
    expect(screen.getByText("正在整理历史用量…（12/40 个会话）")).toBeTruthy();
  });
});

describe("加载与失败", () => {
  it("还没拿到报告时是加载态", () => {
    useStatsStore.setState({ report: null, loading: true, error: null });
    render(<StatsPanel />);
    expect(screen.getByText("正在统计…")).toBeTruthy();
  });

  it("失败时给原因与重试；重试真的会再问一次", async () => {
    const report = vi.fn(async () => reportFixture());
    vi.stubGlobal("window", { oint: { stats: { report } } });
    useStatsStore.setState({ report: null, loading: false, error: "读取会话列表失败" });

    render(<StatsPanel />);
    expect(screen.getByText("读取会话列表失败")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    await screen.findByText("累计 Token 数");
  });
});
