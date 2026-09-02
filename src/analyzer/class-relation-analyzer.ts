import type { ClassInfo, Relation, UnresolvedSymbol } from '../model/types';
import type { SymbolResolver } from '../resolver/symbol-resolver';

/**
 * 构建类间关系：继承与实现。
 * 目标符号经 SymbolResolver 解析为 FQN；未决者带位置记入 unresolvedSymbols。
 */
export function analyzeClassRelations(
  classes: ClassInfo[],
  resolverPerClass: Map<string, SymbolResolver>,
  unresolved: UnresolvedSymbol[],
): Relation[] {
  const relations: Relation[] = [];
  for (const cls of classes) {
    const resolver = resolverPerClass.get(cls.fqn);
    if (cls.superClass) {
      const target = resolver ? resolver.resolve(cls.superClass) : cls.superClass;
      if (target) {
        relations.push({
          type: 'inherit',
          source: { class: cls.fqn },
          target: { class: target },
          evidence: { file: cls.filePath, startIndex: cls.startIndex, endIndex: cls.startIndex },
        });
      } else {
        resolver?.markUnresolved(
          unresolved,
          cls.superClass,
          'superclass',
          { file: cls.filePath, startIndex: cls.startIndex, endIndex: cls.endIndex },
          { class: cls.fqn },
        );
      }
    }
    for (const iface of cls.interfaces) {
      const target = resolver ? resolver.resolve(iface) : iface;
      if (target) {
        relations.push({
          type: 'implement',
          source: { class: cls.fqn },
          target: { class: target },
          evidence: { file: cls.filePath, startIndex: cls.startIndex, endIndex: cls.startIndex },
        });
      } else {
        resolver?.markUnresolved(
          unresolved,
          iface,
          'interface',
          { file: cls.filePath, startIndex: cls.startIndex, endIndex: cls.endIndex },
          { class: cls.fqn },
        );
      }
    }
  }
  return relations;
}
