import { enUS } from "./locales/en-US";
import { zhCN } from "./locales/zh-CN";

export type { Messages } from "./locales/zh-CN";
export { enUS, zhCN };

/** i18next 初始化用资源聚合：单命名空间 translation */
export const resources = {
  "zh-CN": { translation: zhCN },
  "en-US": { translation: enUS },
};
