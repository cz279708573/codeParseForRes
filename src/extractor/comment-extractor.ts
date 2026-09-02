import type { Node } from 'web-tree-sitter';
import type { CommentInfo, CommentKind } from '../model/types';
import { JavaNodeType } from '../model/types';
import { getText } from '../utils/node-helpers';

/**
 * 将单个注释节点解析为 CommentInfo。
 *
 * 参考工程 getCommentsString 的策略：
 * - 块注释定界符去头尾
 * - 行注释符去前缀
 * - 块内行首星号去除
 */
export function extractComment(content: string, node: Node): CommentInfo {
  const raw = getText(content, node);
  let kind: CommentKind;
  if (node.type === JavaNodeType.LineComment) {
    kind = 'line';
  } else if (node.type === JavaNodeType.BlockComment) {
    // /** 起头视为 javadoc
    kind = raw.startsWith('/**') ? 'javadoc' : 'block';
  } else {
    // 兜底：tree-sitter-java 的 comment 节点（旧版统一类型）
    if (raw.startsWith('//')) {
      kind = 'line';
    } else if (raw.startsWith('/**')) {
      kind = 'javadoc';
    } else {
      kind = 'block';
    }
  }

  let text = raw;
  if (kind === 'line') {
    text = raw.replace(/^\/\//, '').trim();
  } else {
    // 块或 javadoc：去 /* 与 */，再逐行去行首 *
    let inner = raw;
    if (inner.startsWith('/**')) inner = inner.slice(3);
    else if (inner.startsWith('/*')) inner = inner.slice(2);
    if (inner.endsWith('*/')) inner = inner.slice(0, -2);
    text = inner
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*/, '').trim())
      .filter((line) => line.length > 0)
      .join('\n')
      .trim();
  }

  return {
    kind,
    text,
    raw,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  };
}

/**
 * 从一组"前置注释"节点生成 CommentInfo 列表。
 * 调用方负责把紧邻声明之前的若干 comment 节点传入。
 */
export function extractComments(content: string, nodes: Node[]): CommentInfo[] {
  return nodes.map((n) => extractComment(content, n));
}

/** 判断注释净文本是否为空（仅空白与星号）。 */
export function isEmptyComment(comment: CommentInfo): boolean {
  return /^[\s]*$/.test(comment.text);
}
