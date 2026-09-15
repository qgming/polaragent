/**
 * 斜杠菜单的数据源：把技能与提示模板两个 IPC 列表拉进渲染层。
 *
 * 取数的 workingDir 用**当前会话的 cwd**，与主进程 runtime 的 resolveWorkingDir 同一个口径
 * —— 否则会出现「菜单里列着 A 目录的技能，模型在 B 目录里找不到」这种对不上的情况。
 *
 * 设置面板（技能 / 魔法提示）不带会话，只列数据目录里的全局资源，与这里不同是刻意的。
 */

import { useEffect, useState } from "react";
import { useChatStore } from "@/renderer/stores/chat-store";
import { buildSlashCommands, type SlashCommand } from "./slash-commands";

/** 稳定空引用：避免每次渲染都产生新数组（zustand v5 下会被判成状态变化） */
const EMPTY_COMMANDS: SlashCommand[] = [];

/**
 * 工作目录：会话绑定的 cwd；没有就是 undefined（主进程那边按「只扫数据目录」处理）。
 *
 * 单独提成纯函数是因为它有**两个**调用方：菜单取清单，以及发送前展开模板（见
 * OintRuntimeProvider）。两边必须同源，否则会出现「菜单里看得见、发送时认不出来」。
 */
export function resolveWorkingDir(sessionCwd: string | undefined): string | undefined {
  return sessionCwd !== undefined && sessionCwd !== "" ? sessionCwd : undefined;
}

/** 当前会话的工作目录（口径见 resolveWorkingDir） */
export function useActiveWorkingDir(): string | undefined {
  const cwd = useChatStore(
    (s) => s.sessions.find((session) => session.id === s.activeSessionId)?.cwd,
  );
  return resolveWorkingDir(cwd);
}

/**
 * 拉取斜杠命令清单。
 *
 * 只在工作目录变化时重取（切换会话 / 换项目）。渲染层没有「技能目录被改了」的
 * 通知，所以设置面板改完目录后菜单要等下一次会话切换才刷新 —— 与 Thread 读历史
 * 的口径一致，不为它单开轮询。
 */
export function useSlashCommands(workingDir: string | undefined): SlashCommand[] {
  const [commands, setCommands] = useState<SlashCommand[]>(EMPTY_COMMANDS);

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const [skills, templates] = await Promise.all([
          window.oint.skills.list(workingDir),
          window.oint.prompts.list(workingDir),
        ]);
        if (live) setCommands(buildSlashCommands(skills, templates));
      } catch {
        // 菜单是便利入口，读不到就当没有：用户仍可手敲 /name，不值得为此弹错误
        if (live) setCommands(EMPTY_COMMANDS);
      }
    })();

    return () => {
      live = false;
    };
  }, [workingDir]);

  return commands;
}
