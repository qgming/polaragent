// `send` 的并发闸门（P1-1）。
//
// **这个文件存在的理由**：`send` 从进入函数到把 `running` 置真之间隔着两个 await
// （对齐模型、对齐思考档位）。并发进来的第二次 send 在这个窗口里看到的 `running`
// 仍是 false，于是两次都会走到 `lane.prompt`；第二个被内核以 LaneBusy 拒收，
// 而重试分支会 `abortStaleOperation` 再重发 —— 把**第一个调用方的活跃运行**中止掉。
// 一次用户消息静默杀死另一次，这是本仓最贵的稳定性缺陷。
//
// 这里把 AgentHarness 整体换成一个可观察的假实现：只关心
// 「prompt 被调用了几次」「abort 有没有在别人的运行上被触发」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@/shared/contracts/settings";

/** 记录假 lane 上的每一次调用 */
const harness = vi.hoisted(() => ({
  calls: { prompts: [], aborts: 0, promptResults: [], createOptions: [] } as {
    prompts: string[];
    aborts: number;
    promptResults: unknown[];
    /**
     * 每次 `AgentHarness.create` 收到的 options。
     *
     * 记下来是为了钉住一件曾经真的坏过的事：**系统提示算出来但没传进内核**。
     * 内核在 `systemPrompt` 缺省时直接返回空串（`generation.js` 的 resolveSystemPrompt），
     * 也就是「模型完全没有系统提示」——而假 harness 早期只关心 lane 的调用，
     * 于是这个缺口在测试里完全隐形。见下面「系统提示必须真的交给内核」那组用例。
     */
    createOptions: unknown[];
  },
  /** 让 prompt 停在原地，用来制造「第一个 send 还在飞」的窗口 */
  gate: { release: null as null | (() => void), wait: null as null | Promise<void> },
  /**
   * 挡住 `sendLocked` 的**第一个 await**（getSettings），用来精确停在真正的竞态窗口里：
   * `running` 还没置真、但这一轮 send 已经进来了。
   */
  settingsGate: { release: null as null | (() => void), wait: null as null | Promise<void> },
  settingsCalls: 0,
  /** 让 abort 停在原地，用来制造「stop 已返回、abort 尚未收敛」的窗口 */
  abortGate: { release: null as null | (() => void), wait: null as null | Promise<void> },
  /** 事件订阅表：测试可以据此向运行时投递任意 harness 事件（如陈旧的 run_end） */
  listeners: new Map<string, ((event: unknown) => void)[]>(),
  /** 向运行时投递 harness 事件 */
  emit: (_type: string, _event: unknown) => undefined as undefined,
  /**
   * 钩子登记表：`hooks.on(type, handler)` 收下来的处理器。
   *
   * 早期这里是 `hooks: { on: () => () => undefined }` —— 处理器被直接丢掉，
   * 于是**守卫这类挂在钩子上的逻辑在测试里完全跑不到**。
   * 「重复调用守卫」正是这种代码：纯逻辑（repeat-guard.ts）有测试，
   * 但「它到底有没有被接上」没有 —— 而后者才是容易错的地方
   *（系统提示「算出来没传下去」就是同一类事故）。
   */
  hooks: new Map<string, ((event: unknown) => unknown)[]>(),
  /** 触发某个钩子；返回所有处理器的返回值（取最后一个非 undefined 的） */
  fireHook: async (_type: string, _event: unknown): Promise<unknown> => undefined,
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const lane = {
    prompt: async (text: string) => {
      harness.calls.prompts.push(text);
      if (harness.gate.wait !== null) await harness.gate.wait;
      const next = harness.calls.promptResults.shift();
      return next ?? { ok: true, value: {} };
    },
    abort: async () => {
      harness.calls.aborts += 1;
      if (harness.abortGate.wait !== null) await harness.abortGate.wait;
      return { ok: true, value: {} };
    },
    steer: async () => ({ ok: true, value: {} }),
    followUp: async () => ({ ok: true, value: {} }),
    getModel: async () => ({ provider: "svc", id: "m1" }),
    setModel: async () => undefined,
    setThinkingLevel: async () => undefined,
    getThinkingLevel: async () => "medium",
    inspectExecution: async () => ({ current: null }),
    appendCustomEntry: async () => undefined,
    findEntry: async () => undefined,
    compact: async () => ({ ok: true, value: {} }),
    navigateTree: async () => ({ ok: true, value: {} }),
    getValue: async () => undefined,
    setValue: async () => undefined,
  };
  /** 事件订阅表：测试可以据此向运行时投递任意 harness 事件（如陈旧的 run_end） */
  const listeners = harness.listeners;
  /** 钩子登记表：与事件表同一手法，让测试能真的触发守卫这类挂在钩子上的逻辑 */
  const hooks = harness.hooks;
  const harnessInstance = {
    lane: async () => lane,
    close: async () => undefined,
    events: {
      on: (type: string, handler: (event: unknown) => void) => {
        const list = listeners.get(type) ?? [];
        list.push(handler);
        listeners.set(type, list);
        return () => undefined;
      },
    },
    hooks: {
      on: (type: string, handler: (event: unknown) => unknown) => {
        const list = hooks.get(type) ?? [];
        list.push(handler);
        hooks.set(type, list);
        return () => undefined;
      },
    },
    setTools: async () => undefined,
  };
  harness.emit = (type, event) => {
    for (const handler of listeners.get(type) ?? []) handler(event);
  };
  harness.fireHook = async (type, event) => {
    let result: unknown;
    for (const handler of harness.hooks.get(type) ?? []) {
      const value = await handler(event);
      if (value !== undefined) result = value;
    }
    return result;
  };
  harness.emit = (type, event) => {
    for (const handler of listeners.get(type) ?? []) handler(event);
  };
  return {
    ...actual,
    AgentHarness: {
      create: async (options: unknown) => {
        harness.calls.createOptions.push(options);
        return { harness: harnessInstance, open: [] };
      },
    },
    loadSkills: async () => ({ skills: [], diagnostics: [] }),
    loadPromptTemplates: async () => ({ promptTemplates: [], diagnostics: [] }),
    formatSkillsForSystemPrompt: () => "",
  };
});

vi.mock("@/main/app/paths", () => ({ dataDir: () => "/data-unused" }));

import { createApprovalService } from "./approvals";
import { type ChatRuntime, createChatRuntime } from "./runtime";
import type { SessionStore } from "./session-store";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [
      {
        id: "svc",
        name: "S",
        baseUrl: "https://x.test/v1",
        apiKey: "",
        wireFormat: "openai-completions",
        models: [{ id: "m1" }],
      },
    ],
    defaultModel: { serviceId: "svc", modelId: "m1" },
    thinkingLevel: "medium",
    permissionMode: "default",
    agentMode: "standard",
    disabledSkillNames: [],
    disabledSubagentNames: [],
    mcpServers: [],
    ...overrides,
  };
}

