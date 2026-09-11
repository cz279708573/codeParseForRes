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
import { graphHtmlParts } from './view/graph-html-reporter';
import { traceHtmlParts } from './view/trace-html-reporter';
import { annotationPageParts } from './view/annotation-html-reporter';
import { renderIndexHtml, type IndexPageLink } from './view/index-html-reporter';
import { collectAnnotationOccurrences, filterByAnnotationName } from './analyzer/annotation-collector';
import { attachLineNumbers } from './utils/line-index';
import { writeJsonFile, writeHtmlWithJson } from './utils/stream-writer';
import {
  simpleAnnotationName,
  loadConfigFile,
  resolveConfig,
  resolveShardSize,
} from './config';
import { writeSharded } from './utils/shard-writer';
import type { AppConfig } from './config';

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
 *
 * @param input  目录或 .java 文件
 * @param output 结果 JSON 路径；给出则同时产出全部 HTML 报告
 * @param cfg    注解出页配置；不给则自动读取 codeparse.config.json
 * @returns 结构化 ParseResult
 */
export async function parseProject(
  input: string,
  output?: string,
  cfg?: AppConfig,
): Promise<ParseResult> {
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
    // 注解出页配置：调用方传入优先，否则读 codeparse.config.json
    const config: AppConfig = cfg ?? (await loadConfigFile());
    const jsonIndent = config.jsonIndent ?? 2;
    // 分片大小：配置/命令行覆盖默认值
    const shardSize = resolveShardSize(config.shardSize);
    // 写出：分片模式按元素数量切多个文件，否则单文件（内部逐元素原生 stringify）
    if (config.skipJson) {
      console.log('已按配置跳过 result.json 输出');
    } else if (config.shard) {
      const r = await writeSharded(
        outDir,
        baseName,
        result as unknown as Record<string, unknown>,
        {
          classes: shardSize.classes,
          relations: shardSize.relations,
          unresolvedSymbols: shardSize.unresolvedSymbols,
        },
        jsonIndent,
      );
      console.log(
        `JSON 已分片写入：${r.manifestPath}（${r.shards
          .map((s) => `${s.field} ${s.files.length} 片`)
          .join('、')}）`,
      );
    } else {
      await writeJsonFile(output, result, jsonIndent);
    }
    // 先构图，概览报告需要引用图统计
    const graph = toGraph(result);
    const indexFileName = `${baseName}.index.html`;
    // 采集全部注解引用，为配置中的注解名规划独立分页页面
    const occurrences = collectAnnotationOccurrences(result.classes);
    const annoPlan = (config.annotations || []).map((name) => {
      const hits = filterByAnnotationName(occurrences, name);
      const simple = simpleAnnotationName(name);
      return { name, simple, hits, fileName: `${baseName}.anno.${safeFileName(simple)}.html` };
    });
    const annotationLinks: Record<string, string> = {};
    for (const p of annoPlan) {
      if (p.hits.length) annotationLinks[p.simple] = p.fileName;
      else console.warn(`[配置] 注解 @${p.name} 未匹配到任何引用，跳过出页。`);
    }
    // 生成概览报告（纯统计看板，不含网络图）
    const htmlPath = buildHtmlReportPath(output);
    await fs.writeFile(
      htmlPath,
      renderHtmlReport(result, graph, annotationLinks, indexFileName),
      'utf8',
    );
    // 生成每个注解的独立分页页面
    const annoPages: { name: string; simple: string; fileName: string; count: number; classes: number }[] = [];
    for (const p of annoPlan) {
      if (!p.hits.length) continue;
      await attachLineNumbers(p.hits);
      const pagePath = path.join(outDir, p.fileName);
      const parts = annotationPageParts({
        annotation: p.name,
        occurrences: p.hits,
        pageSize: config.pageSize,
        indexHref: indexFileName,
      });
      await writeHtmlWithJson(pagePath, parts.head, parts.data, parts.tail);
      annoPages.push({
        name: p.name,
        simple: p.simple,
        fileName: p.fileName,
        count: p.hits.length,
        classes: new Set(p.hits.map((h) => h.classFqn)).size,
      });
      console.log(`注解页已写入：${pagePath}（@${p.simple} · ${p.hits.length} 处引用）`);
    }
    // 生成纯图对象 graph.json + graph.html
    const graphPath = path.join(outDir, baseName + '.graph.json');
    if (config.shard) {
      const g = await writeSharded(
        outDir,
        baseName + '.graph',
        graph as unknown as Record<string, unknown>,
        { nodes: shardSize.nodes, edges: shardSize.edges },
        jsonIndent,
      );
      console.log(
        `Graph JSON 已分片写入：${g.manifestPath}（${g.shards
          .map((s) => `${s.field} ${s.files.length} 片 × ${s.perShard}`)
          .join('、')}）`,
      );
    } else {
      await writeJsonFile(graphPath, graph, jsonIndent);
    }
    const graphHtmlPath = path.join(outDir, baseName + '.graph.html');
    const graphParts = graphHtmlParts({ indexHref: indexFileName });
    await writeHtmlWithJson(graphHtmlPath, graphParts.head, graph, graphParts.tail);
    // 生成方法链路追踪 trace.html
    const traceHtmlPath = path.join(outDir, baseName + '.trace.html');
    const traceParts = traceHtmlParts({ indexHref: indexFileName });
    await writeHtmlWithJson(traceHtmlPath, traceParts.head, graph, traceParts.tail);
    // 生成首页入口 index.html
    const indexPages: IndexPageLink[] = [
      {
        key: 'report',
        title: '概览报告',
        description: '工程级统计总览：节点统计、关系统计与类型分布，不含网络图。',
        href: path.basename(htmlPath),
        accent: '#4a90e2',
        iconPath: 'M3 5h18v4H3zM3 11h18v4H3zM3 17h18v4H3z',
      },
      {
        key: 'graph',
        title: '代码图对象',
        description: '基于纯图对象的全量节点与边可视化，支持按关系类型过滤。',
        href: path.basename(graphHtmlPath),
        accent: '#16a085',
        iconPath: 'M12 2a10 10 0 100 20 10 10 0 000-20zM4.93 4.93a8 8 0 0114.14 0l-1.42 1.42a6 6 0 00-11.3 0zM7 12a5 5 0 1110 0 5 5 0 01-10 0z',
      },
      {
        key: 'trace',
        title: '方法链路追踪',
        description: '以方法为根按思维导图展开其调用、重写与实现关系。',
        href: path.basename(traceHtmlPath),
        accent: '#e74c3c',
        iconPath: 'M3 12h4l3-8 4 16 3-8h4',
      },
      // 用户配置的注解：每个注解一张卡片，进入各自的分页明细页
      ...annoPages.map((a) => ({
        key: 'anno-' + a.simple,
        title: `@${a.simple} 引用明细`,
        description: `${a.count} 处引用 · 涉及 ${a.classes} 个类，支持按位置过滤与关键字搜索，分页展示。`,
        href: a.fileName,
        accent: '#c0392b',
        iconPath: 'M20.6 13.4L12 22l-9-9V3h10l7.6 7.6a2 2 0 010 2.8zM7.5 8.5h.01',
      })),
    ];
    const indexHtmlPath = path.join(outDir, baseName + '.index.html');
    await fs.writeFile(
      indexHtmlPath,
      renderIndexHtml(indexPages, {
        title: `${baseName} · 代码可视化总览`,
        stats: [
          { label: '类', value: result.classes.length },
          { label: '关系', value: result.relations.length },
          { label: '未决符号', value: result.unresolvedSymbols.length },
          { label: '图节点', value: graph.nodes.length },
          { label: '图边', value: graph.edges.length },
        ],
      }),
      'utf8',
    );
  }
  return result;
}

