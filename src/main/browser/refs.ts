// ref 模型 v2（docs/browser-automation-refactor.md §3）：**一个 ref 只对应一个元素节点，永不复用**。
//
// 单独抽一个**不依赖 electron** 的模块，是因为这里装的是整个浏览器自动化的核心不变式，
// 而它同时被两处使用：注入脚本（页面侧怎么发号）与服务侧（这次动作该不该放行）。
// 判定逻辑必须能在 node 下单测 —— 它是「点错元素」这类事故唯一的防线。
//
// 旧设计（快照复用页面上的 `data-oint-ref` 属性）有两个实测事故：
//   ① 新元素拿到旧编号：旧编号只增不减地复用，列表重排后同一个 "e12" 指向了另一个节点，
//      动作静默落到新元素上（**ref 静默错点**，模型完全看不出来，因为它问的是同一句话）；
//   ② 属性由页面决定：`data-oint-ref` 可以被页面自己占用、也可以随节点复用残留，
//      而我们按属性值找元素，于是「快照里是 A、动作打到 B」在页面侧就已经发生了。
// 新设计把权威搬到页面侧的 `window.__ointEls`（Map<ref, Element>）与 `window.__ointUid`
// （WeakMap<Element, ref>）：编号只由我们发、只发一次，DOM 稳定时同一个节点拿回同一个编号
// （保留「快照 → 点 → 再快照」里编号不漂移的旧优点）。
//
// 三类失败各有各的下一步动作，所以刻意分成三个错误码：
//   UNKNOWN_REF —— ref 不是我们发过的（模型编造 / 格式不合法）→ 重新 snapshot；
//   STALE_REF   —— 曾经有效但元素已从 DOM 移除（页面重渲染）→ 重新 snapshot；
//   REF_DRIFT   —— 元素还在，但语义与快照记录的不一致（节点被框架复用）→ 重新 snapshot 并核对。

import type { BrowserErrorCode } from "@/shared/contracts/browser";

/** 合法 ref 的形状：`e` + 自增序号。格式不合法的一律按「模型编造」处理 */
const WELL_FORMED_REF = /^e\d+$/;

/** 服务侧 ref 账本的上限：长期会话 + 无限滚动页面会让见过的 ref 无限增长，只留最近的 */
const MAX_TRACKED_REFS = 4000;

/** ref 是否合法（`e12`）。不合法就不必去问页面 —— 一定是编造的 */
export function isWellFormedRef(ref: string): boolean {
  return WELL_FORMED_REF.test(ref);
}

/**
 * 注册表被重置的原因：页面 / guest 被重建、导航到新文档、面板重挂载。
 *
 * 为什么需要这个标志：清空账本之后，「e1 是两次前的快照发的」与「e1 是编造的」
 * 在账本里长得一模一样（都查不到），而两者的下一步动作虽然都是重新 snapshot，
 * 但**事实**必须说对 —— 面板中途重建后拿旧 ref 报「从未出现在任何快照里」，
 * 等于告诉模型它在编造编号，这是谎报（实测真机报告的 P3）。
 */
export type RefRegistryResetReason = "guest" | "document";

/** 各原因在文案里的人话写法 */
const RESET_REASON_TEXT: Record<RefRegistryResetReason, string> = {
  guest: "页面被重建",
  document: "页面已导航到新文档",
};

/**
 * UNKNOWN_REF 的两种文案（纯函数，便于单测）：
 *   · `resetReason` 非空 —— 账本**刚刚被重置过**（页面/guest 重建、导航到新文档）：
 *     这个编号很可能来自重置前的快照，说清「之前的快照已失效」；
 *   · `resetReason` 为空 —— 编号从未出现在任何一次快照里：指出它可能是编造的
 *     或来自更早的会话，而不是把「刚才那次快照的 ref」误报成「最近一次快照」。
 */
export function unknownRefMessage(ref: string, resetReason: RefRegistryResetReason | null): string {
  if (resetReason !== null) {
    return `ref ${ref}：之前的快照因${RESET_REASON_TEXT[resetReason]}而失效，请重新 snapshot。`;
  }
  return (
    `ref ${ref} 从未出现在任何快照里（可能是编造或来自更早的会话）。` +
    "请先 browser_snapshot 拿到当前页面的 ref。"
  );
}

