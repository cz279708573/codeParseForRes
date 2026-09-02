import type { Node } from 'web-tree-sitter';
import type { FieldInfo, CommentInfo } from '../model/types';
import { JavaNodeType } from '../model/types';
import { getText, namedChildren, firstNamedChild, parseModifierKeywords } from '../utils/node-helpers';
import { extractAnnotationsFromModifiers } from './annotation-extractor';

/**
 * 从 field_declaration / constant_declaration 节点提取属性元信息。
 *
 * 节点结构（依探针实测）：
 *   field_declaration
 *     modifiers
 *     type (integral_type / type_identifier / ...)
 *     variable_declarator
 *       identifier
 *       (可选) string_literal / initializer
 */
export function extractField(
  content: string,
  node: Node,
  comments: CommentInfo[],
): FieldInfo {
  let name = '';
  let type = '';
  let modifiersNode: Node | undefined;

  for (const child of namedChildren(node)) {
    if (child.type === JavaNodeType.Modifiers) {
      modifiersNode = child;
    } else if (child.type === JavaNodeType.VariableDeclarator) {
      const id = firstNamedChild(child, JavaNodeType.Identifier);
      if (id) name = getText(content, id);
    } else if (child.type === JavaNodeType.Identifier && !name) {
      name = getText(content, child);
    } else {
      if (!type) type = getText(content, child);
    }
  }

  const modifiers = parseModifierKeywords(modifiersNode);
  const isConstant =
    node.type === JavaNodeType.ConstantDeclaration ||
    /^([A-Z][A-Z0-9_]*)$/.test(name);

  return {
    name,
    type,
    modifiers,
    annotations: extractAnnotationsFromModifiers(content, modifiersNode),
    comments,
    isConstant,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  };
}
