// Skill 加载器 - 支持 Agent Skills 标准

import type { SkillConfig } from "@/types/config";
import type { Skill as PiSkill } from "@earendil-works/pi-agent-core";
import {
  getDataDir,
  getHomeDir,
  installSkillFromGit,
  installSkillFromLocal,
  installSkillFromZip,
  uninstallSkill as uninstallSkillApi,
  readFile,
  listDirectoryEntries,
} from "@/lib/electron/electron-api";
import { parseSkillMdContent, validateSkillMdContent } from "./skill-parser";

/**
 * SkillLoader - 加载和管理符合 Agent Skills 标准的 Skills
 */
export class SkillLoader {
  private skills = new Map<string, SkillConfig>();
  private builtinSkillsPath = "";
  private customSkillsPath = "";

  /**
   * 初始化 - 加载所有 Skills
   */
  async initialize() {
    console.log("开始加载 Skills（Agent Skills 标准）...");
    this.skills.clear();

    const dataDir = await getDataDir();
    this.builtinSkillsPath = `${dataDir}/skills/builtin`;
    this.customSkillsPath = `${dataDir}/skills/custom`;

    // 1. 加载内置 Skills
    await this.loadBuiltinSkills();

    // 2. 加载用户自定义 Skills
    await this.loadCustomSkills();

    // 3. 加载 ~/.agents/skills/ 全局 Skills (npx skills 安装的)
    await this.loadGlobalSkills();

    console.log(`✓ Skills 加载完成，共 ${this.skills.size} 个`);
  }

  /**
   * 加载内置 Skills（仅支持 Agent Skills 标准格式）
   */
  private async loadBuiltinSkills() {
    try {
      const skillDirs = await this.listSkillDirectories(this.builtinSkillsPath);

      for (const dir of skillDirs) {
        try {
          // 加载 SKILL.md（Agent Skills 标准）
          const skillMdPath = `${this.builtinSkillsPath}/${dir}/SKILL.md`;
          const config = await this.parseSkillMd(skillMdPath, dir);

          this.skills.set(config.id, config);
          console.log(`  ✓ 加载 Skill: ${config.name} (${config.id})`);
        } catch (error) {
          console.error(`  ✗ 加载 Skill 失败: ${dir}`, error);
        }
      }
    } catch (error) {
      console.error("加载内置 Skills 失败:", error);
    }
  }

  /**
   * 解析 SKILL.md 文件（Agent Skills 标准）
   */
  private async parseSkillMd(
    path: string,
    dirName: string,
    type: "builtin" | "custom" = "builtin",
  ): Promise<SkillConfig> {
    return parseSkillMdContent(await readFile(path), { path, dirName, type });
  }

  /**
   * 加载用户自定义 Skills
   */
  private async loadCustomSkills() {
    try {
      const skillDirs = await this.listSkillDirectories(this.customSkillsPath);

      for (const dir of skillDirs) {
        try {
          const skillMdPath = `${this.customSkillsPath}/${dir}/SKILL.md`;
          const config = await this.parseSkillMd(skillMdPath, dir, "custom");

          this.skills.set(config.id, config);
          console.log(`  ✓ 加载自定义 Skill: ${config.name} (${config.id})`);
        } catch (error) {
          console.error(`  ✗ 加载自定义 Skill 失败: ${dir}`, error);
        }
      }
    } catch (error) {
      console.error("加载自定义 Skills 失败:", error);
    }
  }

  /**
   * 加载全局 Skills (npx skills 安装的)
   */
  private async loadGlobalSkills() {
    try {
      const homeDir = await getHomeDir();
      const globalSkillsPath = `${homeDir}\\.agents\\skills`;
      const skillDirs = await this.listSkillDirectories(globalSkillsPath);

      for (const dir of skillDirs) {
        try {
          const skillMdPath = `${globalSkillsPath}\\${dir}\\SKILL.md`;
          const config = await this.parseSkillMd(skillMdPath, dir, "custom");
          config.type = "global";

          this.skills.set(config.id, config);
          console.log(`  ✓ 加载全局 Skill: ${config.name} (${config.id})`);
        } catch (error) {
          console.error(`  ✗ 加载全局 Skill 失败: ${dir}`, error);
        }
      }
    } catch (error) {
      console.error("加载全局 Skills 失败:", error);
    }
  }

  /**
   * 列出 Skill 目录
   */
  private async listSkillDirectories(basePath: string): Promise<string[]> {
    try {
      const entries = await listDirectoryEntries(basePath);
      return entries.filter((entry) => entry.isDir).map((entry) => entry.name);
    } catch (error) {
      console.error(`列出目录失败: ${basePath}`, error);
      return [];
    }
  }

  /**
   * 获取 Skill 配置
   */
  getSkill(id: string): SkillConfig | undefined {
    return this.skills.get(id);
  }