/** 会话存储替身：open 返回一份够 createRuntime 走完的最小句柄 */
function makeSessionStore(sessionMode: "standard" | "orchestrate" | null = null): SessionStore {
  const session = {
    metadata: { id: "s1", createdAt: 1, cwd: process.cwd() },
    createBranch: async () => ({}),
    branch: async () => ({ findEntries: async () => [], id: "main" }),
    getValue: async () => undefined,
    setValue: async () => undefined,
    deleteValue: async () => undefined,
    getStats: async () => ({ messageCount: 0 }),
    getEntry: async () => undefined,
    setName: async () => undefined,
    close: async () => undefined,
  };
  return {
    open: async () => ({ session, branch: { findEntries: async () => [], id: "main" } }),
    readCwd: async () => process.cwd(),
    readModel: async () => null,
    // 会话未绑定模式 → 跟随设置里的默认（与真实 store 的语义一致）
    readAgentMode: async () => sessionMode,
    readTitle: async () => null,
    touch: async () => undefined,
    setModel: async () => undefined,
    setAgentMode: async () => undefined,
  } as unknown as SessionStore;
}

function makeRuntime(
  options: {
    onEvent?: (sessionId: string, event: { type: string; runId?: string }) => void;
    /** 会话级模式绑定；null = 跟随设置里的默认 */
    sessionMode?: "standard" | "orchestrate" | null;
    /** 设置里的默认模式 */
    defaultMode?: "standard" | "orchestrate";
  } = {},
): ChatRuntime {
  const settings = makeSettings(
    options.defaultMode === undefined ? {} : { agentMode: options.defaultMode },
  );
  return createChatRuntime({
    getSettings: async () => {
      harness.settingsCalls += 1;
      // 第一个 send 会停在这里：此时 running 仍是 false —— 这正是竞态窗口
      if (harness.settingsGate.wait !== null) await harness.settingsGate.wait;
      return settings;
    },
    sessionStore: makeSessionStore(options.sessionMode ?? null),
    emit: (payload) => {
      options.onEvent?.(payload.sessionId, payload.event as { type: string; runId?: string });
    },
    approvals: createApprovalService({ getSettings: async () => settings, emit: () => undefined }),
    resolveWorkingDir: async () => process.cwd(),
  });
}

