export interface AppInfo {
  name: string;
  version: string;
  /** 运行平台（node process.platform 取值）；共享层不引 @types/node，故用 string */
  platform: string;
  /** 应用数据根目录，设置/会话/日志等均在其下 */
  dataDir: string;
}
