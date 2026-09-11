import * as path from 'path';
import type { AnnotationInfo, ClassInfo, Graph, ParseResult } from '../model/types';

/**
 * "概览报告"渲染器：**只做统计数据呈现，不画网络图**。
 *
 * 全量节点/边的图可视化由 graph.html 承担、方法链路由 trace.html 承担，
 * 本页面专注于工程级统计：
 *   1. 总览 KPI（类、关系、图节点/边、未决符号、文件、包）
 *   2. 节点统计（类种类分布、图节点类型分布、成员构成、包分布、类规模 Top）
 *   3. 关系统计（关系类型分布、图边类型分布、出入度 Top）
 *   4. 类型交叉统计（关系类型 × 源类种类矩阵、注解使用 Top、修饰符分布、未决符号种类）
 *
 * 页面自包含：CSS 内联，纯服务端计算结果，无需运行时 JS。
 */

// ---------------- 标签与配色 ----------------

const KIND_LABEL: Record<string, string> = {
  class: '类',
  interface: '接口',
  enum: '枚举',
  record: '记录',
};

const NODE_TYPE_LABEL: Record<string, string> = {
  class: '类节点',
  method: '方法节点',
  field: '字段节点',
  annotation: '注解节点',
  external: '外部节点',
};

const REL_LABEL: Record<string, string> = {
  inherit: '继承',
  implement: '实现',
  call: '调用',
  'field-access': '字段访问',
  instantiate: '实例化',
};

const EDGE_LABEL: Record<string, string> = {
  contains: '包含成员',
  inherit: '继承',
  implement: '实现',
  override: '方法重写',
  'implement-method': '接口方法实现',
  call: '方法调用',
  'field-access': '字段访问',
  instantiate: '实例化',
  'type-ref': '类型引用',
  annotate: '注解标注',
};

const UNRESOLVED_LABEL: Record<string, string> = {
  'call-object': '调用对象未决',
  'call-name': '调用名未决',
  'field-object': '字段对象未决',
  superclass: '父类未决',
  interface: '接口未决',
  other: '其他未决',
};

const KIND_COLOR: Record<string, string> = {
  class: '#4a90e2',
  interface: '#27ae60',
  enum: '#e67e22',
  record: '#8e44ad',
};

const NODE_TYPE_COLOR: Record<string, string> = {
  class: '#4a90e2',
  method: '#16a085',
  field: '#f39c12',
  annotation: '#c0392b',
  external: '#95a5a6',
};

const REL_COLOR: Record<string, string> = {
  inherit: '#e74c3c',
  implement: '#2980b9',
  call: '#27ae60',
  'field-access': '#e67e22',
  instantiate: '#8e44ad',
};

const EDGE_COLOR: Record<string, string> = {
  contains: '#95a5a6',
  inherit: '#e74c3c',
  implement: '#2980b9',
  override: '#c0392b',
  'implement-method': '#5dade2',
  call: '#27ae60',
  'field-access': '#e67e22',
  instantiate: '#8e44ad',
  'type-ref': '#7f8c8d',
  annotate: '#d35400',
};

const UNRESOLVED_COLOR = '#c0392b';

// ---------------- 统计计算 ----------------

interface Row {
  label: string;
  value: number;
  color?: string;
  /** 附加说明（表格用） */
  detail?: string;
}

interface PackageStat {
  pkg: string;
  classes: number;
  methods: number;
  fields: number;
}

interface MatrixRow {
  relLabel: string;
  relColor: string;
  counts: number[];
}

/** 单个注解的引用统计 */
interface AnnotationStat {
  name: string;
  /** 引用总次数 */
  total: number;
  onClass: number;
  onField: number;
  onMethod: number;
  /** 带参注解次数（括号内非空） */
  withArgs: number;
  /** 标记注解次数（无参） */
  marker: number;
}

/** 注解维度汇总 */
interface AnnotationSummary {
  /** 不同注解种类数 */
  kinds: number;
  total: number;
  withArgs: number;
  marker: number;
  /** 至少带有一处注解的类数量 */
  annotatedClasses: number;
}

