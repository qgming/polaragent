/**
 * 字号角色（design.md《Register: type》的封闭集合）。
 *
 * 规则：按含义分配，不按字号。用角色，不要临时拼一个新字号；
 * 某个同类字符串更长也不要单独改它的大小。
 *
 * 三个字体的分工：
 *   display —— 页面自己的声音：h1/h2/h3，以及页面围绕的那个大数字
 *   sans    —— 阅读正文
 *   mono    —— 只做两件事：你敲或装的东西（命令、包名、路径、标识、版本、计数），
 *              以及给 section 命名的眉题
 *
 * mono 不是正文，也不用于强调。眉题一律 mono，不用加字距的全大写 sans。
 */

/** 页面最大的那个对象：空态欢迎语、整屏错误的主标题 */
export const typeHero =
  "font-display text-4xl leading-[1.15] font-medium tracking-tight text-pretty";

/** section 标题：设置面板标题、线程内的大分段标题 */
export const typeSection = "font-display text-xl leading-[1.3] font-medium tracking-tight";

/** 页面级标题：主区顶栏的会话名 */
export const typePage = "font-display text-lg leading-[1.3] font-medium tracking-tight";

/** 引导句：跟在 hero 下面的那句话。永远不是小字，不能靠压低字号来塞密度 */
/** 引导句：跟在 hero 下面的那句话。永远不是小字，不能靠压低字号来塞密度 */
export const typeDeck = "text-sm leading-relaxed text-ink-2";

/**
 * 眉题：给一组内容命名（日期分组、命令面板分组、结果计数、会话面板的区块标题）。
 *
 * 用 ink-3 而不是更淡的一档：眉题常是 11px 小字，而小字对对比度要求更高
 * （原来写的是 text-ink-4，在亮色底上只有 2.35:1，基本读不清）。
 */
export const typeEyebrow = "font-mono text-[11px] tracking-tight text-ink-3";

/** 你敲或装的东西：commit、路径、包名、版本、模型 id、token 计数 */
export const typePackage = "font-mono text-xs tabular-nums tracking-tight";
