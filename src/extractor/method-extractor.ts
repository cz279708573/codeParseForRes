import type { Node } from 'web-tree-sitter';
import type { MethodInfo, CommentInfo, ParameterInfo } from '../model/types';
import { JavaNodeType } from '../model/types';
import { getText, namedChildren, parseModifierKeywords } from '../utils/node-helpers';
import { extractAnnotationsFromModifiers } from './annotation-extractor';

/**
 * 从 method_declaration / constructor_declaration 节点提取方法元信息。
 *
 * 节点结构（依探针实测）：
 *   method_declaration
 *     modifiers
 *     void_type | type_identifier | ... (返回类型)
 *     identifier (方法名)
 *     formal_parameters
 *       formal_parameter
 *         type_identifier
 *         identifier
 *     (可选) throws
 *     block (方法体)
 */
export function extractMethod(
  content: string,
  node: Node,
  comments: CommentInfo[],
  ownerClassName: string,
): MethodInfo {
  let name = '';
  let returnType = '';
  let modifiersNode: Node | undefined;
  let parameters: ParameterInfo[] = [];
  let throwsList: string[] = [];
  let bodyRange: { start: number; end: number } | undefined;
  let isConstructor = node.type === JavaNodeType.ConstructorDeclaration;

  for (const child of namedChildren(node)) {
    switch (child.type) {
      case JavaNodeType.Modifiers:
        modifiersNode = child;
        break;
      case JavaNodeType.Identifier:
        // 第一个非 modifiers 的 identifier 通常是方法名；
        // 后续 identifier 可能出现在 throws 等处，故只在 name 为空时赋值
        if (!name) name = getText(content, child);
        break;
      case JavaNodeType.FormalParameters:
        parameters = extractParameters(content, child);
        break;
      case JavaNodeType.Throws:
        throwsList = extractThrows(content, child);
        break;
      case JavaNodeType.Block:
        bodyRange = { start: child.startIndex, end: child.endIndex };
        break;
      default:
        // 类型节点：void_type / type_identifier / scoped_type / generic 等
        // 构造器没有返回类型节点
        if (!returnType && !isConstructor) {
          returnType = getText(content, child);
        }
        break;
    }
  }

  // 构造器判定：方法名与类名相同，且无返回类型
  if (!isConstructor && name === ownerClassName && !returnType) {
    isConstructor = true;
  }

  const modifiers = parseModifierKeywords(modifiersNode);

  return {
    name,
    returnType: isConstructor ? '' : returnType,
    parameters,
    modifiers,
    throws: throwsList,
    annotations: extractAnnotationsFromModifiers(content, modifiersNode),
    comments,
    bodyRange,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    isConstructor,
  };
}

function extractParameters(content: string, formalParams: Node): ParameterInfo[] {
  const out: ParameterInfo[] = [];
  for (const child of namedChildren(formalParams)) {
    if (child.type !== JavaNodeType.FormalParameter) continue;
    let type = '';
    let pname = '';
    for (const sub of namedChildren(child)) {
      if (sub.type === JavaNodeType.Identifier) {
        if (!pname) pname = getText(content, sub);
      } else if (sub.type === JavaNodeType.Modifiers) {
        // 形参修饰符（final 等）暂不入参
      } else {
        if (!type) type = getText(content, sub);
      }
    }
    out.push({ type, name: pname });
  }
  return out;
}

function extractThrows(content: string, throwsNode: Node): string[] {
  const out: string[] = [];
  for (const child of namedChildren(throwsNode)) {
    if (child.type === JavaNodeType.TypeIdentifier || child.type === JavaNodeType.ScopedIdentifier) {
      out.push(getText(content, child));
    }
  }
  return out;
}
