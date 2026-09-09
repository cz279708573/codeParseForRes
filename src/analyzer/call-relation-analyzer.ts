import type { Node } from 'web-tree-sitter';
import type { ClassInfo, MethodInfo, Relation, UnresolvedSymbol } from '../model/types';
import { JavaNodeType } from '../model/types';
import { namedChildren, getText } from '../utils/node-helpers';
import type { SymbolResolver } from '../resolver/symbol-resolver';

/**
 * 构建方法调用关系。
 *
 * 一阶段简化策略：
 *  - method_invocation 无 object（仅 name + args）→ 视为同类内部调用
 *  - object 为 this → 同类内部调用
 *  - object 为 identifier 且该 identifier 可解析为类 FQN → 目标类 + name（静态/同类实例方法）
 *  - 其余（field_access 链、复杂表达式）→ 记 unresolved
 */
export function analyzeCallRelations(
  root: Node,
  content: string,
  classes: ClassInfo[],
  resolver: SymbolResolver,
  unresolved: UnresolvedSymbol[],
): Relation[] {
  const relations: Relation[] = [];
  // 扁平化类与方法，按 startIndex 索引；同时建 FQN→ClassInfo 用于父类链查找
  const classByStart = new Map<number, ClassInfo>();
  const methodByStart = new Map<number, { cls: ClassInfo; m: MethodInfo }>();
  const fqnToClass = new Map<string, ClassInfo>();
  for (const c of classes) {
    flattenClasses(c, classByStart, methodByStart, fqnToClass);
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
      const matched = classByStart.get(node.startIndex);
      if (matched) nextClass = matched;
    } else if (
      node.type === JavaNodeType.MethodDeclaration ||
      node.type === JavaNodeType.ConstructorDeclaration
    ) {
      const matched = methodByStart.get(node.startIndex);
      if (matched) {
        nextClass = matched.cls;
        nextMethod = matched.m;
        // 进入方法体：扫描局部变量声明建表
        nextLocals = collectLocalTypes(node, content);
      }
    } else if (node.type === JavaNodeType.MethodInvocation && curClass && curMethod) {
      handleMethodInvocation(
        node,
        curClass,
        curMethod,
        relations,
        content,
        resolver,
        unresolved,
        fqnToClass,
        localTypes,
      );
    } else if (node.type === JavaNodeType.ObjectCreation && curClass && curMethod) {
      handleObjectCreation(node, curClass, curMethod, relations, content, resolver, unresolved, localTypes, fqnToClass);
    }

    for (const child of namedChildren(node)) {
      visit(child, nextClass, nextMethod, nextLocals);
    }
  }

  return relations;
}

/**
 * 处理 object_creation_expression：方法体内 `new Foo()` 创建类实例。
 * 产出 instantiate 边：方法 → 类。
 *
 * 节点结构：object_creation_expression 下首个 type_identifier/scoped_identifier 为类型；
 * object_creation_expression 可内嵌 method_invocation（匿名类/链式），此处不处理。
 */