function resetHarness(): void {
  harness.calls.prompts = [];
  harness.calls.aborts = 0;
  harness.calls.promptResults = [];
  harness.calls.createOptions = [];
  harness.gate.release = null;
  harness.gate.wait = null;
  harness.settingsGate.release = null;
  harness.settingsGate.wait = null;
  harness.settingsCalls = 0;
  harness.abortGate.release = null;
  harness.abortGate.wait = null;
  harness.listeners.clear();
  harness.hooks.clear();
}

/** 取最近一次 create 里传下去的 systemPrompt，并把它求值成字符串 */
async function resolveSystemPrompt(): Promise<string> {
  const last = harness.calls.createOptions.at(-1) as { systemPrompt?: unknown } | undefined;
  const prompt = last?.systemPrompt;
  if (typeof prompt === "function") {
    return await (prompt as () => Promise<string>)();
  }
  if (typeof prompt === "string") return prompt;
  return "";
}

/**
 * 让 harness 事件处理器真正跑完。
 *
 * runtime 的 `subscribe()` 把 handler 放进 `Promise.resolve().then(...)`（避免事件回调里
 * 抛出的异常影响内核），所以 emit 之后同步断言会**早于**处理 —— 那样断言恒真、测试是空的。
 */
async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("send 的并发闸门", () => {
  it("并发两次 send：第二次转排队，不会中止第一次的运行", async () => {
    resetHarness();
    /**
     * 精确制造竞态：挡住第一个 send 的 getSettings。
     *
     * 这才是真实的窗口 —— `running` 要到 applyModel / applyThinkingLevel 之后才置真，
     * 而那两个 await 之前 `running` 一直是 false。旧实现下第二个 send 会在这里
     * 看到 running === false，于是自己也开始一轮，最终把第一个 abort 掉。
     */
    let releaseSettings = (): void => undefined;
    harness.settingsGate.wait = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });

    const runtime = makeRuntime();
    const first = runtime.send("s1", "第一条");
    // 等第一个 send 进到 getSettings（说明它已进入临界区、但 running 还没置真）
    await vi.waitFor(() => expect(harness.settingsCalls).toBeGreaterThan(0));

    // 关键：此刻第二个 send 进来。闸门必须让它转排队，而不是再开一轮。
    harness.settingsGate.wait = null;
    const second = runtime.send("s1", "第二条");
    releaseSettings();

    await first;
    await second;

    // 两次都留在同一条运行里：prompt 只被调用一次（第二条进了 followUp）
    expect(harness.calls.prompts).toEqual(["第一条"]);
    // 且没有任何 abort —— 旧实现会在这里 abort 掉第一条
    expect(harness.calls.aborts).toBe(0);

    await runtime.dispose();
  });

  it("顺序两次 send（第一次已跑完）不会被误判为并发", async () => {
    resetHarness();
    const runtime = makeRuntime();
    await runtime.send("s1", "第一条");
    await runtime.send("s1", "第二条");
    expect(harness.calls.prompts).toEqual(["第一条", "第二条"]);
    expect(harness.calls.aborts).toBe(0);
    await runtime.dispose();
  });

  it("运行中 send 转排队：不再打第二次 prompt", async () => {
    resetHarness();
    let release = (): void => undefined;
    harness.gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runtime = makeRuntime();
    const first = runtime.send("s1", "跑着的");
    await vi.waitFor(() => expect(harness.calls.prompts).toEqual(["跑着的"]));

    // 此时 running 已为 true：第二次 send 走排队
    const second = runtime.send("s1", "排队的");
    await second;
    expect(harness.calls.prompts).toEqual(["跑着的"]);
    // 排队的消息进了 lane 的 followUp（假实现只记 prompt，所以这里只断言没再 prompt）

    harness.gate.wait = null;
    release();
    await first;
    await runtime.dispose();
  });
});

