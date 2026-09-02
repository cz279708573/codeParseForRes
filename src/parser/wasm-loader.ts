import * as fs from 'fs';
import * as path from 'path';

// web-tree-sitter 以 commonjs 形式导出，避免 ESM 类型摩擦。
// 0.25.x 起，init/load 均为静态方法：Parser.init() 与 Language.load(buf)。
// Parser 既可 new 又有静态 init，TS 难以兼顾，类型上以 any 简化。
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
const WT: any = require('web-tree-sitter');

import type { Tree } from 'web-tree-sitter';

type JavaParser = { setLanguage(lang: unknown): void; parse(input: string): Tree; delete(): void };

let cachedParser: JavaParser | null = null;

/**
 * 求取 tree-sitter-java.wasm 的绝对路径。
 *
 * 经实测，tree-sitter-java npm 包将 wasm 置于包根目录（非 dist/），
 * 故以 package.json 为锚取同级的 tree-sitter-java.wasm。
 */
function resolveWasmPath(): string {
  const pkgJsonPath = require.resolve('tree-sitter-java/package.json');
  const pkgRoot = path.dirname(pkgJsonPath);
  const wasmPath = path.join(pkgRoot, 'tree-sitter-java.wasm');
  if (!fs.existsSync(wasmPath)) {
    // 兜底：某些版本可能置于 dist/
    const fallback = path.join(pkgRoot, 'dist', 'tree-sitter-java.wasm');
    if (fs.existsSync(fallback)) {
      return fallback;
    }
    throw new Error(`无法定位 tree-sitter-java.wasm：尝试 ${wasmPath} 与 ${fallback} 均不存在`);
  }
  return wasmPath;
}

/**
 * 获取单例 Java 解析器。首次调用会加载 wasm，之后复用。
 */
export async function getJavaParser(): Promise<JavaParser> {
  if (cachedParser) {
    return cachedParser;
  }
  await WT.Parser.init();
  const wasmPath = resolveWasmPath();
  const wasmBuf = fs.readFileSync(wasmPath);
  const lang = await WT.Language.load(wasmBuf);
  const parser = new WT.Parser();
  parser.setLanguage(lang);
  cachedParser = parser;
  return parser;
}
