import type { AnnotationInfo, ClassInfo, MethodInfo } from '../model/types';

/**
 * 注解引用采集：把散落在类/字段/方法上的注解摊平成一维列表，
 * 用于"按注解名出单独页面"与"注解排行统计"。
 */

export type AnnotationTarget = 'class' | 'field' | 'method' | 'constructor';

export interface AnnotationOccurrence {
  /** 解析到的注解名（源码写全限定则记为全限定） */
  name: string;
  /** 注解简单名 */
  simpleName: string;
  /** 括号内原始文本，无参则空 */
  arguments?: string;
  /** 标注位置种类 */
  target: AnnotationTarget;
  /** 目标显示名：类名 / 字段名:类型 / 方法签名 */
  targetName: string;
  /** 目标成员名（类级为类简单名） */
  memberName: string;
  classFqn: string;
  classSimpleName: string;
  package: string;
  filePath: string;
  /** 注解在文件中的字符偏移 */
  startIndex: number;
  /** 行号（由 attachLineNumbers 补齐） */
  line?: number;
}

/** 方法签名：`name(Type,Type):Return`，构造器无返回类型 */
function methodSignature(m: MethodInfo): string {
  const params = m.parameters.map((p) => p.type).join(', ');
  return m.returnType ? `${m.name}(${params}):${m.returnType}` : `${m.name}(${params})`;
}

/**
 * 采集全部注解引用（含内部类递归）。
 */
export function collectAnnotationOccurrences(classes: ClassInfo[]): AnnotationOccurrence[] {
  const out: AnnotationOccurrence[] = [];
  for (const c of classes) walk(c, out);
  return out;
}

function walk(c: ClassInfo, out: AnnotationOccurrence[]): void {
  for (const a of c.annotations) {
    out.push(base(c, a, 'class', c.simpleName, c.simpleName));
  }

  for (const f of c.fields) {
    for (const a of f.annotations) {
      out.push(base(c, a, 'field', `${f.name}:${f.type}`, f.name));
    }
  }

  for (const m of c.methods) {
    for (const a of m.annotations) {
      out.push(base(c, a, m.isConstructor ? 'constructor' : 'method', methodSignature(m), m.name));
    }
  }

  for (const inner of c.innerClasses) walk(inner, out);
}

function base(
  c: ClassInfo,
  a: AnnotationInfo,
  target: AnnotationTarget,
  targetName: string,
  memberName: string,
): AnnotationOccurrence {
  return {
    name: a.name,
    simpleName: simpleOf(a.name),
    arguments: a.arguments,
    target,
    targetName,
    memberName,
    classFqn: c.fqn,
    classSimpleName: c.simpleName,
    package: c.package,
    filePath: c.filePath,
    startIndex: a.startIndex,
  };
}

function simpleOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : name;
}

/**
 * 按配置的注解名筛选引用。
 * 配置的简单名可匹配源码中写作全限定形式的同名注解，反之亦然。
 */
export function filterByAnnotationName(
  occurrences: AnnotationOccurrence[],
  configuredName: string,
): AnnotationOccurrence[] {
  const target = configuredName.trim().replace(/^@+/, '');
  const targetSimple = simpleOf(target);
  return occurrences.filter((o) => o.name === target || o.simpleName === targetSimple);
}