  /**
   * 获取所有 Skills
   */
  getAllSkills(): SkillConfig[] {
    return Array.from(this.skills.values());
  }

  /**
   * 获取启用的 Skills
   */
  getEnabledSkills(): SkillConfig[] {
    return this.getAllSkills().filter((skill) => skill.enabled);
  }

  /**
   * 根据 ID 列表获取 Skills
   */
  getSkillsByIds(ids: string[]): SkillConfig[] {
    return ids
      .map((id) => this.skills.get(id))
      .filter((skill): skill is SkillConfig => skill !== undefined);
  }

  /**
   * 把指定 id 的（已启用且有 filePath 的）Skills 转成 pi-agent-core 的 Skill。
   * 用于渐进式披露：只把 name/description/location 列入系统提示，
   * content 作为显式调用（harness.skill）时的全文备用；
   * AI 平时按 location 路径自行 read_file 读取全文与 references。
   */
  toPiSkills(ids: string[]): PiSkill[] {
    const result: PiSkill[] = [];
    for (const id of ids) {
      const skill = this.skills.get(id);
      if (!skill || !skill.enabled || !skill.filePath) continue;
      result.push({
        name: skill.id,
        description: skill.description,
        content: skill.settings.instructions ?? "",
        filePath: skill.filePath,
        // 0.80 新增：支持对模型隐藏技能（仅应用显式调用）
        disableModelInvocation: skill.settings.disableModelInvocation ?? false,
      });
    }
    return result;
  }

  /**
   * 启用/禁用 Skill
   */
  toggleSkill(id: string, enabled: boolean) {
    const skill = this.skills.get(id);
    if (skill) {
      skill.enabled = enabled;
      // TODO: 保存到配置文件
      console.log(`Skill ${skill.name} ${enabled ? "已启用" : "已禁用"}`);
    }
  }

  /**
   * 获取 Skill 的所有工具
   */
  getSkillTools(skillId: string) {
    const skill = this.skills.get(skillId);
    return skill?.tools || [];
  }

  /**
   * 获取多个 Skills 的所有工具
   */
  getToolsFromSkills(skillIds: string[]) {
    const tools: any[] = [];

    for (const id of skillIds) {
      const skill = this.skills.get(id);
      if (skill && skill.enabled) {
        tools.push(...skill.tools);
      }
    }

    return tools;
  }

  /**
   * 检查 Skill 权限
   */
  checkPermissions(skillId: string): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return false;
    }

    // TODO: 实现权限检查逻辑
    return true;
  }

  /**
   * 从 Git 安装 Skill
   */
  async installSkillFromGit(repoUrl: string): Promise<boolean> {
    try {
      console.log(`开始从 Git 安装 Skill: ${repoUrl}`);
      await installSkillFromGit(repoUrl);
      await this.initialize();
      return true;
    } catch (error) {
      console.error("从 Git 安装 Skill 失败:", error);
      throw error;
    }
  }

  /**
   * 从本地目录安装 Skill
   */
  async installSkillFromLocal(sourcePath: string): Promise<boolean> {
    try {
      console.log(`开始从本地安装 Skill: ${sourcePath}`);
      await installSkillFromLocal(sourcePath);
      await this.initialize();
      return true;
    } catch (error) {
      console.error("从本地安装 Skill 失败:", error);
      throw error;
    }
  }

  /**
   * 从压缩包安装 Skill
   */
  async installSkillFromZip(zipPath: string): Promise<boolean> {
    try {
      console.log(`开始从压缩包安装 Skill: ${zipPath}`);
      await installSkillFromZip(zipPath);
      await this.initialize();
      return true;
    } catch (error) {
      console.error("从压缩包安装 Skill 失败:", error);
      throw error;
    }
  }

  /**
   * 卸载 Skill
   */
  async uninstallSkill(id: string): Promise<boolean> {
    const skill = this.skills.get(id);
    if (!skill) {
      console.error(`技能不存在: ${id}`);
      return false;
    }

    if (skill.type === "builtin") {
      console.error("无法卸载内置 Skill");
      return false;
    }

    try {
      // 调用主进程删除技能目录
      await uninstallSkillApi(id);

      // 从内存中移除
      this.skills.delete(id);
      console.log(`Skill ${skill.name} 已卸载`);
      return true;
    } catch (error) {
      console.error(`卸载 Skill 失败: ${id}`, error);
      throw error;
    }
  }

  /**
   * 验证 Skill 格式
   */
  async validateSkill(
    skillPath: string,
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      // 检查 SKILL.md 是否存在
      const skillMdPath = `${skillPath}/SKILL.md`;
      const content = await readFile(skillMdPath);
      errors.push(...validateSkillMdContent(content));
    } catch (error) {
      errors.push("SKILL.md file not found or cannot be read");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// 导出单例
export const skillLoader = new SkillLoader();
