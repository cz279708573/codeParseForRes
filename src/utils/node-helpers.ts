import type { Node } from 'web-tree-sitter';
import { JavaNodeType } from '../model/types';

/**
 * 取节点在原文中的文本片段。
 * 与参考工程 getContent 一致：content.substring(startIndex, endIndex)。
 */
export function getText(content: string, node: Node): string {
  return content.substring(node.startIndex, node.endIndex);
}

/** 按起止下标取文本 */
export function getTextByRange(content: string, start: number, end: number): string {
  return content.substring(start, end);
}

/** 命名子节点便捷迭代 */
export function namedChildren(node: Node): Node[] {
  const list: Node[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) list.push(c);
  }
  return list;
}

/** 按类型筛首个命名子节点 */
export function firstNamedChild(node: Node, type: JavaNodeType): Node | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) return c;
  }
  return undefined;
}

/** 是否为注释节点 */
export function isCommentNode(node: Node): boolean {
  return (
    node.type === JavaNodeType.Comment ||
    node.type === JavaNodeType.LineComment ||
    node.type === JavaNodeType.BlockComment
  );
}

/**
 * 解析 modifiers 节点为修饰符关键词列表。
 *
 * 参考工程 [codeParser.ts:393-411] 的经验：modifiers 节点内会混入 annotation
 * 子节点；注解的提取交给 annotation-extractor，此处只取修饰关键字。
 * 实现上直接取 modifiers 节点原始文本，正则剔除 @Annotation(...) 后按空白切分。
 */
export function parseModifierKeywords(modifiersNode: Node | undefined): string[] {
  if (!modifiersNode) return [];
  const raw = modifiersNode.text;
  const cleaned = raw.replace(/@\w+(?:\([^)]*\))?/g, ' ').trim();
  if (!cleaned) return [];
  return cleaned.split(/\s+/);
}

/** 收集 modifiers 节点下的注解子节点（annotation / marker_annotation）。 */
export function collectAnnotationNodes(modifiersNode: Node | undefined): Node[] {
  if (!modifiersNode) return [];
  const list: Node[] = [];
  for (const child of namedChildren(modifiersNode)) {
    if (child.type === JavaNodeType.Annotation || child.type === JavaNodeType.MarkerAnnotation) {
      list.push(child);
    }
  }
  return list;
}

/**
 * 求方法签名终点：以 block 起点为界，若无 block 则取节点终点。
 * 借鉴参考工程 [codeParser.ts:349-365] getMethondDecl 思路。
 */
export function findMethodSignatureEnd(item: Node): number {
  for (let i = 0; i < item.namedChildCount; i++) {
    const child = item.namedChild(i);
    if (child && child.type === JavaNodeType.Block) {
      return child.startIndex;
    }
  }
  return item.endIndex;
}