interface Stats {
  kpis: { label: string; value: number | string }[];
  byKind: Row[];
  byNodeType: Row[];
  members: { label: string; value: number }[];
  packages: PackageStat[];
  classSizes: Row[];
  byRelType: Row[];
  byEdgeType: Row[];
  outTop: Row[];
  inTop: Row[];
  matrix: MatrixRow[];
  matrixCols: string[];
  /** 注解引用次数快览（Top 10） */
  annotations: Row[];
  /** 注解引用次数完整排行（降序） */
  annotationRank: AnnotationStat[];
  annotationSummary: AnnotationSummary;
  /** 被注解最多的类 */
  annotatedClassTop: Row[];
  modifiers: Row[];
  unresolvedKinds: Row[];
  fileCount: number;
  packageCount: number;
  hasGraph: boolean;
}

function computeStats(result: ParseResult, graph?: Graph): Stats {
  const classes = result.classes;
  const classByFqn = new Map<string, ClassInfo>();
  for (const c of classes) classByFqn.set(c.fqn, c);

  const kindOrder = ['class', 'interface', 'enum', 'record'];
  const kindCount = new Map<string, number>(kindOrder.map((k) => [k, 0]));

  const nodeTypeOrder = ['class', 'method', 'field', 'annotation', 'external'];
  const nodeTypeCount = new Map<string, number>(nodeTypeOrder.map((k) => [k, 0]));

  const edgeTypeOrder = [
    'contains',
    'inherit',
    'implement',
    'override',
    'implement-method',
    'call',
    'field-access',
    'instantiate',
    'type-ref',
    'annotate',
  ];
  const edgeTypeCount = new Map<string, number>(edgeTypeOrder.map((k) => [k, 0]));

  const relOrder = ['inherit', 'implement', 'call', 'field-access', 'instantiate'];
  const relCount = new Map<string, number>(relOrder.map((k) => [k, 0]));

  let totalMethods = 0;
  let totalFields = 0;
  let totalCtors = 0;
  let totalAnnotations = 0;
  let totalComments = 0;

  const fileSet = new Set<string>();
  const pkgMap = new Map<string, PackageStat>();
  const annoMap = new Map<string, AnnotationStat>();
  const modUsage = new Map<string, number>();
  const classSizes: Row[] = [];
  const annotatedClassTop: Row[] = [];

  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const bumpMods = (mods: string[] | undefined) => {
    for (const m of mods ?? []) bump(modUsage, m);
  };
  /** 记录一次注解引用：按注解名聚合，并区分标注位置与是否带参 */
  const bumpAnno = (a: AnnotationInfo, where: 'class' | 'field' | 'method') => {
    let st = annoMap.get(a.name);
    if (!st) {
      st = { name: a.name, total: 0, onClass: 0, onField: 0, onMethod: 0, withArgs: 0, marker: 0 };
      annoMap.set(a.name, st);
    }
    st.total += 1;
    if (where === 'class') st.onClass += 1;
    else if (where === 'field') st.onField += 1;
    else st.onMethod += 1;
    if (a.arguments && a.arguments.trim()) st.withArgs += 1;
    else st.marker += 1;
  };

  for (const c of classes) {
    kindCount.set(c.kind, (kindCount.get(c.kind) ?? 0) + 1);
    fileSet.add(c.filePath);

    const pkg = c.package || '(默认包)';
    const ps = pkgMap.get(pkg) ?? { pkg, classes: 0, methods: 0, fields: 0 };
    ps.classes += 1;
    ps.methods += c.methods.length;
    ps.fields += c.fields.length;
    pkgMap.set(pkg, ps);

    totalMethods += c.methods.length;
    totalFields += c.fields.length;
    totalAnnotations += c.annotations.length;
    totalComments += c.comments.length;
    for (const a of c.annotations) bumpAnno(a, 'class');
    bumpMods(c.modifiers);

    let classAnnoCount = c.annotations.length;

    for (const f of c.fields) {
      totalAnnotations += f.annotations.length;
      totalComments += f.comments.length;
      classAnnoCount += f.annotations.length;
      for (const a of f.annotations) bumpAnno(a, 'field');
      bumpMods(f.modifiers);
    }

    for (const m of c.methods) {
      if (m.isConstructor) totalCtors += 1;
      totalAnnotations += m.annotations.length;
      totalComments += m.comments.length;
      classAnnoCount += m.annotations.length;
      for (const a of m.annotations) bumpAnno(a, 'method');
      bumpMods(m.modifiers);
    }

    if (classAnnoCount > 0) {
      annotatedClassTop.push({
        label: c.simpleName,
        value: classAnnoCount,
        color: KIND_COLOR[c.kind],
        detail: c.fqn,
      });
    }

    classSizes.push({
      label: c.simpleName,
      value: c.methods.length + c.fields.length,
      color: KIND_COLOR[c.kind],
      detail: `方法 ${c.methods.length} · 字段 ${c.fields.length}`,
    });
  }

  // ---- 关系统计 ----
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const matrixCols = ['class', 'interface', 'enum', 'record', 'external'];
  const matrix = new Map<string, number[]>(
    relOrder.map((t) => [t, new Array(matrixCols.length).fill(0)]),
  );

  for (const r of result.relations) {
    relCount.set(r.type, (relCount.get(r.type) ?? 0) + 1);
    outDeg.set(r.source.class, (outDeg.get(r.source.class) ?? 0) + 1);
    inDeg.set(r.target.class, (inDeg.get(r.target.class) ?? 0) + 1);

    const srcKind = classByFqn.get(r.source.class)?.kind ?? 'external';
    const col = matrixCols.indexOf(srcKind);
    const row = matrix.get(r.type);
    if (row && col >= 0) row[col] += 1;
  }

  // ---- 图统计 ----
  const hasGraph = !!graph;
  if (graph) {
    for (const n of graph.nodes) {
      nodeTypeCount.set(n.type, (nodeTypeCount.get(n.type) ?? 0) + 1);
    }
    for (const e of graph.edges) {
      edgeTypeCount.set(e.type, (edgeTypeCount.get(e.type) ?? 0) + 1);
    }
  }

  // ---- 未决符号种类 ----
  const unresolvedKinds = new Map<string, number>();
  for (const u of result.unresolvedSymbols) bump(unresolvedKinds, u.kind || 'other');

  const toRows = (
    map: Map<string, number>,
    order: string[],
    labelMap: Record<string, string> | null,
    colorMap: Record<string, string> | null,
  ): Row[] =>
    order.map((k) => ({
      label: labelMap?.[k] ?? k,
      value: map.get(k) ?? 0,
      color: colorMap?.[k],
    }));

  const degreeRows = (map: Map<string, number>): Row[] =>
    [...map.entries()]
      .map(([fqn, v]) => ({
        label: classByFqn.get(fqn)?.simpleName ?? fqn.split('.').pop() ?? fqn,
        value: v,
        detail: fqn,
        color: KIND_COLOR[classByFqn.get(fqn)?.kind ?? ''] ?? '#95a5a6',
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 12);

  // ---- 注解引用次数排行（全量，降序） ----
  const annotationRank = [...annoMap.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );
  const topAnno: Row[] = annotationRank.slice(0, 10).map((a) => ({ label: '@' + a.name, value: a.total }));
  const annotationSummary: AnnotationSummary = {
    kinds: annotationRank.length,
    total: annotationRank.reduce((acc, a) => acc + a.total, 0),
    withArgs: annotationRank.reduce((acc, a) => acc + a.withArgs, 0),
    marker: annotationRank.reduce((acc, a) => acc + a.marker, 0),
    annotatedClasses: annotatedClassTop.length,
  };

  const modRows = [...modUsage.entries()]
    .map(([name, v]) => ({ label: name, value: v }))
    .sort((a, b) => b.value - a.value);

  const unresolvedRows = [...unresolvedKinds.entries()]
    .map(([k, v]) => ({ label: UNRESOLVED_LABEL[k] ?? k, value: v, color: UNRESOLVED_COLOR }))
    .sort((a, b) => b.value - a.value);

  return {
    kpis: [
      { label: '类 / 接口 / 枚举 / 记录', value: classes.length },
      { label: '关系总数', value: result.relations.length },
      { label: '图节点', value: graph ? graph.nodes.length : '—' },
      { label: '图边', value: graph ? graph.edges.length : '—' },
      { label: '未决符号', value: result.unresolvedSymbols.length },
      { label: '源文件', value: fileSet.size },
      { label: '包', value: pkgMap.size },
    ],
    byKind: toRows(kindCount, kindOrder, KIND_LABEL, KIND_COLOR),
    byNodeType: toRows(nodeTypeCount, nodeTypeOrder, NODE_TYPE_LABEL, NODE_TYPE_COLOR),
    members: [
      { label: '方法', value: totalMethods },
      { label: '字段', value: totalFields },
      { label: '构造器', value: totalCtors },
      { label: '注解', value: totalAnnotations },
      { label: '注释', value: totalComments },
    ],
    packages: [...pkgMap.values()].sort((a, b) => b.classes - a.classes || a.pkg.localeCompare(b.pkg)),
    classSizes: classSizes.sort((a, b) => b.value - a.value).slice(0, 15),
    byRelType: toRows(relCount, relOrder, REL_LABEL, REL_COLOR),
    byEdgeType: toRows(edgeTypeCount, edgeTypeOrder, EDGE_LABEL, EDGE_COLOR),
    outTop: degreeRows(outDeg),
    inTop: degreeRows(inDeg),
    matrixCols: matrixCols.map((k) => KIND_LABEL[k] ?? '外部'),
    matrix: relOrder.map((t) => ({
      relLabel: REL_LABEL[t] ?? t,
      relColor: REL_COLOR[t] ?? '#7f8c8d',
      counts: matrix.get(t) ?? [],
    })),
    annotations: topAnno,
    annotationRank,
    annotationSummary,
    annotatedClassTop: annotatedClassTop.sort((a, b) => b.value - a.value).slice(0, 10),
    modifiers: modRows,
    unresolvedKinds: unresolvedRows,
    fileCount: fileSet.size,
    packageCount: pkgMap.size,
    hasGraph,
  };
}

// ---------------- 渲染 ----------------

/** 横向条形列表：label + 计数 + 占比条 */
function barList(rows: Row[], total: number): string {
  if (!rows.length) return '<div class="empty">暂无数据</div>';
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="bars">${rows
    .map((r) => {
      const pct = total > 0 ? Math.round((r.value / total) * 1000) / 10 : 0;
      const width = Math.round((r.value / max) * 100);
      const color = r.color ?? '#4a90e2';
      return `<div class="bar-row">
      <span class="bar-label" title="${escapeAttr(r.label)}">${escapeHtml(r.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${width}%;background:${color}"></span></span>
      <span class="bar-value">${r.value}<em>${pct}%</em></span>
    </div>`;
    })
    .join('')}</div>`;
}

/** 排行列表：名次 + 名称 + 数值 */
function rankList(rows: Row[], unit: string): string {
  if (!rows.length) return '<div class="empty">暂无数据</div>';
  return `<ol class="rank">${rows
    .map(
      (r) => `<li>
      <span class="rank-dot" style="background:${r.color ?? '#95a5a6'}"></span>
      <span class="rank-name" title="${escapeAttr(r.detail ?? r.label)}">${escapeHtml(r.label)}</span>
      <span class="rank-value">${r.value} ${escapeHtml(unit)}</span>
    </li>`,
    )
    .join('')}</ol>`;
}

/**
 * 注解引用次数排行表：名次 / 注解名 / 次数 / 占比条 / 类·字段·方法 / 带参次数。
 * 全量列出，按引用次数降序。
 */
function annotationRankTable(
  stats: AnnotationStat[],
  total: number,
  /** 简单名 -> 该注解独立页面的相对 href；命中则注解名渲染为链接 */
  hrefs?: Record<string, string>,
): string {
  if (!stats.length) return '<div class="empty">未解析到任何注解</div>';
  const max = Math.max(1, ...stats.map((a) => a.total));
  const rows = stats
    .map((a, i) => {
      const pct = total > 0 ? Math.round((a.total / total) * 1000) / 10 : 0;
      const width = Math.round((a.total / max) * 100);
      // 全限定注解名：主显示简单名，包名以弱化样式附后，避免表格过宽
      const dot = a.name.lastIndexOf('.');
      const simple = dot >= 0 ? a.name.slice(dot + 1) : a.name;
      const pkg = dot >= 0 ? a.name.slice(0, dot) : '';
      const href = hrefs?.[simple];
      const nameText = `@${escapeHtml(simple)}${pkg ? `<span class="anno-pkg">${escapeHtml(pkg)}</span>` : ''}`;
      const nameCell = href
        ? `<a class="anno-link" href="${escapeAttr(href)}" title="@${escapeAttr(a.name)}（查看引用明细）">${nameText}</a>`
        : nameText;
      return `<tr>
      <td class="num idx">${i + 1}</td>
      <td class="mono anno-name" title="@${escapeAttr(a.name)}">${nameCell}</td>
      <td class="num strong">${a.total}</td>
      <td class="pct"><span class="bar-track"><span class="bar-fill" style="width:${width}%;background:#c0392b"></span></span><em>${pct}%</em></td>
      <td class="num${a.onClass ? '' : ' zero'}">${a.onClass}</td>
      <td class="num${a.onField ? '' : ' zero'}">${a.onField}</td>
      <td class="num${a.onMethod ? '' : ' zero'}">${a.onMethod}</td>
      <td class="num${a.withArgs ? '' : ' zero'}">${a.withArgs}</td>
    </tr>`;
    })
    .join('');
  return `<div class="table-wrap tall"><table class="tbl rank-tbl">
    <thead><tr>
      <th class="num">#</th><th>注解</th><th class="num">引用次数</th><th>占比</th>
      <th class="num">类</th><th class="num">字段</th><th class="num">方法</th><th class="num">带参</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function panel(title: string, body: string, hint?: string): string {
  return `<section class="panel">
    <h3>${escapeHtml(title)}${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}</h3>
    ${body}
  </section>`;
}

function renderMatrix(s: Stats): string {
  const rows = s.matrix;
  if (!rows.length) return '<div class="empty">暂无数据</div>';
  const colTotals = s.matrixCols.map((_, i) => rows.reduce((acc, r) => acc + (r.counts[i] ?? 0), 0));
  const head = `<tr><th>关系类型</th>${s.matrixCols
    .map((c) => `<th class="num">${escapeHtml(c)}</th>`)
    .join('')}<th class="num">合计</th></tr>`;
  const body = rows
    .map((r) => {
      const sum = r.counts.reduce((a, b) => a + b, 0);
      const cells = r.counts
        .map((v) => `<td class="num${v === 0 ? ' zero' : ''}">${v}</td>`)
        .join('');
      return `<tr><td><span class="swatch" style="background:${r.relColor}"></span>${escapeHtml(
        r.relLabel,
      )}</td>${cells}<td class="num total">${sum}</td></tr>`;
    })
    .join('');
  const foot = `<tr class="sum-row"><td>合计</td>${colTotals
    .map((v) => `<td class="num">${v}</td>`)
    .join('')}<td class="num total">${colTotals.reduce((a, b) => a + b, 0)}</td></tr>`;
  return `<table class="matrix"><thead>${head}</thead><tbody>${body}${foot}</tbody></table>`;
}

export function renderHtmlReport(
  result: ParseResult,
  graph?: Graph,
  /** 简单名 -> 注解独立页面的相对 href */
  annotationLinks?: Record<string, string>,
  /** 返回首页的链接（通常为 <baseName>.index.html）；传空字符串则不渲染返回入口 */
  indexHref?: string,
): string {
  const s = computeStats(result, graph);
  // 默认 index.html，与注解分页页/图页/链路页保持一致；传空字符串表示不渲染返回入口
  const homeLink = (indexHref ?? 'index.html')
    ? `\n  <a class="home-link" href="${escapeAttr(indexHref ?? 'index.html')}" title="返回总览首页">← 返回首页</a>`
    : '';

  const kpiHtml = s.kpis
    .map(
      (k) =>
        `<div class="kpi"><span class="kpi-value">${escapeHtml(String(k.value))}</span><span class="kpi-label">${escapeHtml(
          k.label,
        )}</span></div>`,
    )
    .join('');

  const membersHtml = s.members
    .map(
      (m) =>
        `<div class="mini"><span class="mini-value">${m.value}</span><span class="mini-label">${escapeHtml(
          m.label,
        )}</span></div>`,
    )
    .join('');

  const pkgHtml = s.packages.length
    ? `<table class="tbl"><thead><tr><th>包</th><th class="num">类</th><th class="num">方法</th><th class="num">字段</th></tr></thead><tbody>${s.packages
        .map(
          (p) =>
            `<tr><td class="mono" title="${escapeAttr(p.pkg)}">${escapeHtml(p.pkg)}</td><td class="num">${
              p.classes
            }</td><td class="num">${p.methods}</td><td class="num">${p.fields}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<div class="empty">暂无数据</div>';

  const sizeHtml = s.classSizes.length
    ? `<table class="tbl"><thead><tr><th>类</th><th class="num">成员数</th><th>构成</th></tr></thead><tbody>${s.classSizes
        .map(
          (c) =>
            `<tr><td><span class="swatch" style="background:${c.color}"></span>${escapeHtml(
              c.label,
            )}</td><td class="num">${c.value}</td><td class="muted">${escapeHtml(c.detail ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<div class="empty">暂无数据</div>';

  const graphNotice = s.hasGraph
    ? ''
    : '<p class="notice">未传入图对象，节点/边相关统计已省略。</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Java 代码统计报告</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6fa; color: #2c3e50; }
  header { background: #2c3e50; color: #ecf0f1; padding: 24px 32px; }
  header h1 { font-size: 20px; font-weight: 600; }
  header p { margin-top: 6px; font-size: 13px; opacity: 0.75; }
  header .home-link { display: inline-block; margin-top: 12px; font-size: 12px; color: #ecf0f1; text-decoration: none; padding: 4px 12px; border-radius: 3px; background: rgba(255,255,255,0.14); }
  header .home-link:hover { background: rgba(255,255,255,0.28); }
  main { padding: 24px 32px 40px; max-width: 1180px; margin: 0 auto; }
  h2 { font-size: 15px; font-weight: 600; color: #2c3e50; margin: 28px 0 14px; padding-left: 10px; border-left: 4px solid #4a90e2; }
  h2:first-child { margin-top: 0; }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
  .kpi { background: #fff; border: 1px solid #e0e3eb; border-radius: 8px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .kpi-value { display: block; font-size: 26px; font-weight: 600; line-height: 1.2; }
  .kpi-label { display: block; margin-top: 6px; font-size: 12px; color: #7f8c8d; }

  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; margin-bottom: 18px; align-items: start; }
  .panel { background: #fff; border: 1px solid #e0e3eb; border-radius: 8px; padding: 16px 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .panel h3 { font-size: 13px; font-weight: 600; color: #34495e; margin-bottom: 12px; display: flex; align-items: baseline; gap: 8px; }
  .panel h3 .hint { font-size: 11px; font-weight: 400; color: #95a5a6; }

  .minis { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 10px; }
  .mini { background: #f8f9fc; border: 1px solid #eef0f4; border-radius: 6px; padding: 10px 12px; }
  .mini-value { display: block; font-size: 19px; font-weight: 600; }
  .mini-label { display: block; margin-top: 3px; font-size: 12px; color: #7f8c8d; }

  .bars { display: flex; flex-direction: column; gap: 9px; }
  .bar-row { display: grid; grid-template-columns: 108px 1fr 74px; align-items: center; gap: 10px; font-size: 12px; }
  .bar-label { color: #34495e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { background: #f0f2f7; border-radius: 4px; height: 14px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; border-radius: 4px; transition: width 0.3s ease; }
  .bar-value { text-align: right; color: #2c3e50; font-variant-numeric: tabular-nums; }
  .bar-value em { color: #95a5a6; font-style: normal; font-size: 11px; margin-left: 6px; }

  .rank { list-style: none; display: flex; flex-direction: column; gap: 2px; }
  .rank li { display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid #f2f4f8; font-size: 12px; }
  .rank li:last-child { border-bottom: none; }
  .rank-dot { width: 9px; height: 9px; border-radius: 50%; }
  .rank-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #34495e; }
  .rank-value { color: #7f8c8d; font-variant-numeric: tabular-nums; }

  .tbl, .matrix { width: 100%; border-collapse: collapse; font-size: 12px; }
  .tbl th, .matrix th { text-align: left; font-weight: 600; color: #7f8c8d; padding: 6px 8px; border-bottom: 1px solid #e0e3eb; white-space: nowrap; }
  .tbl td, .matrix td { padding: 6px 8px; border-bottom: 1px solid #f2f4f8; vertical-align: middle; }
  .matrix th.num, .matrix td.num, .tbl th.num, .tbl td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .matrix td.zero { color: #c8cdd6; }
  .matrix td.total { font-weight: 600; }
  .matrix .sum-row td { border-top: 1px solid #e0e3eb; background: #fafbfc; color: #34495e; }
  .tbl td.mono { font-family: Consolas, monospace; word-break: break-all; max-width: 320px; }
  .tbl td.muted { color: #95a5a6; }
  .tbl td.zero { color: #c8cdd6; }
  .tbl td.strong { font-weight: 600; }
  .rank-tbl .idx { color: #95a5a6; width: 34px; }
  .rank-tbl .anno-name { max-width: 280px; }
  .rank-tbl .anno-pkg { color: #95a5a6; font-size: 11px; margin-left: 6px; }
  .rank-tbl .anno-link { color: #c0392b; text-decoration: none; border-bottom: 1px dashed #e0a9a1; }
  .rank-tbl .anno-link:hover { color: #922b21; border-bottom-style: solid; }
  .rank-tbl .pct { width: 170px; white-space: nowrap; }
  .rank-tbl .pct .bar-track { display: inline-block; width: 110px; vertical-align: middle; }
  .rank-tbl .pct em { margin-left: 8px; color: #95a5a6; font-style: normal; font-variant-numeric: tabular-nums; }
  .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 7px; vertical-align: middle; }

  .empty { color: #95a5a6; font-style: italic; font-size: 12px; padding: 6px 0; }
  .notice { font-size: 12px; color: #b7791f; background: #fffbe6; border: 1px solid #ffe58f; border-radius: 6px; padding: 8px 12px; margin-bottom: 14px; }
  .table-wrap { max-height: 340px; overflow: auto; }
  .table-wrap.tall { max-height: 460px; }
  .cols.single { grid-template-columns: 1fr; }
  footer { padding: 16px 32px; text-align: center; font-size: 12px; color: #95a5a6; border-top: 1px solid #e0e3eb; background: #fff; }
</style>
</head>
<body>
<header>
  <h1>Java 代码统计报告</h1>
  <p>仅呈现工程级统计数据 · 网络图见「代码图对象」，方法链路见「方法链路追踪」</p>${homeLink}
</header>
<main>
${graphNotice}
  <h2>总览</h2>
  <div class="kpis">${kpiHtml}</div>

  <h2>节点统计</h2>
  <div class="cols">
    ${panel('成员构成', `<div class="minis">${membersHtml}</div>`, '全工程合计')}
    ${panel('类种类分布', barList(s.byKind, result.classes.length), `共 ${result.classes.length} 个类单元`)}
  </div>
  <div class="cols">
    ${panel('图节点类型分布', barList(s.byNodeType, graph ? graph.nodes.length : 0), graph ? `共 ${graph.nodes.length} 个节点` : '')}
    ${panel('按包分布', `<div class="table-wrap">${pkgHtml}</div>`, `${s.packageCount} 个包`)}
  </div>
  <div class="cols">
    ${panel('类规模 Top 15', `<div class="table-wrap">${sizeHtml}</div>`, '按方法数 + 字段数')}
    ${panel('源文件统计', `<div class="minis">
      <div class="mini"><span class="mini-value">${s.fileCount}</span><span class="mini-label">源文件</span></div>
      <div class="mini"><span class="mini-value">${avg(result.classes.length, s.fileCount)}</span><span class="mini-label">类 / 文件</span></div>
      <div class="mini"><span class="mini-value">${avg(totalOf(s.members, 0), result.classes.length)}</span><span class="mini-label">方法 / 类</span></div>
      <div class="mini"><span class="mini-value">${avg(totalOf(s.members, 1), result.classes.length)}</span><span class="mini-label">字段 / 类</span></div>
    </div>`, '密度指标')}
  </div>

  <h2>关系统计</h2>
  <div class="cols">
    ${panel('关系类型分布', barList(s.byRelType, result.relations.length), `共 ${result.relations.length} 条`)}
    ${panel('图边类型分布', barList(s.byEdgeType, graph ? graph.edges.length : 0), graph ? `共 ${graph.edges.length} 条` : '')}
  </div>
  <div class="cols">
    ${panel('出度 Top 12', rankList(s.outTop, '条'), '该类向外发出的关系数')}
    ${panel('入度 Top 12', rankList(s.inTop, '条'), '外部指向该类的关系数')}
  </div>

  <h2>类型交叉统计</h2>
  <div class="cols">
    ${panel('关系类型 × 源类种类', renderMatrix(s), '按关系发起方的类种类统计')}
    ${panel('修饰符分布', barList(s.modifiers, s.modifiers.reduce((a, b) => a + b.value, 0)), '类与成员上的修饰符')}
  </div>
  <div class="cols">
    ${panel('未决符号种类分布', barList(s.unresolvedKinds, result.unresolvedSymbols.length), `共 ${result.unresolvedSymbols.length} 个`)}
    ${panel('注解引用次数 Top 10', barList(s.annotations, s.annotationSummary.total), `${s.annotationSummary.kinds} 种注解 · 共 ${s.annotationSummary.total} 次`)}
  </div>

  <h2>注解引用统计</h2>
  <div class="cols single">
    ${panel(
      '注解引用次数排行（全量）',
      annotationRankTable(s.annotationRank, s.annotationSummary.total, annotationLinks),
      `按引用次数降序 · ${s.annotationSummary.kinds} 种注解 · 共 ${s.annotationSummary.total} 次引用${
        annotationLinks && Object.keys(annotationLinks).length ? ' · 红色注解名可跳转引用明细' : ''
      }`,
    )}
  </div>
  <div class="cols">
    ${panel('注解构成', `<div class="minis">
      <div class="mini"><span class="mini-value">${s.annotationSummary.kinds}</span><span class="mini-label">注解种类</span></div>
      <div class="mini"><span class="mini-value">${s.annotationSummary.total}</span><span class="mini-label">引用总次数</span></div>
      <div class="mini"><span class="mini-value">${s.annotationSummary.withArgs}</span><span class="mini-label">带参注解</span></div>
      <div class="mini"><span class="mini-value">${s.annotationSummary.marker}</span><span class="mini-label">标记注解</span></div>
      <div class="mini"><span class="mini-value">${s.annotationSummary.annotatedClasses}</span><span class="mini-label">被注解的类</span></div>
      <div class="mini"><span class="mini-value">${avg(s.annotationSummary.total, result.classes.length)}</span><span class="mini-label">注解 / 类</span></div>
    </div>`, '全工程合计')}
    ${panel('被注解最多的类 Top 10', rankList(s.annotatedClassTop, '处'), '类级 + 字段级 + 方法级注解合计')}
  </div>
</main>
<footer>由 codeParseForRes 生成</footer>
</body>
</html>`;
}

function totalOf(members: { value: number }[], index: number): number {
  return members[index]?.value ?? 0;
}

function avg(total: number, count: number): string {
  if (!count) return '0';
  return String(Math.round((total / count) * 10) / 10);
}

/**
 * 便利：从 ParseResult 生成 HTML 并写入指定路径。
 */
export function buildHtmlReportPath(jsonPath: string): string {
  const dir = path.dirname(jsonPath);
  const base = path.basename(jsonPath, path.extname(jsonPath));
  return path.join(dir, base + '.html');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
