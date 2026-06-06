// Skill 加载器 - 支持 Agent Skills 标准
// src/lib/skill-loader.ts

import type { SkillConfig } from "@/types/config";
import type { Skill as PiSkill } from "@earendil-works/pi-agent-core";
import {
  getDataDir,
  installSkillFromGit,
  installSkillFromLocal,
  readFile,
  listDirectory,
} from "./electron-api";

/**
 * Agent Skills 标准的 SKILL.md frontmatter
 */
interface SkillMdFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  "allowed-tools"?: string;
}

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
    const content = await readFile(path);

    // 解析 frontmatter
    const frontmatterMatch = content.match(
      /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/,
    );
    if (!frontmatterMatch) {
      throw new Error("Invalid SKILL.md format: missing frontmatter");
    }

    const [, frontmatterText, body] = frontmatterMatch;

    // 简单的 YAML 解析（仅支持基本键值对）
    const frontmatter = this.parseSimpleYaml(frontmatterText);

    // 验证必需字段
    if (!frontmatter.name || !frontmatter.description) {
      throw new Error("SKILL.md must have 'name' and 'description' fields");
    }

    // 验证 name 格式
    if (!/^[a-z0-9-]+$/.test(frontmatter.name)) {
      throw new Error(`Invalid skill name: ${frontmatter.name}`);
    }

    // 验证 name 与目录名一致
    if (frontmatter.name !== dirName) {
      console.warn(
        `Skill name '${frontmatter.name}' doesn't match directory '${dirName}'`,
      );
    }

    // 转换为 SkillConfig 格式
    const config: SkillConfig = {
      id: frontmatter.name,
      name: this.capitalize(frontmatter.name.replace(/-/g, " ")),
      description: frontmatter.description,
      version: frontmatter.metadata?.version || "1.0.0",
      type,
      enabled: true,
      tools: [], // SKILL.md 中的工具需要从 body 解析或单独定义
      filePath: path, // SKILL.md 绝对路径，供 AI 渐进式披露时按需 read_file
      permissions: this.parsePermissions(frontmatter.compatibility || ""),
      settings: {
        license: frontmatter.license,
        compatibility: frontmatter.compatibility,
        metadata: frontmatter.metadata,
        allowedTools: frontmatter["allowed-tools"],
        instructions: body.trim(),
      },
    };

    return config;
  }

  /**
   * 简单的 YAML 解析器（仅支持基本键值对和 metadata 映射）
   */
  private parseSimpleYaml(yaml: string): SkillMdFrontmatter {
    const result: any = {};
    const lines = yaml.split("\n");
    let currentKey: string | null = null;
    let currentObject: any = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // 检查是否是嵌套对象（如 metadata:）
      if (trimmed.endsWith(":") && !trimmed.includes(" ")) {
        currentKey = trimmed.slice(0, -1);
        currentObject = {};
        result[currentKey] = currentObject;
        continue;
      }

      // 检查是否是键值对
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex > 0) {
        const key = trimmed.slice(0, colonIndex).trim();
        let value = trimmed.slice(colonIndex + 1).trim();

        // 移除引号
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        // 如果在嵌套对象中
        if (currentObject && trimmed.startsWith("  ")) {
          currentObject[key] = value;
        } else {
          result[key] = value;
          currentKey = null;
          currentObject = null;
        }
      }
    }

    return result as SkillMdFrontmatter;
  }

  /**
   * 从 compatibility 字段解析权限
   */
  private parsePermissions(compatibility: string): string[] {
    const permissions: string[] = [];

    const lower = compatibility.toLowerCase();
    if (lower.includes("internet") || lower.includes("network")) {
      permissions.push("network");
    }
    if (lower.includes("file")) {
      permissions.push("file_system");
    }
    if (
      lower.includes("python") ||
      lower.includes("code") ||
      lower.includes("execute")
    ) {
      permissions.push("code_execution");
    }

    return permissions;
  }

  /**
   * 首字母大写
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
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
   * 列出 Skill 目录
   */
  private async listSkillDirectories(basePath: string): Promise<string[]> {
    try {
      const entries = await listDirectory(basePath);
      // 过滤出目录（不包含扩展名的条目）
      return entries.filter((entry) => !entry.includes("."));
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
   * 卸载 Skill
   */
  async uninstallSkill(id: string): Promise<boolean> {
    const skill = this.skills.get(id);
    if (!skill) {
      return false;
    }

    if (skill.type === "builtin") {
      console.error("无法卸载内置 Skill");
      return false;
    }

    // TODO: 实现 Skill 卸载逻辑
    this.skills.delete(id);
    console.log(`Skill ${skill.name} 已卸载`);
    return true;
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

      // 检查 frontmatter 格式
      if (!content.match(/^---\s*\n[\s\S]*?\n---\s*\n/)) {
        errors.push("Missing or invalid frontmatter in SKILL.md");
      }

      // 解析并验证字段
      try {
        const config = await this.parseSkillMd(skillMdPath, "");
        if (!config.id || !config.description) {
          errors.push("Missing required fields: name or description");
        }
      } catch (error) {
        errors.push(`Parse error: ${error}`);
      }
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
