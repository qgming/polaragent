// 通用并发控制辅助（CommonJS 版，主进程使用）

// 远程请求/进程密集型任务的最大并发
const REMOTE_CONCURRENCY = 2;

// 本地文件/配置 IO 任务的最大并发
const LOCAL_IO_CONCURRENCY = 3;

/**
 * 创建一个信号量执行器：同时最多只有 limit 个 fn 在执行，其余排队。
 * @param {number} limit 最大并发数
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>} 排队执行函数
 */
function withConcurrency(limit) {
  let running = 0;
  const queue = [];

  function next() {
    if (queue.length === 0 || running >= limit) return;

    running += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        running -= 1;
        next();
      });
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

/**
 * 按指定并发度映射异步任务，保留顺序。
 * @param {any[]} items
 * @param {(item: any, index: number) => Promise<any>} mapper
 * @param {number} [limit]
 * @returns {Promise<any[]>}
 */
async function pMap(items, mapper, limit = REMOTE_CONCURRENCY) {
  const run = withConcurrency(limit);
  return Promise.all(items.map((item, index) => run(() => mapper(item, index))));
}

module.exports = {
  REMOTE_CONCURRENCY,
  LOCAL_IO_CONCURRENCY,
  withConcurrency,
  pMap,
};
