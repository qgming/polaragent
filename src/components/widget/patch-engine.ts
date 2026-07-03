// 简单的增量更新引擎
// 比较新旧 HTML 生成最小化 patch，应用 patch 的同时保持用户输入状态

// ------------------------------------------------------------------
// 类型定义
// ------------------------------------------------------------------

/** Patch 操作类型 */
type PatchOp =
  | { type: "setAttribute"; name: string; value: string }
  | { type: "removeAttribute"; name: string }
  | { type: "setText"; text: string }
  | { type: "removeChild"; index: number }
  | { type: "addChild"; index: number; html: string }
  | { type: "replaceChild"; index: number; html: string }
  | { type: "replaceSelf"; html: string };

/** 单个节点的 patch 描述 */
interface NodePatch {
  path: number[];
  ops: PatchOp[];
}

/** 完整的 patch 集合 */
interface PatchResult {
  patches: NodePatch[];
  isReplaceAll: boolean;
}

// ------------------------------------------------------------------
// 核心函数
// ------------------------------------------------------------------

/**
 * 将 HTML 字符串解析为 DOM 树
 * @param html HTML 字符串
 * @returns 解析后的 DOM 节点
 */
function parseHtml(html: string): Node {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const node = template.content.firstChild;
  if (!node) {
    return document.createTextNode(html);
  }
  return node.cloneNode(true);
}

/**
 * 比较两个节点的 HTML 字符串是否相等（忽略空白差异）
 * @param a 节点 A
 * @param b 节点 B
 * @returns 是否相等
 */
