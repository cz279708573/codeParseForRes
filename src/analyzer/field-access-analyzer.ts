import type { Node } from 'web-tree-sitter';
import type { ClassInfo, MethodInfo, Relation, UnresolvedSymbol } from '../model/types';
import { JavaNodeType } from '../model/types';
import { namedChildren, getText } from '../utils/node-helpers';
import type { SymbolResolver } from '../resolver/symbol-resolver';
import { collectLocalTypes, resolveFieldOwner, resolveObjectClass } from './call-relation-analyzer';

/**
 * 构建属性访问关系。
 *
 * 一阶段简化策略：
 *  - field_access 的 object 为 this → 同类属性访问
 *  - object 为 super → 父类属性
 *  - object 为 identifier 且可解析为类 FQN → 目标类静态属性
 *  - 其余 → unresolved
 */
export function analyzeFieldAccess(
  root: Node,
  content: string,
  classes: ClassInfo[],
  resolver: SymbolResolver,
  unresolved: UnresolvedSymbol[],
): Relation[] {
  const relations: Relation[] = [];
  const classByStart = new Map<number, ClassInfo>();
  const methodByStart = new Map<number, { cls: ClassInfo; m: MethodInfo }>();
  const fqnToClass = new Map<string, ClassInfo>();
  for (const c of classes) {
    flatten(c, classByStart, methodByStart, fqnToClass);
  }

  visit(root, null, null, null);

  function visit(
    node: Node,
    curClass: ClassInfo | null,
    curMethod: MethodInfo | null,
    localTypes: Map<string, string> | null,
  ) {
    let nextClass = curClass;
    let nextMethod = curMethod;
    let nextLocals = localTypes;
    if (
      node.type === JavaNodeType.ClassDeclaration ||
      node.type === JavaNodeType.InterfaceDeclaration ||
      node.type === JavaNodeType.EnumDeclaration ||
      node.type === JavaNodeType.RecordDeclaration
    ) {
      const m = classByStart.get(node.startIndex);
      if (m) nextClass = m;
    } else if (
      node.type === JavaNodeType.MethodDeclaration ||
      node.type === JavaNodeType.ConstructorDeclaration
    ) {
      const m = methodByStart.get(node.startIndex);
      if (m) {
        nextClass = m.cls;
        nextMethod = m.m;
        nextLocals = collectLocalTypes(node, content);
      }
    } else if (node.type === JavaNodeType.FieldAccess && curClass && curMethod) {
      handle(node, curClass, curMethod, localTypes);
    }
    for (const child of namedChildren(node)) {
      visit(child, nextClass, nextMethod, nextLocals);
    }
  }

  function handle(node: Node, curClass: ClassInfo, curMethod: MethodInfo, localTypes: Map<string, string> | null) {
    let name = '';
    let objectNode: Node | undefined;
    const nodeWithField = node as unknown as { fieldNameForChild?(i: number): string | null };
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const field = nodeWithField.fieldNameForChild?.(i) ?? null;
      if (field === 'object') {
        objectNode = child;
      } else if (child.type === JavaNodeType.Identifier && !name) {
        name = getText(content, child);
      }
    }
    if (!name) return;

    if (!objectNode || objectNode.type === JavaNodeType.This) {
      // this.name 或无 object：本类及父类字段
      const owner = resolveFieldOwner(curClass, name, fqnToClass, resolver);
      if (owner) {
        relations.push({
          type: 'field-access',
          source: { class: curClass.fqn, member: curMethod.name },
          target: { class: owner.owner.fqn, member: name },
          evidence: { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
        });
      }
      return;
    }
    if (objectNode.type === JavaNodeType.Super) {
      if (curClass.superClass) {
        const targetFqn = resolver.resolve(curClass.superClass) ?? curClass.superClass;
        relations.push({
          type: 'field-access',
          source: { class: curClass.fqn, member: curMethod.name },
          target: { class: targetFqn, member: name },
          evidence: { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
        });
      }
      return;
    }
    if (objectNode.type === JavaNodeType.Identifier) {
      const objText = getText(content, objectNode);
      // 查局部变量/字段/类名
      const targetFqn = resolveObjectClass(objText, curClass, localTypes, fqnToClass, resolver);
      if (targetFqn) {
        relations.push({
          type: 'field-access',
          source: { class: curClass.fqn, member: curMethod.name },
          target: { class: targetFqn, member: name },
          evidence: { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
        });
      } else {
        resolver.markUnresolved(
          unresolved,
          objText,
          'field-object',
          { file: curClass.filePath, startIndex: objectNode.startIndex, endIndex: objectNode.endIndex },
          { class: curClass.fqn, member: curMethod.name },
        );
      }
    }
  }

  return relations;
}

function flatten(
  cls: ClassInfo,
  classByStart: Map<number, ClassInfo>,
  methodByStart: Map<number, { cls: ClassInfo; m: MethodInfo }>,
  fqnToClass: Map<string, ClassInfo>,
) {
  classByStart.set(cls.startIndex, cls);
  fqnToClass.set(cls.fqn, cls);
  for (const m of cls.methods) {
    methodByStart.set(m.startIndex, { cls, m });
  }
  for (const inner of cls.innerClasses) {
    flatten(inner, classByStart, methodByStart, fqnToClass);
  }
}