/** 注解名 -> 合法文件名片段 */
function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_') || 'annotation';
}

function collectAllClasses(cls: ClassInfo, into: ClassInfo[]) {
  into.push(cls);
  for (const inner of cls.innerClasses) collectAllClasses(inner, into);
}

async function main() {
  const args = process.argv.slice(2);
  let input = '';
  let output = '';
  let annotations: string | undefined;
  let pageSize: string | undefined;
  let config: string | undefined;
  let jsonIndent: string | undefined;
  let noJson: string | undefined;
  let shard: string | undefined;
  let shardSize: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) input = args[++i];
    else if (args[i] === '--output' && args[i + 1]) output = args[++i];
    else if (args[i] === '--annotations' && args[i + 1]) annotations = args[++i];
    else if (args[i] === '--page-size' && args[i + 1]) pageSize = args[++i];
    else if (args[i] === '--config' && args[i + 1]) config = args[++i];
    else if (args[i] === '--json-indent' && args[i + 1]) jsonIndent = args[++i];
    else if (args[i] === '--no-json') noJson = 'true';
    else if (args[i] === '--shard') shard = 'true';
    else if (args[i] === '--shard-size' && args[i + 1]) shardSize = args[++i];
  }
  if (!input) {
    console.error(
      '用法: npm start -- --input <dir|file> [--output <out.json>] [--annotations Override,Service] [--page-size 50] [--json-indent 0] [--no-json] [--config codeparse.config.json]',
    );
    process.exit(1);
  }
  const out = output || path.join(process.cwd(), 'dist', 'result.json');
  const cfg = await resolveConfig({
    annotations,
    pageSize,
    config,
    jsonIndent,
    noJson,
    shard,
    shardSize,
  });
  if (cfg.annotations.length) {
    console.log(`注解出页配置：${cfg.annotations.map((a) => '@' + a).join('、')}（每页 ${cfg.pageSize} 条）`);
  }
  const result = await parseProject(input, out, cfg);
  console.log(`解析完成：类 ${result.classes.length} 个，关系 ${result.relations.length} 条。`);
  console.log(`未决符号 ${result.unresolvedSymbols.length} 个。`);
  const graph = toGraph(result);
  console.log(`图：节点 ${graph.nodes.length} · 边 ${graph.edges.length}`);
  // 分片模式下 parseProject 内部已打印分片明细，这里不再重复
  if (!cfg.skipJson && !cfg.shard) console.log(`JSON 已写入：${out}`);
  console.log(`HTML 已写入：${buildHtmlReportPath(out)}`);
  if (!cfg.shard) {
    console.log(
      `Graph JSON 已写入：${path.join(
        path.dirname(path.resolve(out)),
        path.basename(out, path.extname(out)) + '.graph.json',
      )}`,
    );
  }
  console.log(`Graph HTML 已写入：${path.join(path.dirname(path.resolve(out)), path.basename(out, path.extname(out)) + '.graph.html')}`);
  console.log(`Trace HTML 已写入：${path.join(path.dirname(path.resolve(out)), path.basename(out, path.extname(out)) + '.trace.html')}`);
  console.log(`Index HTML 已写入：${path.join(path.dirname(path.resolve(out)), path.basename(out, path.extname(out)) + '.index.html')}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
