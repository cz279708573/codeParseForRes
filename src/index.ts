import { promises as fs } from 'fs';
import * as path from 'path';
import type { Node } from 'web-tree-sitter';
import { parseJava } from './parser/java-parser';
import { JavaNodeType } from './model/types';
import type { ClassInfo, FileParseResult, ParseResult, Relation, UnresolvedSymbol } from './model/types';
import { namedChildren, getText } from './utils/node-helpers';
import { extractClass } from './extractor/class-extractor';
import { extractComment } from './extractor/comment-extractor';
import { SymbolResolver } from './resolver/symbol-resolver';
import { analyzeClassRelations } from './analyzer/class-relation-analyzer';
import { analyzeCallRelations } from './analyzer/call-relation-analyzer';
import { analyzeFieldAccess } from './analyzer/field-access-analyzer';
import { renderHtmlReport, buildHtmlReportPath } from './view/html-reporter';
import { toGraph } from './view/graph-builder';
import { renderGraphHtml } from './view/graph-html-reporter';
import { renderTraceHtml } from './view/trace-html-reporter';

interface ParsedFile {
  fileResult: FileParseResult;
  astRoot: Node;
  content: string;
}

/**
 * 解析单个 Java 文件：提取 package、imports、顶层类（含内部类递归）。
 * 单文件解析异常不中断主流程，由调用方 try/catch。
 */
export async function parseFile(filePath: string): Promise<ParsedFile> {
  const content = await fs.readFile(filePath, 'utf8');
  const tree = await parseJava(content);
  const root = tree.rootNode;

  let pkg = '';
  const imports: string[] = [];
  const topClasses: ClassInfo[] = [];

  let pendingComments = [];
  for (const child of namedChildren(root)) {
    if (
      child.type === JavaNodeType.Comment ||
      child.type === JavaNodeType.LineComment ||
      child.type === JavaNodeType.BlockComment
    ) {
      pendingComments.push(extractComment(content, child));
      continue;
    }
    if (child.type === JavaNodeType.PackageDeclaration) {
      pkg = extractDottedName(child, content);
      pendingComments = [];
    } else if (child.type === JavaNodeType.ImportDeclaration) {
      const imp = extractDottedName(child, content);
      if (imp) imports.push(imp);
      pendingComments = [];
    } else if (
      child.type === JavaNodeType.ClassDeclaration ||
      child.type === JavaNodeType.InterfaceDeclaration ||
      child.type === JavaNodeType.EnumDeclaration ||
      child.type === JavaNodeType.RecordDeclaration
    ) {
      topClasses.push(extractClass(content, child, pkg, filePath, pendingComments));
      pendingComments = [];
    } else {
      pendingComments = [];
    }
  }

  return {
    fileResult: { filePath, package: pkg, imports, classes: topClasses },
    astRoot: root,
    content,
  };
}

/** 从 package/import 节点提取 dotted 名称（拼接所有 identifier） */
function extractDottedName(node: Node, content: string): string {
  const parts: string[] = [];
  collect(node);
  function collect(n: Node) {
    if (n.type === JavaNodeType.Identifier) {
      parts.push(getText(content, n));
      return;
    }
    for (const c of namedChildren(n)) collect(c);
  }
  return parts.join('.');
}

/**
 * 工程级入口：解析目录或单文件，构建元信息与关系。
 * @returns 结构化 ParseResult，同时写 JSON
 */
