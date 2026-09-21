// 生产环境的 web 能力装配点。
//
// 这是唯一把「五个 provider + 抓取后端 + 设置」拼起来的地方：
//   · runtime 只依赖 WebService 接口（见 types.ts）；
//   · 单测自己拼假实现（见 service.test.ts），不走这里。
//
// 为什么单独一个文件而不是写在 main/index.ts：装配涉及四个模块的依赖方向
// （搜索 provider 需要 resolve thunk、抓取后端需要超时配置），
// 放在入口文件里会让「入口」同时承担「组装细节」，也让它难以被单独测试。

import type { Settings } from "@/shared/contracts/settings";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  type WebSearchProvider,
  type WebSearchSettings,
} from "@/shared/contracts/web";
import { createHttpFetchProvider } from "./fetch-http";
import { createApiProviders } from "./search/providers";
import { createSearxngProvider } from "./search/searxng";
import { createDefaultWebService } from "./service";
import type { WebSearchProviderImpl, WebService } from "./types";

export interface ProductionWebServiceOptions {
  /**
   * 读取当前设置。
   *
   * **每次调用现取**：设置改完立即生效，不需要重建 service、也不需要重连任何东西。
   * 这正是把配置做成 thunk 而不是构造参数的原因（与 dsh 的 resolve thunk 同款）。
   */
  getSettings: () => Promise<Settings>;
}

/**
 * 装配真实的 WebService。
 *
 * 抓取超时取自设置（`webSearch.fetchTimeoutMs`），所以它也必须**每次现取** ——
 * 在构造时固定下来的话，用户在设置里改超时要重启应用才生效。
 */
export function createProductionWebService(options: ProductionWebServiceOptions): WebService {
  /**
   * 同步快照。
   *
   * provider 的 `resolve` 是同步签名（`available()` 不能 await），而设置读取是异步的，
   * 所以这里维护一份缓存：每次 search/fetch 之前刷新，provider 读快照。
   *
   * 「还没加载过就抛错」而不是用一份猜测的默认值：用默认值会让
   * 「用户明明配了 Tavily」却静默走了 SearXNG，且没有任何提示。
   */
  let current: WebSearchSettings | undefined;

  const refresh = async (): Promise<WebSearchSettings> => {
    current = (await options.getSettings()).webSearch;
    return current;
  };

  const resolveSettings = (): WebSearchSettings => {
    if (current === undefined) {
      throw new Error("web 设置尚未加载：search/fetch 之前会先刷新一次");
    }
    return current;
  };

  const providerOptions = { resolve: resolveSettings };
  const searchProviders: Record<WebSearchProvider, WebSearchProviderImpl> = {
    searxng: createSearxngProvider(providerOptions),
    ...createApiProviders(providerOptions),
  };

  const service = createDefaultWebService({
    resolve: resolveSettings,
    searchProviders,
    // 抓取超时每次现取：见上面的说明
    fetchProvider: {
      fetch: (request) =>
        createHttpFetchProvider({ timeoutMs: resolveSettings().fetchTimeoutMs }).fetch(request),
    },
  });

  return {
    ...service,
    search: async (request) => {
      // 每次调用前刷新一次设置：让「改完设置立即生效」这条承诺成立
      await refresh();
      return service.search(request);
    },
    fetch: async (request) => {
      await refresh();
      return service.fetch(request);
    },
    /**
     * 抓取正文上限。
     *
     * 这一条让设置里的 `fetchMaxOutputChars` 真的生效（此前它被存下来、
     * 在面板上显示，却没有任何消费者 —— 一个只存在于界面上的死字段）。
     *
     * **必须先 refresh**：`resolveSettings` 读的是一份缓存快照，
     * 不刷新就直接读会拿到陈旧值（第一次甚至是"尚未加载"）。
     * 与 search/fetch 是同一条纪律 —— 每次调用前刷新，改完设置立即生效。
     */
    fetchOutputLimit: async () => {
      try {
        return (await refresh()).fetchMaxOutputChars;
      } catch {
        // 设置读取失败：回落到默认值，而不是让工具调用抛错
        return DEFAULT_WEB_SEARCH_SETTINGS.fetchMaxOutputChars;
      }
    },
  };
}
