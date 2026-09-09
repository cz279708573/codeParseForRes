import type { ClassInfo } from '../model/types';

/**
 * 简易符号解析器（一阶段简化版）。
 *
 * 规则：
 *  1. 同包同名类：短名 → 同包内 FQN
 *  2. 精确 import：import foo.Bar; → Bar 映射 foo.Bar
 *  3. 通配 import：import foo.*; → 短名 foo.<short> 作为候选
 *  4. java.lang 隐式可用
 *  5. 全局已知类名索引：若某短名全局唯一，直接解析
 *
 * 不做完整类型推断，跨类调用中未能解析者入 unresolvedSymbols。
 */
export class SymbolResolver {
  /** 短名 → FQN 候选集合 */
  private exactImports = new Map<string, string>();
  /** 通配包列表 */
  private wildcardPackages: string[] = [];
  /** 同包 */
  private samePackage = '';
  /** 全局索引：短名 → FQN 列表 */
  private globalIndex = new Map<string, string[]>();
  /** 全局已知 FQN 集合，用于通配包命中校验 */
  private fqnSet = new Set<string>();

  constructor(allClasses: ClassInfo[], currentFile: { pkg: string; imports: string[] }) {
    this.samePackage = currentFile.pkg;
    for (const imp of currentFile.imports) {
      // 形如 foo.Bar 或 foo.Bar.Inner
      if (imp.endsWith('.*')) {
        this.wildcardPackages.push(imp.slice(0, -2));
      } else {
        const idx = imp.lastIndexOf('.');
        if (idx > 0) {
          const short = imp.slice(idx + 1);
          this.exactImports.set(short, imp);
        }
      }
    }
    // java.lang.* 隐式
    this.wildcardPackages.push('java.lang');

    // 建立全局短名索引与 FQN 集合
    for (const c of allClasses) {
      this.fqnSet.add(c.fqn);
      const list = this.globalIndex.get(c.simpleName) ?? [];
      list.push(c.fqn);
      this.globalIndex.set(c.simpleName, list);
    }
  }

  /**
   * 将短名解析为 FQN（若可能）。
   * @returns FQN 或 null（未决）
   */
  resolve(short: string): string | null {
    if (!short) return null;
    // 全限定名直接返回
    if (short.includes('.')) return short;

    // 1. 精确 import
    const exact = this.exactImports.get(short);
    if (exact) return exact;

    // 2. 全局索引：短名 → 已知类 FQN
    const g = this.globalIndex.get(short);
    if (g) {
      const samePkgFqn = this.samePackage ? `${this.samePackage}.${short}` : short;
      // 同包 FQN 存在则优先
      if (g.includes(samePkgFqn)) return samePkgFqn;
      // 全局唯一则解析
      if (g.length === 1) return g[0];
      // 多义，未决
      return null;
    }

    // 3. 通配包：仅当候选 FQN 在全局索引中存在时才采用（避免误将局部变量
    //    解析为 java.lang.xxx）。java.lang.* 同样适用此规则。
    for (const pkg of this.wildcardPackages) {
      const candidate = `${pkg}.${short}`;
      if (this.fqnSet.has(candidate)) return candidate;
    }
    return null;
  }

  /**
   * 尽力解析短名为 FQN，不要求目标类在源码中存在。
   * 用于外部类调用的 best-effort 推测，配合 external 节点保持链路不断。
   * 规则：精确 import → 非java.lang通配包构造 → null
   * 注意：跳过 java.lang，避免将任意短名误推测为 java.lang.X
   */
  resolveBestEffort(short: string): string | null {
    if (!short) return null;
    if (short.includes('.')) return short;           // 已是 FQN
    const exact = this.exactImports.get(short);       // 精确 import
    if (exact) return exact;
    for (const pkg of this.wildcardPackages) {         // 通配包：直接构造，不查 fqnSet
      if (pkg === 'java.lang') continue;              // 跳过隐式 java.lang
      return `${pkg}.${short}`;                        // 取首个用户通配包
    }
    return null;
  }

  /**
   * 记录未决符号（带位置，供调用方聚合）。
   * @param list    未决符号收集列表
   * @param symbol  短名或原始文本
   * @param kind    未决种类
   * @param loc     位置信息（文件、起止下标）
   * @param ctx     所属类/方法上下文
   */
  markUnresolved(
    list: import('../model/types').UnresolvedSymbol[],
    symbol: string,
    kind: string,
    loc?: { file?: string; startIndex?: number; endIndex?: number },
    ctx?: { class?: string; member?: string },
  ): void {
    if (!symbol) return;
    list.push({
      symbol,
      kind,
      file: loc?.file,
      startIndex: loc?.startIndex,
      endIndex: loc?.endIndex,
      contextClass: ctx?.class,
      contextMember: ctx?.member,
    });
  }
}
