import type {
  AnnotationInfo,
  ClassInfo,
  Graph,
  GraphEdge,
  GraphNode,
  ParseResult,
  ParameterInfo,
} from '../model/types';

/**
 * 将 ParseResult 转换为纯图对象。
 *
 * 节点：类、方法、字段（皆为图中一等公民）。
 * 边：
 *   - contains          类含方法/字段
 *   - inherit/implement  类间继承/实现（沿用 ParseResult.relations）
 *   - override          子类方法重写父类方法（沿继承链 + 签名匹配）
 *   - implement-method  实现类方法实现接口方法（implement 关系 + 签名匹配）
 *   - call/field-access/instantiate  方法级关系（沿用 ParseResult.relations）
 *   - type-ref          字段/参数/返回类型引用类（轻量符号解析）
 *
 * 方法节点 ID 采用 `fqn#name`（不含参数），重载方法合并为一个节点。
 * 这样 call/instantiate 等仅有方法名的边也能精确锚定。
 */
export function toGraph(result: ParseResult): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // ---- 类索引与全局符号表 ----
  const classByFqn = new Map<string, ClassInfo>();
  // 短名 → FQN 列表
  const shortToFqns = new Map<string, string[]>();
  const fqnSet = new Set<string>();
  for (const c of result.classes) {
    classByFqn.set(c.fqn, c);
    fqnSet.add(c.fqn);
    const list = shortToFqns.get(c.simpleName) ?? [];
    list.push(c.fqn);
    shortToFqns.set(c.simpleName, list);
  }

  /** 轻量符号解析：短名唯一或全名命中即返回 FQN */
  const resolveType = (typeText: string): string | null => {
    if (!typeText) return null;
    // 去除泛型与数组
    const cleaned = typeText.replace(/[<\[].*$/, '').replace(/\s+/g, '');
    if (cleaned.includes('.')) {
      return fqnSet.has(cleaned) ? cleaned : null;
    }
    const list = shortToFqns.get(cleaned);
    if (!list || list.length === 0) return null;
    return list.length === 1 ? list[0] : null;
  };

  const methodId = (fqn: string, methodName: string) => `${fqn}#${methodName}`;
  const fieldId = (fqn: string, fieldName: string) => `${fqn}.${fieldName}`;

  // ---- 建节点 + contains 边 ----
  for (const c of result.classes) {
    nodes.push({
      id: c.fqn,
      type: 'class',
      label: c.simpleName,
      classFqn: c.fqn,
      kind: c.kind,
      modifiers: c.modifiers,
      annotations: c.annotations,
      comments: c.comments,
      filePath: c.filePath,
      startIndex: c.startIndex,
      endIndex: c.endIndex,
    });

    for (const f of c.fields) {
      nodes.push({
        id: fieldId(c.fqn, f.name),
        type: 'field',
        label: f.name,
        classFqn: c.fqn,
        dataType: f.type,
        modifiers: f.modifiers,
        annotations: f.annotations,
        comments: f.comments,
        filePath: c.filePath,
        startIndex: f.startIndex,
        endIndex: f.endIndex,
      });
      edges.push({ type: 'contains', source: c.fqn, target: fieldId(c.fqn, f.name) });
    }

    for (const m of c.methods) {
      nodes.push({
        id: methodId(c.fqn, m.name),
        type: 'method',
        label: m.name,
        classFqn: c.fqn,
        dataType: m.returnType,
        parameters: m.parameters,
        isConstructor: m.isConstructor,
        modifiers: m.modifiers,
        annotations: m.annotations,
        comments: m.comments,
        filePath: c.filePath,
        startIndex: m.startIndex,
        endIndex: m.endIndex,
      });
      edges.push({ type: 'contains', source: c.fqn, target: methodId(c.fqn, m.name) });
    }
  }

  // ---- 沿用 ParseResult.relations 映射为图边 ----
  for (const r of result.relations) {
    const srcMember = r.source.member;
    const tgtMember = r.target.member;
    let srcId: string;
    let tgtId: string;
    if (srcMember) {
      srcId = methodId(r.source.class, srcMember);
    } else {
      srcId = r.source.class;
    }
    if (tgtMember) {
      // call → 方法节点；field-access → 字段节点
      tgtId = r.type === 'field-access'
        ? fieldId(r.target.class, tgtMember)
        : methodId(r.target.class, tgtMember);
    } else {
      tgtId = r.target.class;
    }
    edges.push({
      type: r.type,
      source: srcId,
      target: tgtId,
      evidence: r.evidence,
    });
  }

  // ---- override：子类方法沿继承链匹配父类同名同参方法 ----
  for (const c of result.classes) {
    if (c.kind !== 'class' && c.kind !== 'record') continue;
    for (const m of c.methods) {
      const owner = findOverrideOwner(c, m, classByFqn, resolveType);
      if (owner) {
        edges.push({
          type: 'override',
          source: methodId(c.fqn, m.name),
          target: methodId(owner.fqn, m.name),
          evidence: { file: c.filePath, startIndex: m.startIndex, endIndex: m.endIndex },
        });
      }
    }
  }

  // ---- implement-method：实现类方法对应接口方法 ----
  for (const c of result.classes) {
    if (c.kind !== 'class' && c.kind !== 'record') continue;
    for (const ifaceName of c.interfaces) {
      const ifaceFqn = resolveType(ifaceName) ?? ifaceName;
      const iface = classByFqn.get(ifaceFqn);
      if (!iface || iface.kind !== 'interface') continue;
      for (const m of c.methods) {
        const im = iface.methods.find((x) => x.name === m.name && sameSignature(x, m));
        if (im) {
          edges.push({
            type: 'implement-method',
            source: methodId(c.fqn, m.name),
            target: methodId(iface.fqn, im.name),
            evidence: { file: c.filePath, startIndex: m.startIndex, endIndex: m.endIndex },
          });
        }
      }
    }
  }

  // ---- type-ref：字段/参数/返回类型引用类 ----
  for (const c of result.classes) {
    for (const f of c.fields) {
      const refFqn = resolveType(f.type);
      if (refFqn && refFqn !== c.fqn) {
        edges.push({
          type: 'type-ref',
          source: fieldId(c.fqn, f.name),
          target: refFqn,
        });
      }
    }
    for (const m of c.methods) {
      const retRef = resolveType(m.returnType);
      if (retRef && retRef !== c.fqn) {
        edges.push({ type: 'type-ref', source: methodId(c.fqn, m.name), target: retRef });
      }
      for (const p of m.parameters) {
        const pRef = resolveType(p.type);
        if (pRef && pRef !== c.fqn) {
          edges.push({ type: 'type-ref', source: methodId(c.fqn, m.name), target: pRef });
        }
      }
    }
    // 父类与接口也作为类的 type-ref
    if (c.superClass) {
      const ref = resolveType(c.superClass);
      if (ref && ref !== c.fqn) edges.push({ type: 'type-ref', source: c.fqn, target: ref });
    }
    for (const iface of c.interfaces) {
      const ref = resolveType(iface);
      if (ref && ref !== c.fqn) edges.push({ type: 'type-ref', source: c.fqn, target: ref });
    }
  }

  // ---- annotate：有参注解立节点 + annotate 边 + 参数内类型引用 type-ref 边 ----
  // 无参注解（marker）止于属性，不立节点；有参注解因属性可能引用其他类型而立节点。
  for (const c of result.classes) {
    // 类级注解
    addAnnotationNodes(c, c.fqn, c.annotations, c.filePath, nodes, edges, resolveType);
    for (const f of c.fields) {
      addAnnotationNodes(c, fieldId(c.fqn, f.name), f.annotations, c.filePath, nodes, edges, resolveType);
    }
    for (const m of c.methods) {
      addAnnotationNodes(c, methodId(c.fqn, m.name), m.annotations, c.filePath, nodes, edges, resolveType);
    }
  }

  return { nodes, edges };
}

