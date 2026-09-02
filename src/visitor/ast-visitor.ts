import type { Node } from 'web-tree-sitter';
import { namedChildren } from '../utils/node-helpers';

/**
 * 深度优先遍历命名子节点，对每个节点调用回调。
 * 不递归进入回调返回 false 的节点（用于剪枝）。
 */
export function walk(
  node: Node,
  cb: (n: Node, parent: Node | null) => boolean | void,
  parent: Node | null = null,
): void {
  const go = cb(node, parent);
  if (go === false) return;
  for (const child of namedChildren(node)) {
    walk(child, cb, node);
  }
}

/**
 * 收集子树中所有指定类型的命名节点。
 */
export function collectByType(node: Node, type: string): Node[] {
  const out: Node[] = [];
  walk(node, (n) => {
    if (n.type === type) out.push(n);
  });
  return out;
}
