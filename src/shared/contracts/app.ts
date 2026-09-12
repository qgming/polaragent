/** 内核依赖（pisdk 的 pi 包）：名称与版本 */
export interface KernelDependency {
  name: string;
  /** 实际安装版本；读取失败时为 null（界面留空，不编造） */
  version: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  /** 内核依赖列表，数组顺序即界面中的展示顺序 */
  kernel: KernelDependency[];
  /** 应用数据根目录，设置/会话/日志等均在其下 */
  dataDir: string;
}
