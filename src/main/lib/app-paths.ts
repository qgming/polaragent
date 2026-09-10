// 应用路径与数据目录管理
// 集中处理 userData 目录与数据目录初始化。
import { app } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "./fs-utils.js";
import { pMap, LOCAL_IO_CONCURRENCY } from "./concurrency.js";

// userData 根目录
function dataDir() {
  return app.getPath("userData");
}

// 在多个候选位置中找到第一个真实存在的资源路径
function projectResourcePath(...segments: string[]) {
  const candidates = [
    path.join(process.resourcesPath || "", ...segments),
    path.join(app.getAppPath(), ...segments),
    path.join(process.cwd(), ...segments),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

// 应用图标路径（按优先级回退）
function appIconPath() {
  return (
    projectResourcePath("build", "icon.ico") ||
    projectResourcePath("build", "icon.png") ||
    projectResourcePath("dist", "logo.png") ||
    projectResourcePath("public", "logo.png")
  );
}

// AGENTS.md 默认内容：安装时写入，用户可在设置中编辑
const DEFAULT_AGENTS_MD = `# PolarAgent

你是 PolarAgent——用户的执行型协作伙伴，直接帮对方把事情做成。

## 核心原则

- **工具优先**：能直接动手完成的操作就不要只给建议。可用工具为 bash（执行命令）、read（读取文件）、write（写入文件）、edit（精确替换）。
- **透明推理**：关键决策前说明原因，让用户理解思路并有机会介入。
- **权限确认**：涉及文件覆盖、大量修改、危险命令时，先说明影响范围并请求确认。
- **任务分解**：复杂任务自动拆解为可执行步骤，逐步推进。

## 工作流程

1. **理解目标**：需求模糊时用具体问题澄清，不凭空假设。
2. **方案设计**：列出执行计划，标注需要确认的操作。
3. **执行+追踪**：逐步执行并说明进度，让用户随时知道做到哪一步。
4. **交付成果**：确保交付可直接使用的成果，避免半成品。

## 沟通风格

- 默认使用中文，简洁、务实、口语化。
- 给出结论时说清依据；不确定就明说，并提出验证方式。
- 对用户提供的信息保持尊重。
`;

// 确保数据目录及全部子目录存在
async function ensureDataDir() {
  const subdirs = [
    "config",
    "conversations",
    "logs",
  ];
  await ensureDir(dataDir());
  await pMap(
    subdirs,
    (subdir: string) => ensureDir(path.join(dataDir(), subdir)),
    LOCAL_IO_CONCURRENCY,
  );
  // 首启时创建默认 AGENTS.md（已存在则不覆盖）
  const agentsMd = path.join(dataDir(), "AGENTS.md");
  if (!fs.existsSync(agentsMd)) {
    await fsp.writeFile(agentsMd, DEFAULT_AGENTS_MD, "utf-8").catch(() => {});
  }
}

export {
  dataDir,
  projectResourcePath,
  appIconPath,
  ensureDataDir,
};
