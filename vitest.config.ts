import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/** 与 vite.renderer.config.ts 一致的别名：@/ 指向 src/ */
const alias = { "@": path.resolve(import.meta.dirname, "./src") };

/**
 * 两个 project：
 * - node：主进程 / preload / 共享契约等纯逻辑，收 *.test.ts
 * - ui：渲染层组件，jsdom 环境，收 *.test.tsx，并加载 src/renderer/test-setup.ts 的 jsdom 垫片
 *
 * 拆开的原因：此前的配置是 node 环境 + 只收 *.test.ts，导致**组件完全无法测试**。
 * 这正是一批元素组件「已建好但从未接线」长期无人发现的根因之一 ——
 * 接线断了不会有任何测试变红。新增工具（grep/glob/todo）的 UI 必须能被这个 project 覆盖。
 */
export default defineConfig({
  resolve: { alias },
  test: {
    exclude: [...configDefaults.exclude],
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          exclude: [...configDefaults.exclude],
          // jsdom 缺 ResizeObserver / matchMedia，组件一用到就 ReferenceError（说明见该文件注释）
          setupFiles: ["src/renderer/test-setup.ts"],
        },
      },
    ],
  },
});