export async function parseProject(input: string, output?: string): Promise<ParseResult> {
  const files: string[] = [];
  const stat = await fs.stat(input);
  if (stat.isDirectory()) {
    const { collectJavaFiles } = await import('./utils/file-walker');
    files.push(...(await collectJavaFiles(input)));
  } else if (stat.isFile()) {
    files.push(input);
  } else {
    throw new Error(`输入路径既非目录也非文件：${input}`);
  }

  const parsed: ParsedFile[] = [];
  for (const f of files) {
    try {
      parsed.push(await parseFile(f));
    } catch (e) {
      console.error(`[解析失败] ${f}:`, e instanceof Error ? e.message : e);
    }
  }

  const allClasses: ClassInfo[] = [];
  for (const p of parsed) {
    for (const c of p.fileResult.classes) collectAllClasses(c, allClasses);
  }

  const resolverPerClass = new Map<string, SymbolResolver>();
  for (const p of parsed) {
    const resolver = new SymbolResolver(allClasses, {
      pkg: p.fileResult.package,
      imports: p.fileResult.imports,
    });
    for (const c of p.fileResult.classes) {
      const flat: ClassInfo[] = [];
      collectAllClasses(c, flat);
      flat.forEach((cls) => resolverPerClass.set(cls.fqn, resolver));
    }
  }

  const unresolved: UnresolvedSymbol[] = [];
  const relations: Relation[] = [];
  relations.push(...analyzeClassRelations(allClasses, resolverPerClass, unresolved));

  for (const p of parsed) {
    const resolver = new SymbolResolver(allClasses, {
      pkg: p.fileResult.package,
      imports: p.fileResult.imports,
    });
    const fileClasses: ClassInfo[] = [];
    for (const c of p.fileResult.classes) collectAllClasses(c, fileClasses);
    // 调用/属性分析需全局类表以解析跨文件父类与符号
    relations.push(...analyzeCallRelations(p.astRoot, p.content, allClasses, resolver, unresolved));
    relations.push(...analyzeFieldAccess(p.astRoot, p.content, allClasses, resolver, unresolved));
  }

  const result: ParseResult = {
    classes: allClasses,
    relations,
    unresolvedSymbols: unresolved,
  };

  if (output) {
    const outDir = path.dirname(path.resolve(output));
    const baseName = path.basename(output, path.extname(output));
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(output, JSON.stringify(result, null, 2), 'utf8');
    // 同时生成同名 HTML 可视化
    const htmlPath = buildHtmlReportPath(output);
    await fs.writeFile(htmlPath, renderHtmlReport(result), 'utf8');
    // 生成纯图对象 graph.json + graph.html
    const graph = toGraph(result);
    const graphPath = path.join(outDir, baseName + '.graph.json');
    await fs.writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');
    const graphHtmlPath = path.join(outDir, baseName + '.graph.html');
    await fs.writeFile(graphHtmlPath, renderGraphHtml(graph), 'utf8');
    // 生成方法链路追踪 trace.html
    const traceHtmlPath = path.join(outDir, baseName + '.trace.html');
    await fs.writeFile(traceHtmlPath, renderTraceHtml(graph), 'utf8');
  }
  return result;
}

function collectAllClasses(cls: ClassInfo, into: ClassInfo[]) {
  into.push(cls);
  for (const inner of cls.innerClasses) collectAllClasses(inner, into);
}

async function main() {
  const args = process.argv.slice(2);
  let input = '';
  let output = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) input = args[++i];
    else if (args[i] === '--output' && args[i + 1]) output = args[++i];
  }
  if (!input) {
    console.error('用法: npm start -- --input <dir|file> [--output <out.json>]');
    process.exit(1);
  }
  const out = output || path.join(process.cwd(), 'dist', 'result.json');
  const result = await parseProject(input, out);
  console.log(`解析完成：类 ${result.classes.length} 个，关系 ${result.relations.length} 条。`);
  console.log(`未决符号 ${result.unresolvedSymbols.length} 个。`);
  const graph = toGraph(result);
  console.log(`图：节点 ${graph.nodes.length} · 边 ${graph.edges.length}`);
  console.log(`JSON 已写入：${out}`);
  console.log(`HTML 已写入：${buildHtmlReportPath(out)}`);
  console.log(`Graph JSON 已写入：${path.join(path.dirname(path.resolve(out)), path.basename(out, path.extname(out)) + '.graph.json')}`);
  console.log(`Graph HTML 已写入：${path.join(path.dirname(path.resolve(out)), path.basename(out, path.extname(out)) + '.graph.html')}`);
  console.log(`Trace HTML 已写入：${path.join(path.dirname(path.resolve(out)), path.basename(out, path.extname(out)) + '.trace.html')}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
