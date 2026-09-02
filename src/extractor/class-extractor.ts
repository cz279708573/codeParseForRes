import type { Node } from 'web-tree-sitter';
import type { ClassInfo, ClassKind, CommentInfo } from '../model/types';
import { JavaNodeType } from '../model/types';
import { getText, namedChildren, firstNamedChild, parseModifierKeywords } from '../utils/node-helpers';
import { extractAnnotationsFromModifiers } from './annotation-extractor';
import { extractComment, isEmptyComment } from './comment-extractor';
import { extractField } from './field-extractor';
import { extractMethod } from './method-extractor';

/**
 * 遍历 class_body / interface_body / enum_body，按出现顺序产出"声明项 + 前置注释"序列。
 *
 * 参考工程 [codeParser.ts:135-166] parseSubItems 的策略：注释作为兄弟节点
 * 紧邻在被注释节点之前出现，按顺序累积，遇到下一个非注释节点即归它所有。
 */
export interface BodyEntry {
  node: Node;
  comments: CommentInfo[];
}

export function collectBodyEntries(content: string, bodyNode: Node): BodyEntry[] {
  const entries: BodyEntry[] = [];
  let pendingComments: CommentInfo[] = [];

  for (const child of namedChildren(bodyNode)) {
    if (
      child.type === JavaNodeType.Comment ||
      child.type === JavaNodeType.LineComment ||
      child.type === JavaNodeType.BlockComment
    ) {
      pendingComments.push(extractComment(content, child));
      continue;
    }
    // 仅处理"声明类"节点；其余（如 ; 等）忽略
    if (isDeclarationNode(child)) {
      entries.push({ node: child, comments: pendingComments });
      pendingComments = [];
    } else {
      // 遇到非声明非注释节点，清空挂起注释（避免误关联）
      pendingComments = [];
    }
  }
  return entries;
}

function isDeclarationNode(node: Node): boolean {
  return (
    node.type === JavaNodeType.MethodDeclaration ||
    node.type === JavaNodeType.ConstructorDeclaration ||
    node.type === JavaNodeType.FieldDeclaration ||
    node.type === JavaNodeType.ConstantDeclaration ||
    node.type === JavaNodeType.ClassDeclaration ||
    node.type === JavaNodeType.InterfaceDeclaration ||
    node.type === JavaNodeType.EnumDeclaration ||
    node.type === JavaNodeType.RecordDeclaration ||
    node.type === 'enum_constant'
  );
}

/**
 * 从 class/interface/enum/record_declaration 节点提取类元信息。
 * 递归处理内部类。
 *
 * @param content    源码全文
 * @param node       类声明节点
 * @param pkg        所属包
 * @param filePath   文件路径
 * @param comments   紧邻此类之前的前置注释
 */
export function extractClass(
  content: string,
  node: Node,
  pkg: string,
  filePath: string,
  comments: CommentInfo[],
): ClassInfo {
  const kind = mapKind(node);
  let name = '';
  let modifiersNode: Node | undefined;
  let superClass: string | undefined;
  let interfaces: string[] = [];
  let fields = [];
  let methods = [];
  let innerClasses = [];

  for (const child of namedChildren(node)) {
    switch (child.type) {
      case JavaNodeType.Modifiers:
        modifiersNode = child;
        break;
      case JavaNodeType.Identifier:
        if (!name) name = getText(content, child);
        break;
      case JavaNodeType.Superclass: {
        const tid = firstNamedChild(child, JavaNodeType.TypeIdentifier) ||
          firstNamedChild(child, JavaNodeType.ScopedIdentifier);
        if (tid) superClass = getText(content, tid);
        break;
      }
      case JavaNodeType.SuperInterfaces: {
        const list = firstNamedChild(child, JavaNodeType.TypeList);
        if (list) {
          interfaces = namedChildren(list)
            .filter(
              (n) =>
                n.type === JavaNodeType.TypeIdentifier ||
                n.type === JavaNodeType.ScopedIdentifier,
            )
            .map((n) => getText(content, n));
        } else {
          // 某些情况下 super_interfaces 直接含 type_identifier（单接口无 type_list）
          interfaces = namedChildren(child)
            .filter(
              (n) =>
                n.type === JavaNodeType.TypeIdentifier ||
                n.type === JavaNodeType.ScopedIdentifier,
            )
            .map((n) => getText(content, n));
        }
        break;
      }
      case JavaNodeType.ClassBody:
      case JavaNodeType.InterfaceBody:
      case JavaNodeType.EnumBody: {
        const entries = collectBodyEntries(content, child);
        for (const e of entries) {
          if (
            e.node.type === JavaNodeType.ClassDeclaration ||
            e.node.type === JavaNodeType.InterfaceDeclaration ||
            e.node.type === JavaNodeType.EnumDeclaration ||
            e.node.type === JavaNodeType.RecordDeclaration
          ) {
            innerClasses.push(extractClass(content, e.node, pkg, filePath, e.comments));
          } else if (
            e.node.type === JavaNodeType.MethodDeclaration ||
            e.node.type === JavaNodeType.ConstructorDeclaration
          ) {
            methods.push(extractMethod(content, e.node, e.comments, name));
          } else if (
            e.node.type === JavaNodeType.FieldDeclaration ||
            e.node.type === JavaNodeType.ConstantDeclaration ||
            e.node.type === 'enum_constant'
          ) {
            fields.push(extractField(content, e.node, e.comments));
          }
        }
        break;
      }
      default:
        // record 的 header / 其他节点暂忽略
        break;
    }
  }

  const modifiers = parseModifierKeywords(modifiersNode);
  const annotations = extractAnnotationsFromModifiers(content, modifiersNode);
  const fqn = pkg ? `${pkg}.${name}` : name;
  const filteredComments = comments.filter((c) => !isEmptyComment(c));

  return {
    kind,
    name,
    simpleName: name,
    package: pkg,
    filePath,
    fqn,
    modifiers,
    annotations,
    comments: filteredComments,
    superClass,
    interfaces,
    fields,
    methods,
    innerClasses,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  };
}

function mapKind(node: Node): ClassKind {
  switch (node.type) {
    case JavaNodeType.ClassDeclaration:
      return 'class';
    case JavaNodeType.InterfaceDeclaration:
      return 'interface';
    case JavaNodeType.EnumDeclaration:
      return 'enum';
    case JavaNodeType.RecordDeclaration:
      return 'record';
    default:
      return 'class';
  }
}
