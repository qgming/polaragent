// 项目通道：侧栏「项目」分组的增删查。
// 绑定只存路径列表，会话归属由 cwd 反推（见 shared/contracts/project.ts），这里不做过滤。

import { getProjectsStore } from "@/main/app/projects";
import { IPC } from "@/shared/contracts/ipc";
import { handle } from "./handler";

export function registerProjectsIpc(): void {
  const store = getProjectsStore();

  handle(IPC.projects.list, "读取项目列表", () => store.list());
  handle(IPC.projects.add, "绑定项目目录", (request: { path: string }) => store.add(request.path));
  handle(IPC.projects.remove, "解绑项目", (request: { id: string }) => store.remove(request.id));
}