describe("陈旧 run_end 不能翻转新一轮", () => {
  it("上一轮的 run_end 迟到时被丢弃，新一轮仍是 running", async () => {
    resetHarness();
    const runtime = makeRuntime();

    // 第一轮：prompt 被 gate 挡住，于是它停在「运行中」
    let release = (): void => undefined;
    harness.gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runtime.send("s1", "第一轮");
    await vi.waitFor(() => expect(harness.calls.prompts).toEqual(["第一轮"]));
    // 内核为第一轮生成 id —— 这是 run_end 会带回来的那个值（不是本地 UUID）
    harness.emit("run_start", { type: "run_start", runId: "kernel-1", startedAt: Date.now() });
    await flushEvents();
    expect(runtime.isRunning("s1")).toBe(true);

    // 用户点停止：UI 立刻脱离 running，但 lane.abort() 很慢（prompt 还挂着）
    await runtime.stop("s1");
    expect(runtime.isRunning("s1")).toBe(false);

    // abort 终于收敛，第一轮的 prompt 返回 → send 的 finally 回收运行态
    harness.gate.wait = null;
    release();
    await first;

    // 用户随即发出第二轮：先架好 gate，让它停在「运行中」
    let release2 = (): void => undefined;
    harness.gate.wait = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    const second = runtime.send("s1", "第二轮");
    await vi.waitFor(() => expect(harness.calls.prompts).toEqual(["第一轮", "第二轮"]));
    // 内核为第二轮生成新 id
    harness.emit("run_start", { type: "run_start", runId: "kernel-2", startedAt: Date.now() });
    await flushEvents();
    expect(runtime.isRunning("s1")).toBe(true);

    // 现在第一轮那次 abort 的 run_end 迟到抵达 —— 带的是**第一轮**的内核 id
    harness.emit("run_end", { type: "run_end", runId: "kernel-1", status: "aborted" });
    await flushEvents();

    // 关键断言：新一轮不能被这条陈旧事件翻成「未运行」
    expect(runtime.isRunning("s1")).toBe(true);

    // 而第二轮自己的 run_end 必须生效（否则会话永远挂在 running）
    harness.emit("run_end", { type: "run_end", runId: "kernel-2", status: "completed" });
    await flushEvents();
    expect(runtime.isRunning("s1")).toBe(false);

    harness.gate.wait = null;
    release2();
    await second;
    await runtime.dispose();
  });

  it("本轮自己的 run_end 照常收尾（别把正常路径一起挡掉）", async () => {
    resetHarness();
    let release = (): void => undefined;
    harness.gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runtime = makeRuntime();
    const first = runtime.send("s1", "跑一轮");
    await vi.waitFor(() => expect(harness.calls.prompts).toEqual(["跑一轮"]));
    expect(runtime.isRunning("s1")).toBe(true);

    // 不带 runId 的 run_end：无从判断身份，按「正常收尾」处理（宽松侧）
    harness.emit("run_end", { type: "run_end", status: "completed" });
    await flushEvents();
    expect(runtime.isRunning("s1")).toBe(false);

    harness.gate.wait = null;
    release();
    await first;
    await runtime.dispose();
  });

  /**
   * **本轮自己的 run_end 必须带内核的 runId**，而不是本地生成的那个。
   *
   * 真实内核的 `run_start` / `run_end` 各自携带**内核自己**的 runId
   *（见 pi-agent-core 的 agent-harness.d.ts，两者都是必填 string）。
   * 而本仓在 send 里另生成了一个 randomUUID 存进 runtime.runId ——
   * 若拿它去和内核事件比，两者永远不等，于是**每一条正常 run_end 都会被当成陈旧事件丢掉**：
   * UI 会一直转圈、队列不清、标题不生成。
   *
   * 这条用一个与本地 UUID 不同的 runId 模拟内核，钉住「正常收尾不能被误丢」。
   */
  it("内核自己的 runId 送达时不能被误判为陈旧（否则永远无法收尾）", async () => {
    resetHarness();
    let release = (): void => undefined;
    harness.gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runtime = makeRuntime();
    const first = runtime.send("s1", "跑一轮");
    await vi.waitFor(() => expect(harness.calls.prompts).toEqual(["跑一轮"]));
    expect(runtime.isRunning("s1")).toBe(true);

    // 模拟真实内核：先发 run_start（带内核的 runId），再发 run_end（同一个 id）
    harness.emit("run_start", { type: "run_start", runId: "kernel-run-1", startedAt: Date.now() });
    await flushEvents();
    harness.emit("run_end", { type: "run_end", runId: "kernel-run-1", status: "completed" });
    await flushEvents();

    // 关键断言：这是本轮的正常收尾，必须生效
    expect(runtime.isRunning("s1")).toBe(false);

    harness.gate.wait = null;
    release();
    await first;
    await runtime.dispose();
  });
});

