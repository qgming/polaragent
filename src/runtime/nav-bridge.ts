// ThreadList / Thread 与 App 壳层的导航桥
// src/runtime/nav-bridge.ts
//
// ExternalStore adapter 回调运行在 Runtime 层，无法直接拿到 App 的 setActivePage。
// 这里用一个极薄的回调注册表把「选中会话 / 新建会话」转发给 App。

type SelectThreadHandler = (threadId: string) => void;
type NewThreadHandler = () => void;

let selectHandler: SelectThreadHandler | null = null;
let newThreadHandler: NewThreadHandler | null = null;

export function setNavHandlers(handlers: {
  onSelectThread?: SelectThreadHandler;
  onNewThread?: NewThreadHandler;
}) {
  selectHandler = handlers.onSelectThread ?? null;
  newThreadHandler = handlers.onNewThread ?? null;
}

export function navSelectThread(threadId: string) {
  selectHandler?.(threadId);
}

export function navNewThread() {
  newThreadHandler?.();
}