/** 签名的四个组成部分；缺省一律当空串，免得 undefined 把签名写成 "undefined" */
export interface ElementSignatureInfo {
  role?: string;
  tag?: string;
  type?: string;
  name?: string;
}

/**
 * 元素签名 `role|tag|type|name`：快照时记一份，动作时再算一份，两者不一致说明
 * 「这个编号现在指的是别的语义」（节点被复用）。
 *
 * 为什么不用更细的指纹（textContent / class / 属性全集）：那些东西页面自己一直在改
 *（计数器、时间戳、哈希 class），任何一次正常重渲染都会变成 REF_DRIFT，
 * 于是模型学到的是「这条报错可以忽略」—— 那比不校验更糟。四个稳定维度足够区分
 * 「同一个按钮」与「列表重排后换成了另一个按钮」。
 *
 * 注意 `name` 的口径：页面侧用的是**稳定标签**（aria-label / aria-labelledby /
 * placeholder / label[for] / title），刻意**不含当前输入值** —— 把值算进签名的话，
 * 「输入完再点一次同一个字段」会因为值变了而被误判成 REF_DRIFT，而那是模型最常走的序列。
 */
export function elementSignature(info: ElementSignatureInfo): string {
  return [info.role, info.tag, info.type, info.name].map(signaturePart).join("|");
}