/**
 * `stop()` 之后立刻 `send()` 不能与尚未收敛的 abort 抢同一条 lane。
 *
 * `stop()` 为了「点了停止立刻响应」而在 await 那次**很慢的** `lane.abort()` 之前
 * 就把 `running` 置为 false（见其注释）。但那次 send 仍占着闸门（`sending === true`），
 * 于是存在一个窗口：`running === false` 且 `sending === true`、abort 还在飞。
 *
 * 这个用例钉住：这个窗口里进来的 send 应该是**排队**，而不是另开一轮去和
 * 正在收敛的 lane 抢（那会触发 LaneBusy → abortStaleOperation → 把别人的活中止掉，
 * 正是闸门本要消除的形态）。
 */
describe("stop 与 send 的窗口", () => {
  it("stop() 之后立刻 send：不得与未收敛的 abort 抢 lane", async () => {
    resetHarness();
    // prompt 也停住：让这一轮真的「在运行中」，而不是立刻跑完
    let releasePrompt = (): void => undefined;
    harness.gate.wait = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    // abort 故意卡住：模拟「正在跑的工具没有中断通道」导致收敛很慢
    let releaseAbort = (): void => undefined;
    harness.abortGate.wait = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });

    const runtime = makeRuntime();
    const first = runtime.send("s1", "第一轮");
    await vi.waitFor(() => expect(harness.calls.prompts).toEqual(["第一轮"]));
    expect(runtime.isRunning("s1")).toBe(true);

    // 点停止：running 立刻 false，但 abort 还没收敛
    const stopping = runtime.stop("s1");
    await vi.waitFor(() => expect(harness.calls.aborts).toBe(1));
    expect(runtime.isRunning("s1")).toBe(false);

    // 窗口内再发一条
    const second = runtime.send("s1", "第二轮");
    await second;

    // 关键断言：不得出现第二次 prompt —— 那次 abort 尚未收敛，
    // 另开一轮只会撞上 LaneBusy 并触发「清理后重发」的中止路径。
    expect(harness.calls.prompts).toEqual(["第一轮"]);

    // 放行 abort 与 prompt，收尾
    harness.abortGate.wait = null;
    releaseAbort();
    await stopping;
    harness.gate.wait = null;
    releasePrompt();
    await first;
    await runtime.dispose();
  });
});

/**
 * 系统提示必须**真的交给内核**，以及模式切换怎么影响它。
 *
 * 为什么单独一组：这里曾经有一个完全不报错的缺口 —— `buildSystemPrompt` 算出了
 * 整段提示（身份 / 工具指导 / 技能索引 / AGENTS.md / 子智能体清单 / 委派规则），
 * 但 `AgentHarness.create` 从没收到 `systemPrompt`，那段字符串只被拿去估了个 token 数。
 * 内核在缺省时返回空串，于是**模型没有任何系统提示**，而所有既有测试都绿 ——
 * 因为它们只测 `buildSystemPrompt` 的返回值，没人检查它有没有被传下去。
 *
 * 所以这一组的第一个用例断言的是「**传下去了**」，而不是「内容对」。
 */
