// ui project（jsdom）的公共垫片。
//
// jsdom 不实现 ResizeObserver，而本仓的 ShimmerLabel（assistant-ui/elements/surfaces.tsx）在
// layout effect 里用它测量文字宽度 —— 缺了会直接 ReferenceError，让任何渲染到该组件的测试
// 整份失败。matchMedia 同理（jsdom 没有），Radix 的弹层在做窄屏判断时会用到。
//
// 只补「jsdom 缺失、组件必需」的最小实现，不做像素级模拟：组件测试关心的是结构与文本，
// 不是真实布局尺寸。

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// 两项都无条件覆盖：本文件只在 ui project（jsdom）里加载，而 jsdom 一定没有实现它们。
// 用 `in` 判断反而会被 TS 收窄成 never（DOM 类型里这两个名字是有声明的），得不偿失。
globalThis.ResizeObserver = ResizeObserverStub;

window.matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