/**
 * 为"有参注解"建立 annotation 节点与 annotate 边，并从参数文本中抽取
 * `X.class` 形式的类型引用，补 type-ref 边。
 *
 * 无参注解（marker，arguments 为空）不立节点，保留为宿主节点属性。
 */
function addAnnotationNodes(
  cls: ClassInfo,
  ownerId: string,
  annotations: { name: string; arguments?: string; startIndex: number; endIndex: number }[],
  filePath: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  resolveType: (t: string) => string | null,
) {
  for (const a of annotations) {
    if (!a.arguments || !a.arguments.trim()) continue;
    const annoId = `${ownerId}@${a.name}`;
    nodes.push({
      id: annoId,
      type: 'annotation',
      label: '@' + a.name,
      classFqn: cls.fqn,
      annotations: [a as AnnotationInfo],
      filePath,
      startIndex: a.startIndex,
      endIndex: a.endIndex,
    });
    edges.push({ type: 'annotate', source: ownerId, target: annoId });
    // 抽取参数中 X.class 形式的类型引用
    for (const ref of extractClassRefs(a.arguments)) {
      const fqn = resolveType(ref);
      if (fqn && fqn !== cls.fqn) {
        edges.push({ type: 'type-ref', source: annoId, target: fqn });
      }
    }
  }
}

/**
 * 从注解参数文本中抽取 `X.class` / `a.b.C.class` 形式的类型引用。
 * 去重后返回，不解析，交由调用方 resolveType。
 */
function extractClassRefs(args: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.class\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    const t = m[1];
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** 沿继承链找首个含同名同参方法的祖先类 */
function findOverrideOwner(
  cls: ClassInfo,
  method: { name: string; parameters: ParameterInfo[] },
  classByFqn: Map<string, ClassInfo>,
  resolveType: (t: string) => string | null,
): ClassInfo | null {
  if (!cls.superClass) return null;
  const superFqn = resolveType(cls.superClass) ?? cls.superClass;
  let cur = classByFqn.get(superFqn);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.fqn)) {
    guard.add(cur.fqn);
    const match = cur.methods.find((x) => x.name === method.name && sameSignature(x, method));
    if (match) return cur;
    if (!cur.superClass) break;
    const nextFqn = resolveType(cur.superClass) ?? cur.superClass;
    cur = classByFqn.get(nextFqn);
  }
  return null;
}

/** 简易签名匹配：参数个数 + 逐个类型文本相同 */
function sameSignature(
  a: { parameters: ParameterInfo[] },
  b: { parameters: ParameterInfo[] },
): boolean {
  if (a.parameters.length !== b.parameters.length) return false;
  for (let i = 0; i < a.parameters.length; i++) {
    if (normalizeType(a.parameters[i].type) !== normalizeType(b.parameters[i].type)) return false;
  }
  return true;
}

/** 类型文本归一：去泛型与数组，去空白 */
function normalizeType(t: string): string {
  return t.replace(/[<\[].*$/, '').replace(/\s+/g, '');
}