describe("系统提示的投递与模式", () => {
  beforeEach(() => {
    resetHarness();
  });

  it("create 收到的是函数形式的 systemPrompt，且求值出真实内容", async () => {
    const runtime = makeRuntime();
    await runtime.send("s1", "嗨");

    const last = harness.calls.createOptions.at(-1) as { systemPrompt?: unknown } | undefined;
    // 函数形式是刻意的：内核每个 generation 现算，于是切模式下一轮就生效
    expect(typeof last?.systemPrompt).toBe("function");

    const prompt = await resolveSystemPrompt();
    expect(prompt).toContain("Oint");
    expect(prompt.length).toBeGreaterThan(100);

    await runtime.dispose();
  });

  it("智能体模式（设置默认）：不注入委派路由段，但仍有子智能体索引", async () => {
    const runtime = makeRuntime({ defaultMode: "standard" });
    await runtime.send("s1", "嗨");

    const prompt = await resolveSystemPrompt();

    expect(prompt).toContain("通用助手");
    expect(prompt).not.toContain("## 委派（子智能体）");

    await runtime.dispose();
  });

  it("编排者模式（会话级绑定）：注入委派路由段", async () => {
    const runtime = makeRuntime({ defaultMode: "standard", sessionMode: "orchestrate" });
    await runtime.send("s1", "嗨");

    const prompt = await resolveSystemPrompt();

    expect(prompt).toContain("编排者");
    expect(prompt).toContain("## 委派（子智能体）");

    await runtime.dispose();
  });

  it("会话级绑定优先于设置里的默认", async () => {
    // 设置默认编排，但会话显式绑定了标准 → 用标准
    const runtime = makeRuntime({ defaultMode: "orchestrate", sessionMode: "standard" });
    await runtime.send("s1", "嗨");

    const prompt = await resolveSystemPrompt();

    expect(prompt).toContain("通用助手");
    expect(prompt).not.toContain("编排者");

    await runtime.dispose();
  });

  /**
   * 函数形式的意义就在这条：**不必重建 harness**，下一次求值就是新模式。
   *
   * 这里直接换掉存储替身背后的值再求值一次 —— 真实路径上那是
   * `sessions:set-mode` 写索引，发生在两次 send 之间。
   */
  it("切换模式后同一个 harness 的提示跟着变（下一次请求即生效）", async () => {
    let mode: "standard" | "orchestrate" = "standard";
    const settings = makeSettings({ agentMode: "standard" });
    const runtime = createChatRuntime({
      getSettings: async () => settings,
      sessionStore: {
        ...(makeSessionStore() as object),
        readAgentMode: async () => mode,
      } as unknown as SessionStore,
      emit: () => undefined,
      approvals: createApprovalService({
        getSettings: async () => settings,
        emit: () => undefined,
      }),
      resolveWorkingDir: async () => process.cwd(),
    });

    await runtime.send("s1", "嗨");
    const before = await resolveSystemPrompt();
    expect(before).not.toContain("## 委派（子智能体）");

    // 用户在 chip 上切到编排者模式（真实路径：sessions:set-mode 写会话索引）
    mode = "orchestrate";
    const after = await resolveSystemPrompt();

    expect(after).toContain("## 委派（子智能体）");
    // 同一个 harness：create 只发生过一次
    expect(harness.calls.createOptions).toHaveLength(1);

    await runtime.dispose();
  });
});

/**
 * 重复调用守卫的**接线**（P0.5）。
 *
 * `repeat-guard.test.ts` 测的是纯逻辑（阈值、键排序、排除名单），
 * 但「它有没有被挂上、结果有没有真的进上下文」是另一回事 ——
 * 这一类「算出来了但没接上」的缺口在本仓真实发生过（系统提示没传给内核），
 * 而且两者都不会报错。所以这里直接触发钩子，断言端到端的效果。
 */
