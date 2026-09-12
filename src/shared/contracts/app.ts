/** 内核依赖（pisdk 的 pi 包）：名称与版本 */
export interface KernelDependency {
  name: string;
  /** 实际安装版本；读取失败时为 null（界面留空，不编造） */
  version: string | null;
}

export interface AppInfo {
  /** 显示名：读应用 package.json 的 productName ?? name；读不到时为 null（界面留空，不编造） */
  name: string | null;
  /** 应用版本：读应用 package.json 的 version；读不到时为 null（界面留空，不编造） */
  version: string | null;
  /** 内核依赖列表，数组顺序即界面中的展示顺序 */
  kernel: KernelDependency[];
  /** 应用数据根目录，设置/会话/日志等均在其下 */
  dataDir: string;
}