function nodesEqual(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;

  if (a.nodeType === Node.TEXT_NODE) {
    return a.textContent?.trim() === b.textContent?.trim();
  }

  if (a.nodeType === Node.ELEMENT_NODE) {
    const ae = a as Element;
    const be = b as Element;
    if (ae.tagName !== be.tagName) return false;

    // 比较属性
    const aAttrs = Array.from(ae.attributes);
    const bAttrs = Array.from(be.attributes);
    if (aAttrs.length !== bAttrs.length) return false;
    for (const attr of aAttrs) {
      if (ae.getAttribute(attr.name) !== be.getAttribute(attr.name)) {
        return false;
      }
    }

    // 比较子节点
    if (ae.childNodes.length !== be.childNodes.length) return false;
    for (let i = 0; i < ae.childNodes.length; i++) {
      if (!nodesEqual(ae.childNodes[i], be.childNodes[i])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * 计算两个节点之间的差异，生成 patch
 * @param oldNode 旧 DOM 节点
 * @param newNode 新 DOM 节点
 * @param path 当前路径
 * @param patches 收集差异的数组
 */
function diffNodes(
  oldNode: Node,
  newNode: Node,
  path: number[] = [],
  patches: NodePatch[] = []
): void {
  if (nodesEqual(oldNode, newNode)) return;

  // 如果节点类型不同，直接替换
  if (oldNode.nodeType !== newNode.nodeType) {
    patches.push({
      path: [...path],
      ops: [{ type: "replaceSelf", html: outerHtml(newNode) }],
    });
    return;
  }

  if (oldNode.nodeType === Node.TEXT_NODE) {
    // 文本节点：setText
    patches.push({
      path: [...path],
      ops: [{ type: "setText", text: newNode.textContent ?? "" }],
    });
    return;
  }

  if (oldNode.nodeType === Node.ELEMENT_NODE) {
    const oldEl = oldNode as Element;
    const newEl = newNode as Element;

    // 比较并处理属性差异
    const attrOps = diffAttributes(oldEl, newEl);
    if (attrOps.length > 0) {
      patches.push({
        path: [...path],
        ops: attrOps,
      });
    }

    // 比较子节点（使用 LCS 找最小差异）
    diffChildren(oldEl, newEl, path, patches);

    // 如果没有子节点变更但有属性变更，仍需保留当前 patch 中的属性操作
    if (attrOps.length > 0 && patches.length > 0) {
      // 属性变更已在上方推送，无需重复处理
    }
  }
}

/**
 * 计算元素属性差异
 * @param oldEl 旧元素
 * @param newEl 新元素
 * @returns 属性操作列表
 */
function diffAttributes(oldEl: Element, newEl: Element): PatchOp[] {
  const ops: PatchOp[] = [];

  const oldAttrs = Array.from(oldEl.attributes);
  const newAttrs = Array.from(newEl.attributes);

  // 移除旧属性
  for (const attr of oldAttrs) {
    if (!newEl.hasAttribute(attr.name)) {
      ops.push({ type: "removeAttribute", name: attr.name });
    }
  }

  // 设置/更新属性
  for (const attr of newAttrs) {
    const oldValue = oldEl.getAttribute(attr.name);
    if (oldValue !== attr.value) {
      ops.push({ type: "setAttribute", name: attr.name, value: attr.value });
    }
  }

  return ops;
}

/**
 * 计算子节点差异（使用最长公共子序列）
 * @param oldEl 旧元素
 * @param newEl 新元素
 * @param path 当前路径
 * @param patches 收集差异的数组
 */
function diffChildren(
  oldEl: Element,
  newEl: Element,
  path: number[],
  patches: NodePatch[]
): void {
  const oldChildren = Array.from(oldEl.childNodes);
  const newChildren = Array.from(newEl.childNodes);

  // 使用动态规划求最长公共子序列（LCS）
  const lcsMatrix: number[][] = Array.from({ length: oldChildren.length + 1 }, () =>
    Array.from({ length: newChildren.length + 1 }, () => 0)
  );

  for (let i = 1; i <= oldChildren.length; i++) {
    for (let j = 1; j <= newChildren.length; j++) {
      if (nodesEqual(oldChildren[i - 1], newChildren[j - 1])) {
        lcsMatrix[i][j] = lcsMatrix[i - 1][j - 1] + 1;
      } else {
        lcsMatrix[i][j] = Math.max(lcsMatrix[i - 1][j], lcsMatrix[i][j - 1]);
      }
    }
  }
  // 从后向前回溯，生成 diff
  let i = oldChildren.length;
  let j = newChildren.length;
  const changes: Array<{
    type: "keep" | "remove" | "add";
    oldIdx?: number;
    newIdx?: number;
  }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && nodesEqual(oldChildren[i - 1], newChildren[j - 1])) {
      changes.unshift({ type: "keep", oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcsMatrix[i][j - 1] >= lcsMatrix[i - 1][j])) {
      changes.unshift({ type: "add", newIdx: j - 1 });
      j--;
    } else if (i > 0) {
      changes.unshift({ type: "remove", oldIdx: i - 1 });
      i--;
    }
  }

  // 根据 diff 结果生成 patch
  for (let idx = changes.length - 1; idx >= 0; idx--) {
    const change = changes[idx];
    if (change.type === "keep") {
      // 递归比较保留的节点
      if (change.oldIdx !== undefined && change.newIdx !== undefined) {
        diffNodes(
          oldChildren[change.oldIdx],
          newChildren[change.newIdx],
          [...path, change.oldIdx],
          patches
        );
      }
    } else if (change.type === "remove" && change.oldIdx !== undefined) {
      patches.push({
        path: [...path],
        ops: [{ type: "removeChild", index: change.oldIdx }],
      });
    } else if (change.type === "add" && change.newIdx !== undefined) {
      // 添加节点
      const newNode = newChildren[change.newIdx];
      patches.push({
        path: [...path],
        ops: [{ type: "addChild", index: change.newIdx, html: outerHtml(newNode) }],
      });
    }
  }
}

/**
 * 获取节点的 HTML 字符串
 * @param node DOM 节点
 * @returns 外层的 HTML 字符串
 */
function outerHtml(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const attrs = Array.from(el.attributes)
      .map((attr) => ` ${attr.name}="${attr.value}"`)
      .join("");
    if (el.childNodes.length === 0) {
      return `<${tag}${attrs}></${tag}>`;
    }
    const inner = Array.from(el.childNodes)
      .map((child) => outerHtml(child))
      .join("");
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
  return "";
}

// ------------------------------------------------------------------
// 对外 API
// ------------------------------------------------------------------

/**
 * 比较新旧 HTML 字符串，生成最小化 patch
 * @param oldHtml 旧 HTML 字符串
 * @param newHtml 新 HTML 字符串
 * @returns 差异 patch 结果
 */
export function diffHtml(oldHtml: string, newHtml: string): PatchResult {
  try {
    const oldNode = parseHtml(oldHtml);
    const newNode = parseHtml(newHtml);

    if (nodesEqual(oldNode, newNode)) {
      return { patches: [], isReplaceAll: false };
    }

    const patches: NodePatch[] = [];
    diffNodes(oldNode, newNode, [], patches);
    return { patches, isReplaceAll: false };
  } catch {
    // 解析失败时退化为全量替换
    return { patches: [], isReplaceAll: true };
  }
}

/**
 * 将 patch 应用到现有 DOM 节点
 * @param oldDom 旧 DOM 节点（根节点）
 * @param patch 差异 patch 结果
 * @returns 更新后的 DOM 节点
 */
export function applyPatch(
  oldDom: Node,
  patch: PatchResult
): Node {
  if (patch.isReplaceAll) {
    return oldDom;
  }

  for (const nodePatch of patch.patches) {
    const target = getNodeAtPath(oldDom, nodePatch.path);
    if (!target) continue;

    for (const op of nodePatch.ops) {
      switch (op.type) {
        case "setAttribute": {
          if (target.nodeType === Node.ELEMENT_NODE) {
            (target as Element).setAttribute(op.name, op.value);
          }
          break;
        }
        case "removeAttribute": {
          if (target.nodeType === Node.ELEMENT_NODE) {
            (target as Element).removeAttribute(op.name);
          }
          break;
        }
        case "setText": {
          target.textContent = op.text;
          break;
        }
        case "removeChild": {
          if (target.nodeType === Node.ELEMENT_NODE) {
            const child = (target as Element).childNodes[op.index];
            if (child) {
              target.removeChild(child);
            }
          }
          break;
        }
        case "addChild": {
          if (target.nodeType === Node.ELEMENT_NODE) {
            const newChild = parseHtml(op.html);
            (target as Element).insertBefore(newChild, (target as Element).childNodes[op.index] ?? null);
          }
          break;
        }
        case "replaceChild": {
          if (target.nodeType === Node.ELEMENT_NODE) {
            const oldChild = (target as Element).childNodes[op.index];
            if (oldChild) {
              const newChild = parseHtml(op.html);
              (target as Element).replaceChild(newChild, oldChild);
            }
          }
          break;
        }
        case "replaceSelf": {
          return parseHtml(op.html);
        }
      }
    }
  }

  return oldDom;
}

/**
 * 根据路径获取 DOM 节点
 * @param root 根节点
 * @param path 路径索引数组
 * @returns 目标节点或 null
 */
function getNodeAtPath(root: Node, path: number[]): Node | null {
  let current: Node | null = root;
  for (const idx of path) {
    if (!current) return null;
    current = current.childNodes[idx] ?? null;
  }
  return current;
}

// ------------------------------------------------------------------
// 导出类型
// ------------------------------------------------------------------

export type { PatchOp, NodePatch, PatchResult };