/** 每个部分都做同一套归一：折叠空白 + 去首尾，避免 HTML 里的换行造成假 drift */
function signaturePart(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** 一次 ref 校验的结论：通过，或带错误码与可执行建议的失败 */
export type RefCheck = { ok: true } | { ok: false; code: BrowserErrorCode; message: string };

/**
 * 服务侧的 ref 账本：记住每个 ref 在**最后一次被核对过**时的签名，以及它首次出现的代次。
 *
 * 为什么服务侧还要记一份（页面侧已经有 Map）：服务侧的这一份是**跨快照**的账本，
 * 它让「元素已经不在了」与「这个 ref 我从来没见过」能分开说 —— 前者要提示重新 snapshot，
 * 后者要指出模型在编造 ref。两者的下一步动作不同，混成一句话模型就只能瞎试。
 */
export class RefRegistry {
  /** ref → 签名（插入顺序即首次出现顺序，超上限时丢最早的） */
  private readonly signatures = new Map<string, string>();
  /** ref → 首次出现的快照代次（回给模型的 `since`） */
  private readonly firstSeen = new Map<string, number>();
  private currentGeneration = 0;
  /** 最近一次「账本被重置」的原因；从未重置过是 null（见 unknownRefMessage） */
  private resetReasonValue: RefRegistryResetReason | null = null;

  /** 当前快照代次：每次 snapshot 自增，元素上的 since 说明它属于哪一代 */
  get generation(): number {
    return this.currentGeneration;
  }

  /** 账本里记了多少个 ref（诊断 / 测试用） */
  get size(): number {
    return this.signatures.size;
  }

  /**
   * 记下「账本被重置」这个事实（原因一起记）。
   *
   * 调用点是所有会把页面/文档换掉的路径（换 guest、导航到新文档、渲染进程崩溃重建）——
   * 那些时刻账本被清空，之后拿旧 ref 动作时文案必须说「之前的快照已失效」，
   * 而不是把两次前的快照编号当成编造（真机报告的 P3 就是这一条）。
   *
   * 标志刻意**一直保留到下一次重置**：重置之后无论过了多少次快照，账本里都没有
   * 重置前那些编号的记录，「之前的快照已失效」对它们始终是事实。
   */
  markReset(reason: RefRegistryResetReason): void {
    this.resetReasonValue = reason;
  }

  /** 最近一次重置的原因；从未重置过是 null（诊断 / 测试用） */
  get resetReason(): RefRegistryResetReason | null {
    return this.resetReasonValue;
  }

  /** 开始一次快照：代次 +1 并返回它 */
  beginSnapshot(): number {
    this.currentGeneration += 1;
    return this.currentGeneration;
  }

  /**
   * 记录 / 更新一个 ref 的签名。
   *
   * 已经在账本里的 ref **不会刷新 since**（那是「它属于哪一代」的答案，不是「最近一次见到」），
   * 也不会改变插入顺序（超上限时丢的是最早出现的那个 ref，而不是最久没被提到的）。
   */
  note(ref: string, signature: string): void {
    if (!this.signatures.has(ref)) {
      this.firstSeen.set(ref, this.currentGeneration);
      if (this.signatures.size >= MAX_TRACKED_REFS) {
        const oldest = this.signatures.keys().next();
        if (oldest.done !== true) {
          this.signatures.delete(oldest.value);
          this.firstSeen.delete(oldest.value);
        }
      }
    }
    this.signatures.set(ref, signature);
  }

  /** 某个 ref 首次出现的快照代次；没记过则 undefined */
  since(ref: string): number | undefined {
    return this.firstSeen.get(ref);
  }

  /**
   * 只保留 `live` 里的 ref（页面侧 Map 会这样清理已移除的元素，防泄漏）。
   *
   * 服务侧刻意**不在每次快照时**调用它：账本一旦丢掉「元素已移除」的那个 ref，
   * 下一次动作就只能报 UNKNOWN_REF（「从未出现过」），而事实是它曾经有效 ——
   * 让模型以为是自己的错。真正该清的是「换了文档 / 换了 guest」这种场面。
   */
  pruneExcept(live: ReadonlySet<string>): void {
    for (const ref of [...this.signatures.keys()]) {
      if (live.has(ref)) continue;
      this.signatures.delete(ref);
      this.firstSeen.delete(ref);
    }
  }

  /**
   * 核对一次动作前的 ref。
   *
   * `sig` 是元素**当前**的签名；`null` 表示「页面里根本找不到这个 ref」
   * （页面侧的注册表里没有它，例如节点已被移除并被清理过，或页面已经导航走了）。
   * 两种 null 的含义完全不同，判定也就完全不同：
   *   · 账本里有这个 ref → 元素确实存在过、现在没了 → STALE_REF；
   *   · 账本里也没有       → 这个编号从来不是我们发的 → UNKNOWN_REF。
   */
  check(ref: string, sig: string | null): RefCheck {
    if (!isWellFormedRef(ref)) {
      return {
        ok: false,
        code: "UNKNOWN_REF",
        message:
          `ref ${JSON.stringify(ref)} 的格式不合法（合法形状是 e12 这种），` +
          "它不可能是快照给出来的。请先 browser_snapshot，用返回的 ref 再试。",
      };
    }
    const known = this.signatures.get(ref);
    if (sig === null) {
      if (known === undefined) {
        return {
          ok: false,
          code: "UNKNOWN_REF",
          message: unknownRefMessage(ref, this.resetReasonValue),
        };
      }
      return {
        ok: false,
        code: "STALE_REF",
        message:
          `ref ${ref} 曾经有效，但它指向的元素已经不在页面上了（页面重渲染或已导航）。` +
          "请重新 browser_snapshot，用新的 ref 再操作 —— 旧 ref 不会再恢复。",
      };
    }
    if (known === undefined) {
      return {
        ok: false,
        code: "UNKNOWN_REF",
        message: unknownRefMessage(ref, this.resetReasonValue),
      };
    }
    if (known !== sig) {
      return {
        ok: false,
        code: "REF_DRIFT",
        message:
          `ref ${ref} 指向的元素还在，但它的语义和快照记录的不一致：` +
          `快照里是「${describeSignature(known)}」，现在是「${describeSignature(sig)}」。` +
          "这个编号很可能被框架复用到了别的节点上（列表重排、条件渲染）。" +
          "请重新 browser_snapshot 核对后再操作 —— 按旧编号硬点可能点到别的东西上。",
      };
    }
    return { ok: true };
  }

  /** 清空账本（换文档 / 退出时用） */
  clear(): void {
    this.signatures.clear();
    this.firstSeen.clear();
  }
}

/** 签名的人可读写法：把 `role|tag|type|name` 的空位省掉，别让文案里出现一堆 `||` */
function describeSignature(signature: string): string {
  const parts = signature.split("|").filter((part) => part !== "");
  return parts.length === 0 ? "（无签名）" : parts.join(" ");
}
