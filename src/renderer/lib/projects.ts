import type { Project, SessionSummary } from "@/shared/contracts";

/**
 * 侧栏分组：一个项目分组 = 项目本身 + 归属它的会话。
 * 只带数据，不带任何展开/折叠状态 —— 那是界面的局部状态。
 */
export interface ProjectSection {
  project: Project;
  sessions: SessionSummary[];
  /**
   * 该项目里被置顶的会话数。置顶的会话不在 sessions 里（它们在置顶组），
   * 但「这个项目有没有会话」要算上它们 —— 否则全部置顶的项目会显示成空的。
   */
  pinnedCount: number;
}

/** 侧栏三个分组的内容；置顶与项目/最近互斥（置顶的会话不再出现在后两者里） */
export interface SidebarSections {
  pinned: SessionSummary[];
  projects: ProjectSection[];
  recent: SessionSummary[];
}

/** Windows 盘符前缀：这类路径大小写不敏感，比较前要统一小写 */
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/**
 * 归一化成可比较的路径：去空白、统一成 `/`、去掉末尾分隔符。
 * Windows 下再折成小写（`D:\Work` 与 `d:\work` 是同一个目录）。
 *
 * 注意不能简单地全平台小写：Linux 上 `/Work` 与 `/work` 是两个目录。
 */
export function normalizePathForMatch(input: string): string {
  const unified = input.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return WINDOWS_DRIVE.test(unified) ? unified.toLowerCase() : unified;
}

/**
 * child 是否就在 parent 目录里（含两者相同）。
 *
 * 比较带 `/` 前缀，`D:\devious` 不会被当成 `D:\dev` 的子目录；
 * 空路径（未绑定工作目录的会话）一律不算命中。
 */
export function isPathInside(child: string, parent: string): boolean {
  if (child.trim() === "" || parent.trim() === "") return false;
  const inner = normalizePathForMatch(child);
  const outer = normalizePathForMatch(parent);
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * 会话归属的项目：命中多个（项目目录互相嵌套）时取**路径最长**的那个，
 * 也就是最具体的项目 —— 否则在子目录里新建的会话会掉到父项目里去。
 */
export function findProjectForCwd(cwd: string, projects: readonly Project[]): Project | null {
  let matched: Project | null = null;
  let matchedLength = -1;
  for (const project of projects) {
    if (!isPathInside(cwd, project.path)) continue;
    const length = normalizePathForMatch(project.path).length;
    if (length > matchedLength) {
      matched = project;
      matchedLength = length;
    }
  }
  return matched;
}

/** 一个项目分组最近的活动时间；没有会话时为 0（用于排序，排到有会话的项目后面） */
function latestActivity(section: ProjectSection): number {
  return section.sessions.reduce((max, session) => Math.max(max, session.updatedAt), 0);
}

/**
 * 项目之间：有会话的在前（按最近活动倒序），空项目在后（按添加顺序），
 * 最后用名称兜底保证顺序稳定 —— 排序键相同也不会因刷新而抖动。
 */
function compareProjectSections(left: ProjectSection, right: ProjectSection): number {
  const leftActive = left.sessions.length > 0;
  const rightActive = right.sessions.length > 0;
  if (leftActive !== rightActive) return leftActive ? -1 : 1;
  if (leftActive && rightActive) {
    const byActivity = latestActivity(right) - latestActivity(left);
    if (byActivity !== 0) return byActivity;
  }
  if (left.project.createdAt !== right.project.createdAt) {
    return left.project.createdAt - right.project.createdAt;
  }
  return left.project.name.localeCompare(right.project.name);
}

/**
 * 把会话分到「置顶 / 项目 / 最近」三组。
 *
 * 输入顺序即组内顺序（chat-store 已按 updatedAt 降序维护），所以这里不再排序会话，
 * 只会重排项目本身。置顶优先：置顶的会话只出现在置顶组，不再重复出现在项目/最近。
 */
export function buildSidebarSections(
  sessions: readonly SessionSummary[],
  projects: readonly Project[],
): SidebarSections {
  const pinned: SessionSummary[] = [];
  const recent: SessionSummary[] = [];
  const byProjectId = new Map<string, SessionSummary[]>(
    projects.map((project) => [project.id, []]),
  );
  const pinnedCountByProjectId = new Map<string, number>();

  for (const session of sessions) {
    const project = findProjectForCwd(session.cwd, projects);
    if (session.pinned) {
      pinned.push(session);
      if (project) {
        pinnedCountByProjectId.set(project.id, (pinnedCountByProjectId.get(project.id) ?? 0) + 1);
      }
      continue;
    }
    const bucket = project ? byProjectId.get(project.id) : undefined;
    if (bucket) bucket.push(session);
    else recent.push(session);
  }

  const projectSections = projects
    .map((project) => ({
      project,
      sessions: byProjectId.get(project.id) ?? [],
      pinnedCount: pinnedCountByProjectId.get(project.id) ?? 0,
    }))
    .sort(compareProjectSections);

  return { pinned, projects: projectSections, recent };
}
