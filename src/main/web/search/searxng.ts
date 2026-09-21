// SearXNG provider：免 Key，默认选项。
//
// 请求形状（SearXNG 的 JSON API）：
//   GET {instance}/search?q={query}&format=json&pageno=1
// 响应（实测 2026-09-21，search.thejot.org）：
//   { query, results: [{ title, url, content, publishedDate, engine, … }],
//     answers: string[], unresponsive_engines: [], … }
//
// 三个实测要点（都已在下面处理）：
//   1. `publishedDate` 字段**存在但常常是 null**（不是缺失）——
//      不能只判断 undefined，否则会把 null 序列化进 details；
//   2. `number_of_results` 不存在 —— 不要依赖它，只信 results.length；
//   3. `unresponsive_engines` 非空**不是错误**（聚合搜索里部分引擎失败是常态），
//      但值得回报给模型，否则结果少时它会以为「网上就只有这些」。
//
// ## 逐实例回退（顺序、有限、可解释）
//
// 公共实例会**被上游搜索引擎限流**，而且不同实例的限流时间不同 ——
// 实测同一个实例连着查四次，可能前三次 20 条、第四次 0 条。
// 「只用第一个实例、失败就报错」会让一条本来能答的问题直接失败。
//
// 所以这里**按清单顺序逐个试**，但三条边界让它与「随机回退」有本质区别：
//   1. 清单是**有限的、写在设置里的**，用户在界面上看得到（不是 60+ 个隐藏候选）；
//   2. 顺序**确定**（不 shuffle）：同一个查询的可复现性得以保留，
//      出问题时「试过哪些实例、各自什么错」是可复述的；
//   3. 实际命中的实例**回报在 details 里**，用户能看见是谁答的。
//
// 这与参考实现（dreamagent）的差别正在后两点：它随机打散 60+ 实例，
// 故障因此不可复现；而它的回退又是静默的。
//
// 自定义实例清单同样适用这套回退，但**自定义优先**：用户写的排在前面。

import type { WebSearchSettings, WebSource } from "@/shared/contracts/web";
import { asString, type HttpJsonFn, httpJson, httpStatusError, toProviderError } from "../http";
import { parseInstanceList } from "../searxng-instances";
import type {
  WebProviderSearchRequest,
  WebProviderSearchResult,
  WebSearchProviderImpl,
} from "../types";
import { WebError } from "../types";

/** SearXNG 单次请求超时：比其它 provider 短一点，因为实例质量不可控 */
const SEARXNG_TIMEOUT_MS = 12_000;

/**
 * 一次调用最多试几个实例。
 *
 * 不用「试完整个清单」：清单可以很长（用户可能填几十个），
 * 每次都试完会让一次检索在全部实例都挂掉时耗时几十秒。
 * 3 个是「足以跨过一次常见限流、又不至于等到用户以为卡死」的折中。
 */