describe("重复调用守卫的接线", () => {
  beforeEach(() => {
    resetHarness();
  });

  /** 连续用同一组参数触发 after_tool，返回最后一次的判定 */
  async function repeatCall(times: number, tool = "read", args: Record<string, unknown> = {}) {
    let last: unknown;
    for (let index = 0; index < times; index += 1) {
      last = await harness.fireHook("after_tool", {
        toolCallId: `c${index}`,
        toolName: tool,
        args,
        isError: false,
      });
    }
    return last;
  }

  it("守卫真的挂上了 after_tool 与 transform_context", async () => {
    const runtime = makeRuntime();
    await runtime.send("s1", "嗨");

    // 三个钩子：权限门（before_tool）+ 守卫的两半
    expect([...harness.hooks.keys()].sort()).toEqual([
      "after_tool",
      "before_tool",
      "transform_context",
    ]);

    await runtime.dispose();
  });

  it("连续 3 次相同调用后，纠正消息真的进了下一次请求", async () => {
    const runtime = makeRuntime();
    await runtime.send("s1", "嗨");

    await repeatCall(3, "read", { path: "a.ts" });

    const result = (await harness.fireHook("transform_context", {
      messages: [{ role: "user", content: "原始消息" }],
      systemPrompt: "s",
    })) as { messages: { role: string; customType?: string; content: unknown }[] } | undefined;

    expect(result).toBeDefined();
    // 原有的消息保留，纠正消息追加在最后
    expect(result?.messages).toHaveLength(2);
    expect(result?.messages[0]).toMatchObject({ role: "user", content: "原始消息" });
    const injected = result?.messages[1];
    // custom 会被内核转成 user 角色（模型看得见），而 message-mapper 忽略它（用户看不见）
    expect(injected?.role).toBe("custom");
    expect(injected?.customType).toBe("repeat-notice");
    expect(JSON.stringify(injected?.content)).toContain("read");

    await runtime.dispose();
  });

  it("第 3 次之前不注入任何东西（不打扰正常会话）", async () => {
    const runtime = makeRuntime();
    await runtime.send("s1", "嗨");

    await repeatCall(2, "read", { path: "a.ts" });

    const result = await harness.fireHook("transform_context", {
      messages: [{ role: "user", content: "原始消息" }],
      systemPrompt: "s",
    });
    // 处理器没暂存任何东西时应当什么都不返回（内核据此保持原样）
    expect(result).toBeUndefined();

    await runtime.dispose();
  });

  it("注入一次之后槽位清空：提醒不会跟着整段历史一直重复", async () => {
    const runtime = makeRuntime();
    await runtime.send("s1", "嗨");

    await repeatCall(3, "read", { path: "a.ts" });
    const first = await harness.fireHook("transform_context", {
      messages: [],
      systemPrompt: "s",
    });
    const second = await harness.fireHook("transform_context", {
      messages: [],
      systemPrompt: "s",
    });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();

    await runtime.dispose();
  });

  /** 计划里的验收项：「用户新消息归零」——前提变了，重复旧调用可能是对的 */
  it("用户发新消息后链归零：同样的调用要重新数 3 次", async () => {
    const runtime = makeRuntime();
    await runtime.send("s1", "第一轮");
    await repeatCall(2, "read", { path: "a.ts" });

    // 用户说了新话 → 链清空（否则上一轮的 2 次会算进来，第 3 次就误报）
    await runtime.send("s1", "第二轮");
    await repeatCall(2, "read", { path: "a.ts" });

    const result = await harness.fireHook("transform_context", {
      messages: [],
      systemPrompt: "s",
    });
    expect(result).toBeUndefined();

    // 再补一次才到 3
    await repeatCall(1, "read", { path: "a.ts" });
    const after = await harness.fireHook("transform_context", { messages: [], systemPrompt: "s" });
    expect(after).toBeDefined();

    await runtime.dispose();
  });

  it("穿插 todo 不打断链（整表替换会合法地反复调用）", async () => {
    const runtime = makeRuntime();
    await runtime.send("s1", "嗨");

    await repeatCall(1, "read", { path: "a.ts" });
    await repeatCall(2, "todo", { todos: [] });
    await repeatCall(1, "read", { path: "a.ts" });
    await repeatCall(3, "todo", { todos: [] });
    await repeatCall(1, "read", { path: "a.ts" });

    const result = await harness.fireHook("transform_context", { messages: [], systemPrompt: "s" });
    expect(result).toBeDefined();

    await runtime.dispose();
  });

  /** 硬档：终止这次运行，并把原因写在运行记录上（让终态能说清「这是异常」） */
  it("连续 5 次相同调用会终止运行", async () => {
    const runtime = makeRuntime();
    await runtime.send("s1", "嗨");

    await repeatCall(5, "read", { path: "a.ts" });

    // stop 是 fire-and-forget 的，等它落定
    await vi.waitFor(() => expect(runtime.isRunning("s1")).toBe(false));

    await runtime.dispose();
  });
});
