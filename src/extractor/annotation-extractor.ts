import type { Node } from 'web-tree-sitter';
import type { AnnotationInfo } from '../model/types';
import { JavaNodeType } from '../model/types';
import { getText, namedChildren, collectAnnotationNodes } from '../utils/node-helpers';

/**
 * 解析单个注解节点为 AnnotationInfo。
 *
 * tree-sitter-java 的注解节点：
 * - marker_annotation: @Override（无参数）
 * - annotation: @Service("x") 或 @Foo(a=1)（有参数，参数为 argument_list 子节点）
 *
 * 注解名可能为 identifier 或 scoped_identifier（如 @lombok.Data）。
 */
export function extractAnnotation(content: string, node: Node): AnnotationInfo {
  let name = '';
  let args: string | undefined;
  for (const child of namedChildren(node)) {
    if (child.type === JavaNodeType.Identifier || child.type === JavaNodeType.ScopedIdentifier) {
      name = getText(content, child);
    } else if (child.type === 'argument_list' || child.type === 'element_value_array_initializer' /* 等 */) {
      // 取括号内文本
      const inner = getText(content, child);
      args = inner.startsWith('(') && inner.endsWith(')')
        ? inner.slice(1, -1)
        : inner;
    } else {
      // 兜底：其他子节点（如注解成员赋值）一并并入参数文本
      if (!args) args = getText(content, child);
    }
  }
  // 降级：若未取到 name，直接从节点文本剥离 @ 与括号
  if (!name) {
    const raw = getText(content, node).replace(/^@/, '');
    const m = raw.match(/^([^(]+)/);
    name = m ? m[1] : raw;
  }
  return {
    name,
    arguments: args,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  };
}

/**
 * 从 modifiers 节点（或任意父节点）提取注解列表。
 * 接收 modifiers 节点，收集其中的 annotation/marker_annotation。
 */
export function extractAnnotationsFromModifiers(
  content: string,
  modifiersNode: Node | undefined,
): AnnotationInfo[] {
  if (!modifiersNode) return [];
  return collectAnnotationNodes(modifiersNode).map((n) => extractAnnotation(content, n));
}

/** 直接从一段命名子节点列表中提取注解（用于未走 modifiers 的场景）。 */
export function extractAnnotationsInline(content: string, nodes: Node[]): AnnotationInfo[] {
  return nodes
    .filter(
      (n) =>
        n.type === JavaNodeType.Annotation || n.type === JavaNodeType.MarkerAnnotation,
    )
    .map((n) => extractAnnotation(content, n));
}