function handleObjectCreation(
  node: Node,
  curClass: ClassInfo,
  curMethod: MethodInfo,
  relations: Relation[],
  content: string,
  resolver: SymbolResolver,
  unresolved: UnresolvedSymbol[],
  localTypes: Map<string, string> | null,
  fqnToClass: Map<string, ClassInfo>,
) {
  let typeText = '';
  for (const child of namedChildren(node)) {
    if (child.type === JavaNodeType.TypeIdentifier || child.type === JavaNodeType.ScopedIdentifier) {
      typeText = getText(content, child);
      break;
    }
  }
  if (!typeText) return;
  // new Foo() 中 Foo 既可能是类名，也可能是局部变量引用（极少见）；先按类名解析
  const targetFqn = resolveObjectClass(typeText, curClass, localTypes, fqnToClass, resolver);
  if (targetFqn) {
    relations.push({
      type: 'instantiate',
      source: { class: curClass.fqn, member: curMethod.name },
      target: { class: targetFqn },
      evidence: { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
    });
    // 若目标类不在源码中（external），仍记审计痕迹
    if (!fqnToClass.has(targetFqn)) {
      resolver.markUnresolved(
        unresolved,
        typeText,
        'instantiate-type-external',
        { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
        { class: curClass.fqn, member: curMethod.name },
      );
    }
  } else {
    resolver.markUnresolved(
      unresolved,
      typeText,
      'instantiate-type',
      { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
      { class: curClass.fqn, member: curMethod.name },
    );
  }
}

// flattenClasses 定义于文件末尾（四参版本，含 fqnToClass）

function handleMethodInvocation(
  node: Node,
  curClass: ClassInfo,
  curMethod: MethodInfo,
  relations: Relation[],
  content: string,
  resolver: SymbolResolver,
  unresolved: UnresolvedSymbol[],
  fqnToClass: Map<string, ClassInfo>,
  localTypes: Map<string, string> | null,
) {
  let name = '';
  let objectNode: Node | undefined;
  // method_invocation 子节点字段名：object（可选）/ 方法名 identifier（field=null）/ argument_list（field='name'）
  // 依探针实测：方法名 identifier 的 fieldName 为 null，argument_list 的 fieldName 为 'name'。
  const nodeWithField = node as unknown as { fieldNameForChild?(i: number): string | null };
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const field = nodeWithField.fieldNameForChild?.(i) ?? null;
    if (field === 'object') {
      objectNode = child;
    } else if (child.type === JavaNodeType.ArgumentList) {
      continue;
    } else if (child.type === JavaNodeType.Identifier && !name) {
      // 方法名 identifier（field 通常为 null）
      name = getText(content, child);
    }
  }
  if (!name) return;

  // 情况 1：无 object 或 object 为 this → 本类或父类链调用
  if (!objectNode || objectNode.type === JavaNodeType.This) {
    const owner = resolveMethodOwner(curClass, name, fqnToClass, resolver);
    if (owner) {
      relations.push({
        type: 'call',
        source: { class: curClass.fqn, member: curMethod.name },
        target: { class: owner.fqn, member: name },
        evidence: { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
      });
    } else {
      // 回退：查找首个外部父类，将调用挂到 external 节点
      const externalParentFqn = findExternalParent(curClass, fqnToClass, resolver);
      if (externalParentFqn) {
        relations.push({
          type: 'call',
          source: { class: curClass.fqn, member: curMethod.name },
          target: { class: externalParentFqn, member: name },
          evidence: { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
        });
        resolver.markUnresolved(
          unresolved,
          name,
          'call-name-external',
          { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
          { class: curClass.fqn, member: curMethod.name },
        );
      } else {
        resolver.markUnresolved(
          unresolved,
          name,
          'call-name',
          { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
          { class: curClass.fqn, member: curMethod.name },
        );
      }
    }
    return;
  }

  // 情况 2：object 为 super → 父类调用
  if (objectNode.type === JavaNodeType.Super) {
    if (curClass.superClass) {
      const targetFqn = resolver.resolve(curClass.superClass) ?? curClass.superClass;
      relations.push({
        type: 'call',
        source: { class: curClass.fqn, member: curMethod.name },
        target: { class: targetFqn, member: name },
        evidence: { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
      });
    } else {
      resolver.markUnresolved(
        unresolved,
        name,
        'call-super',
        { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
        { class: curClass.fqn, member: curMethod.name },
      );
    }
    return;
  }

  // 情况 3：object 为 identifier → 按局部变量类型 / 字段类型 / 类名解析
  if (objectNode.type === JavaNodeType.Identifier) {
    const objText = getText(content, objectNode);
    const targetFqn = resolveObjectClass(objText, curClass, localTypes, fqnToClass, resolver);
    if (targetFqn) {
      relations.push({
        type: 'call',
        source: { class: curClass.fqn, member: curMethod.name },
        target: { class: targetFqn, member: name },
        evidence: { file: curClass.filePath, startIndex: node.startIndex, endIndex: node.endIndex },
      });
      // 若目标类不在源码中（external），仍记审计痕迹
      if (!fqnToClass.has(targetFqn)) {
        resolver.markUnresolved(
          unresolved,
          objText,
          'call-object-external',
          { file: curClass.filePath, startIndex: objectNode.startIndex, endIndex: objectNode.endIndex },
          { class: curClass.fqn, member: curMethod.name },
        );
      }
    } else {
      resolver.markUnresolved(
        unresolved,
        objText,
        'call-object',
        { file: curClass.filePath, startIndex: objectNode.startIndex, endIndex: objectNode.endIndex },
        { class: curClass.fqn, member: curMethod.name },
      );
    }
    return;
  }

  // 情况 4：field_access 等，一阶段不解析
  resolver.markUnresolved(
    unresolved,
    getText(content, objectNode),
    'call-object',
    { file: curClass.filePath, startIndex: objectNode.startIndex, endIndex: objectNode.endIndex },
    { class: curClass.fqn, member: curMethod.name },
  );
}

/**
 * 解析 method_invocation / field_access 的 object 文本为类 FQN。
 *
 * 查询顺序（二阶段增强）：
 *  1. 局部变量表（方法体内 local_variable_declaration 收集）
 *  2. 字段链（本类及父类的 field.type，沿继承链）
 *  3. 类名解析（resolver.resolve，精确 import / 全局已知）
 *
 * 命中类型短名后，再经 resolver 解析为 FQN。
 */
export function resolveObjectClass(
  objText: string,
  curClass: ClassInfo,
  localTypes: Map<string, string> | null,
  fqnToClass: Map<string, ClassInfo>,
  resolver: SymbolResolver,
): string | null {
  // 1. 局部变量
  const localType = localTypes?.get(objText);
  if (localType) {
    const fqn = resolveOrBestEffort(resolver, localType);
    if (fqn) return fqn;
  }
  // 2. 字段链
  const fieldOwner = resolveFieldOwner(curClass, objText, fqnToClass, resolver);
  if (fieldOwner) {
    const fqn = resolveOrBestEffort(resolver, fieldOwner.type);
    if (fqn) return fqn;
  }
  // 3. 类名
  return resolveOrBestEffort(resolver, objText);
}

/**
 * 先精确解析（要求源码命中），再 best-effort 推测（不要求源码命中）。
 * 前者返回的 FQN 一定有对应源码类；后者用于外部类，配合 external 节点保持链路不断。
 */
function resolveOrBestEffort(resolver: SymbolResolver, short: string): string | null {
  return resolver.resolve(short) ?? resolver.resolveBestEffort(short);
}

/**
 * 沿继承链查找名为 methodName 的方法所属类。
 * 从 curClass 起，依次检查本类 methods；未命中则跳到 superClass（经 resolver 解析）继续。
 */
function resolveMethodOwner(
  start: ClassInfo,
  methodName: string,
  fqnToClass: Map<string, ClassInfo>,
  resolver: SymbolResolver,
): ClassInfo | null {
  let cur: ClassInfo | undefined = start;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.fqn)) {
    guard.add(cur.fqn);
    if (cur.methods.some((m) => m.name === methodName)) return cur;
    if (!cur.superClass) break;
    const superFqn = resolver.resolve(cur.superClass) ?? cur.superClass;
    cur = fqnToClass.get(superFqn);
  }
  return null;
}

/**
 * 沿继承链查找首个不在源码中的外部父类 FQN。
 * 当 resolveMethodOwner 因父类不在源码中断链时，用此函数获取外部父类以建边。
 */
function findExternalParent(
  start: ClassInfo,
  fqnToClass: Map<string, ClassInfo>,
  resolver: SymbolResolver,
): string | null {
  let cur: ClassInfo | undefined = start;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.fqn)) {
    guard.add(cur.fqn);
    if (!cur.superClass) break;
    const superFqn = resolver.resolve(cur.superClass) ?? cur.superClass;
    if (!fqnToClass.has(superFqn)) return superFqn;
    cur = fqnToClass.get(superFqn);
  }
  return null;
}

function flattenClasses(
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
    flattenClasses(inner, classByStart, methodByStart, fqnToClass);
  }
}

/**
 * 扫描方法体内（含嵌套块）所有 local_variable_declaration 与 enhanced_for_statement，
 * 建立"变量名 → 类型文本"映射。
 *
 * 节点结构（依探针实测）：
 *   local_variable_declaration
 *     type_identifier / scoped_type / ...  ← 类型
 *     variable_declarator
 *       identifier                          ← 变量名
 *       (可选) 初始化表达式
 *
 *   enhanced_for_statement（增强 for 循环）
 *     type_identifier / scoped_type / ...   ← 类型
 *     identifier                             ← 变量名
 *     identifier / method_invocation / ...   ← 迭代表达式
 *     block
 *
 * 增强声明 `Bar b;` 与带初始化 `Bar b = new Bar();` 同构。
 * 本简化版不区分作用域嵌套，全方法体共用一张表。
 */
export function collectLocalTypes(methodNode: Node, content: string): Map<string, string> {
  const map = new Map<string, string>();
  walkFor(methodNode, (n) => {
    if (n.type === 'local_variable_declaration' || n.type === JavaNodeType.FormalParameter) {
      const { typeText, varNames } = extractTypeAndNames(n, content);
      if (typeText) {
        for (const v of varNames) map.set(v, typeText);
      }
    } else if (n.type === 'enhanced_for_statement') {
      // 增强for循环：type → varName → iterExpr → block
      const { typeText, varName } = extractEnhancedForVar(n, content);
      if (typeText && varName) map.set(varName, typeText);
    }
  });
  return map;
}

/**
 * 从 enhanced_for_statement 提取类型与变量名。
 * 结构：modifiers? → 类型 → 变量名(identifier) → 迭代表达式 → block
 * 仅取类型与首个 identifier（变量名），跳过迭代表达式。
 */
function extractEnhancedForVar(
  node: Node,
  content: string,
): { typeText: string; varName: string } {
  let typeText = '';
  let varName = '';
  for (const child of namedChildren(node)) {
    if (child.type === JavaNodeType.Modifiers) continue;
    if (!typeText) {
      // 首个非 modifiers 节点为类型
      typeText = getText(content, child);
      continue;
    }
    if (!varName && child.type === JavaNodeType.Identifier) {
      // 类型之后的首个 identifier 为变量名
      varName = getText(content, child);
      break;
    }
  }
  return { typeText, varName };
}

/**
 * 从声明式节点（local_variable_declaration / formal_parameter）提取类型文本与变量名列表。
 *
 * 规则：
 *  - 跳过 Modifiers
 *  - 首个非 modifiers、非 variable_declarator、非 identifier 节点为类型（type_identifier 等）
 *  - variable_declarator 下首个 identifier（非初始化）为变量名（local_variable_declaration）
 *  - formal_parameter 无 variable_declarator，其下 bare identifier 即变量名（位于类型之后）
 */
function extractTypeAndNames(
  node: Node,
  content: string,
): { typeText: string; varNames: string[] } {
  let typeText = '';
  const varNames: string[] = [];
  for (const child of namedChildren(node)) {
    if (child.type === JavaNodeType.Modifiers) continue;
    if (child.type === JavaNodeType.VariableDeclarator) {
      for (const sub of namedChildren(child)) {
        if (sub.type === JavaNodeType.Identifier && !isInitializationIdentifier(sub)) {
          varNames.push(getText(content, sub));
        }
      }
    } else if (child.type === JavaNodeType.Identifier) {
      // formal_parameter 中的 bare identifier 为变量名（tree-sitter 中类型节点为 type_identifier，与 identifier 区分）
      varNames.push(getText(content, child));
    } else if (!typeText) {
      // 首个非 modifiers、非 variable_declarator、非 identifier 节点为类型
      typeText = getText(content, child);
    }
  }
  return { typeText, varNames };
}

/** 判断 identifier 是否为初始化表达式的一部分（简化：variable_declarator 下首个 identifier 为变量名） */
function isInitializationIdentifier(_node: Node): boolean {
  return false;
}

/** 简易 DFS 遍历命名子节点 */
function walkFor(node: Node, cb: (n: Node) => void) {
  cb(node);
  for (const child of namedChildren(node)) walkFor(child, cb);
}

/**
 * 沿继承链查找名为 fieldName 的属性所属类及其类型。
 * 返回 { owner: ClassInfo, type: string } 或 null。
 */
export function resolveFieldOwner(
  start: ClassInfo,
  fieldName: string,
  fqnToClass: Map<string, ClassInfo>,
  resolver: SymbolResolver,
): { owner: ClassInfo; type: string } | null {
  let cur: ClassInfo | undefined = start;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.fqn)) {
    guard.add(cur.fqn);
    const f = cur.fields.find((x) => x.name === fieldName);
    if (f) return { owner: cur, type: f.type };
    if (!cur.superClass) break;
    const superFqn = resolver.resolve(cur.superClass) ?? cur.superClass;
    cur = fqnToClass.get(superFqn);
  }
  return null;
}