const MAX_INSTANCE_ATTEMPTS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `results[]` 的一项 → WebSource；没有 URL 的条目丢弃（对模型无用） */
function toSource(item: unknown): WebSource | undefined {
  if (!isRecord(item)) return undefined;
  const url = asString(item.url);
  if (url === undefined) return undefined;
  const title = asString(item.title);
  const snippet = asString(item.content);
  // publishedDate 常见为 null，asString 已把非字符串收成 undefined
  const publishedAt = asString(item.publishedDate) ?? asString(item.pubdate);
  return {
    url,
    ...(title === undefined ? {} : { title }),
    ...(snippet === undefined ? {} : { snippet }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

export interface SearxngProviderOptions {
  /** 注入点：单测替换成不发真实请求的实现 */
  http?: HttpJsonFn;
  /** 注入点：实例清单来源（默认取设置里的 searxng.instances） */
  resolve?: () => WebSearchSettings;
}

/** 一次实例尝试的结果：失败时只回报原因，由调用方汇总 */
type InstanceAttempt =
  | { ok: true; result: WebProviderSearchResult }
  | { ok: false; instance: string; reason: string };

export function createSearxngProvider(options: SearxngProviderOptions = {}): WebSearchProviderImpl {
  const http = options.http ?? httpJson;
  const resolve = options.resolve;

  /** 向单个实例发起一次检索；失败时返回原因而不是抛（调用方要汇总多个实例的失败） */
  async function attempt(
    instance: URL,
    request: WebProviderSearchRequest,
  ): Promise<InstanceAttempt> {
    const url = new URL("/search", instance);
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageno", "1");

    let response: Awaited<ReturnType<HttpJsonFn>>;
    try {
      response = await http({
        url: url.toString(),
        timeoutMs: SEARXNG_TIMEOUT_MS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      // 调用方取消：不再试别的实例，直接把取消抛出去
      if (error instanceof WebError && error.code === "WEB_ABORTED") throw error;
      return {
        ok: false,
        instance: instance.host,
        reason: toProviderError("SearXNG", error).message,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        instance: instance.host,
        reason: httpStatusError("SearXNG", response.status, response.json).message,
      };
    }

    /**
     * `results` 缺失有两种可能，值得分开说：
     *   · 实例未开启 JSON 输出（回的是 HTML 页面，JSON.parse 失败）；
     *   · 开了 JSON 但结构不同（极少）。
     * 两者的处置建议都是「换一个实例」，但把原因说清能让用户判断
     * 是「这个实例不行」还是「我的配置写错了」。
     */
    if (!isRecord(response.json) || !Array.isArray(response.json.results)) {
      const looksLikeHtml = response.text.trimStart().startsWith("<");
      return {
        ok: false,
        instance: instance.host,
        reason: looksLikeHtml
          ? "未开启 JSON 输出（实例的 search.formats 里需要包含 json）"
          : "响应里没有 results 字段",
      };
    }

    const sources: WebSource[] = [];
    const seen = new Set<string>();
    for (const item of response.json.results) {
      const source = toSource(item);
      if (source === undefined || seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push(source);
    }

    const unresponsive = Array.isArray(response.json.unresponsive_engines)
      ? response.json.unresponsive_engines.length
      : 0;

    /**
     * **空结果算失败，继续试下一个实例。**
     *
     * 公共实例被限流时的表现正是「HTTP 200 + results: []」——
     * 它长得像「真的没搜到」，但其实是这个实例查不动了。
     * 判据在 `unresponsive_engines`：非空说明是引擎侧的问题而不是真的没有结果。
     *
     * 这不等于「空结果一定不可信」：一个确实没有结果的生僻查询，
     * 在几个实例上都会是空的 —— 所以「所有实例都空」时仍然按**正常空结果**处理，
     * 只是多花了几次请求。
     */
    if (sources.length === 0) {
      return {
        ok: false,
        instance: instance.host,
        reason:
          unresponsive > 0
            ? `返回 0 条（${unresponsive} 个上游引擎被限流或无响应）`
            : "返回 0 条结果",
      };
    }

    const answers = Array.isArray(response.json.answers)
      ? response.json.answers.filter((answer): answer is string => typeof answer === "string")
      : [];

    return {
      ok: true,
      result: {
        sources,
        // 服务层会用设置里的上限再截一次；这里先按请求的上限收一遍，少传数据
        truncated: sources.length > request.maxResults,
        instance: instance.origin,
        ...(answers.length === 0 ? {} : { answer: answers.join("\n") }),
        ...(unresponsive === 0 ? {} : { unresponsive }),
      },
    };
  }

  return {
    id: "searxng",
    // 免 Key，永远可用 —— 实例不可达是**执行期**的错误，不是可用性问题
    available: () => true,

    async search(request: WebProviderSearchRequest): Promise<WebProviderSearchResult> {
      const settings = resolve?.();
      const instances = parseInstanceList(settings?.searxng.instances);
      if (instances.length === 0) {
        throw new WebError(
          "没有可用的 SearXNG 实例，请在「设置 → 网络搜索」中填写。",
          "WEB_PROVIDER_UNAVAILABLE",
        );
      }

      const failures: { instance: string; reason: string }[] = [];
      for (const instance of instances.slice(0, MAX_INSTANCE_ATTEMPTS)) {
        const outcome = await attempt(instance, request);
        if (outcome.ok) return outcome.result;
        failures.push({ instance: outcome.instance, reason: outcome.reason });
      }

      /**
       * 全部尝试都失败时的文案：**把每个实例的原因都列出来**。
       *
       * 只说一句「搜索失败」会让用户无从下手；列出「哪个实例、为什么」之后，
       * 「三个都被限流了，等一会儿再试」与「三个都没开 JSON，去换个实例或自建」
       * 是两种一眼可辨的情况。
       */
      const detail = failures.map((item) => `${item.instance}：${item.reason}`).join("；");
      throw new WebError(
        `SearXNG 检索失败（已尝试 ${failures.length} 个实例）—— ${detail}。` +
          "可在「设置 → 网络搜索」中更换实例，或填写自建实例。",
        "WEB_PROVIDER_ERROR",
      );
    },
  };
}
