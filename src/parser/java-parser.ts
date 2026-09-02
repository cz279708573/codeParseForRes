import { getJavaParser } from './wasm-loader';
import type { Tree } from 'web-tree-sitter';

/**
 * 解析 Java 源码为 AST。
 * 复用单例解析器，调用方无需关心 wasm 生命周期。
 */
export async function parseJava(content: string): Promise<Tree> {
  const parser = await getJavaParser();
  return parser.parse(content);
}

/**
 * 调试用：以缩进文本形式打印 AST，便于核对节点结构。
 */
export function dumpAst(node: unknown, depth = 0, out: string[] = []): string[] {
  // 仅作调试辅助，类型放宽以适配 web-tree-sitter 运行时对象
  const n = node as {
    type: string;
    startIndex: number;
    endIndex: number;
    namedChildCount: number;
    namedChild(i: number): unknown;
    isNamed?: boolean;
  };
  const indent = '  '.repeat(depth);
  out.push(`${indent}${n.type} [${n.startIndex},${n.endIndex}) named=${n.namedChildCount}`);
  for (let i = 0; i < n.namedChildCount; i++) {
    dumpAst(n.namedChild(i), depth + 1, out);
  }
  return out;
}
