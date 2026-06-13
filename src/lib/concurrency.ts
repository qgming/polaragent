// 通用并发控制辅助
// 用于把 Promise.all(...map(...)) 改为受控并发，避免 LLM、MCP、知识库等请求瞬间打满。

// 远程请求/进程密集型任务：并发过高容易触发 429 或系统资源瓶颈
export const REMOTE_CONCURRENCY = 2;

// 本地文件/配置 IO 任务：适度并发可提速，但也不应一次性打开过多句柄
export const LOCAL_IO_CONCURRENCY = 3;

export interface PMapOptions {
  concurrency?: number;
}

/**
 * 按指定并发度映射异步任务，保留输入顺序。
 * @param iterable 输入集合
 * @param mapper 每个元素映射为 Promise 的函数
 * @param options concurrency 控制最大并发，默认 2
 */
export async function pMap<T, U>(
  iterable: Iterable<T>,
  mapper: (item: T, index: number) => Promise<U> | U,
  options?: PMapOptions,
): Promise<U[]> {
  const items = Array.from(iterable);
  const results = new Array<U | undefined>(items.length);
  if (items.length === 0) {
    return results as U[];
  }

  const concurrency = Math.max(1, options?.concurrency ?? REMOTE_CONCURRENCY);
  let nextIndex = 0;
  let running = 0;
  let rejected = false;

  return new Promise((resolve, reject) => {
    function startNext() {
      if (rejected) return;
      if (nextIndex >= items.length && running === 0) {
        resolve(results as U[]);
        return;
      }

      while (running < concurrency && nextIndex < items.length) {
        const currentIndex = nextIndex++;
        running += 1;

        Promise.resolve()
          .then(() => mapper(items[currentIndex], currentIndex))
          .then(
            (value) => {
              results[currentIndex] = value;
            },
            (error) => {
              if (!rejected) {
                rejected = true;
                reject(error);
              }
            },
          )
          .finally(() => {
            running -= 1;
            startNext();
          });
      }
    }

    startNext();
  });
}
