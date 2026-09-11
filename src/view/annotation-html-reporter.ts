import type { AnnotationOccurrence, AnnotationTarget } from '../analyzer/annotation-collector';

/**
 * 单个注解的独立页面渲染器。
 *
 * 页面自包含（内联 CSS + JS + 数据），提供：
 *   - 顶部统计：引用总数、涉及类数、涉及文件数、按标注位置分布
 *   - 过滤：关键字（目标/类/文件/参数）+ 标注位置下拉
 *   - 分页：首页/上一页/下一页/末页、页码跳转、每页条数切换
 *
 * 数据量可能很大，故表格由前端按页渲染，不一次性铺 DOM。
 */

export interface AnnotationPageOptions {
  /** 配置中的注解名（可能带包名） */
  annotation: string;
  /** 该注解的全部引用 */
  occurrences: AnnotationOccurrence[];
  /** 每页条数 */
  pageSize: number;
  /** 返回首页的链接，默认 index.html */
  indexHref?: string;
  /** 生成时间等附加说明 */
  note?: string;
}

const TARGET_LABEL: Record<AnnotationTarget, string> = {
  class: '类',
  field: '字段',
  method: '方法',
  constructor: '构造器',
};

const TARGET_ORDER: AnnotationTarget[] = ['class', 'field', 'method', 'constructor'];

const PAGE_SIZE_OPTIONS = [20, 50, 100, 200];

/** 模板中内嵌 JSON 的占位符 */
const DATA_JSON_PLACEHOLDER = '\u0000ANNO_DATA_JSON\u0000';

export function renderAnnotationPage(opts: AnnotationPageOptions): string {
  const { head, tail, data } = annotationPageParts(opts);
  return head + JSON.stringify(data).replace(/</g, '\\u003c') + tail;
}

/**
 * 拆成 head / JSON / tail 三段，供引用条数极多时流式落盘。
 * data 与页面统计口径一致（同一份排序后的列表）。
 */
export function annotationPageParts(opts: AnnotationPageOptions): {
  head: string;
  tail: string;
  data: AnnotationOccurrence[];
} {
  const data = prepareList(opts);
  const tpl = buildAnnotationPageTemplate(opts, DATA_JSON_PLACEHOLDER);
  const idx = tpl.indexOf(DATA_JSON_PLACEHOLDER);
  return {
    head: tpl.slice(0, idx),
    tail: tpl.slice(idx + DATA_JSON_PLACEHOLDER.length),
    data,
  };
}

/** 排序后的引用列表（按文件、行号） */
function prepareList(opts: AnnotationPageOptions): AnnotationOccurrence[] {
  return [...opts.occurrences].sort(
    (a, b) =>
      (a.filePath || '').localeCompare(b.filePath || '') ||
      (a.line ?? a.startIndex) - (b.line ?? b.startIndex),
  );
}

function buildAnnotationPageTemplate(opts: AnnotationPageOptions, dataJson: string): string {
  const name = opts.annotation;
  const simple = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  const list = prepareList(opts);

  const classCount = new Set(list.map((o) => o.classFqn)).size;
  const fileCount = new Set(list.map((o) => o.filePath)).size;
  const byTarget = TARGET_ORDER.map((t) => ({
    target: t,
    label: TARGET_LABEL[t],
    value: list.filter((o) => o.target === t).length,
  }));

  const sizeOptions = [...new Set([...PAGE_SIZE_OPTIONS, opts.pageSize])].sort((a, b) => a - b);

  const statsHtml = [
    { label: '引用总数', value: list.length },
    { label: '涉及类', value: classCount },
    { label: '涉及文件', value: fileCount },
    ...byTarget.map((t) => ({ label: '标注在' + t.label, value: t.value })),
  ]
    .map(
      (s) =>
        `<div class="stat"><span class="stat-value">${s.value}</span><span class="stat-label">${escapeHtml(
          s.label,
        )}</span></div>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>@${escapeHtml(simple)} 引用明细</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6fa; color: #2c3e50; min-height: 100vh; display: flex; flex-direction: column; }
  header { background: #2c3e50; color: #ecf0f1; padding: 20px 28px; }
  header h1 { font-size: 20px; font-weight: 600; }
  header h1 .pkg { font-size: 13px; opacity: 0.7; margin-left: 8px; font-weight: 400; }
  header p { margin-top: 6px; font-size: 13px; opacity: 0.75; }
  header a { color: #9fc5f8; }
  .stats { display: flex; flex-wrap: wrap; gap: 12px; padding: 18px 28px 0; }
  .stat { background: #fff; border: 1px solid #e0e3eb; border-radius: 6px; padding: 10px 16px; min-width: 104px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .stat-value { display: block; font-size: 20px; font-weight: 600; }
  .stat-label { display: block; margin-top: 2px; font-size: 12px; color: #7f8c8d; }
  main { flex: 1; padding: 18px 28px 32px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
  .toolbar input[type=text], .toolbar select { font: inherit; font-size: 13px; padding: 6px 10px; border: 1px solid #d5d9e2; border-radius: 5px; background: #fff; color: #2c3e50; }
  .toolbar input[type=text] { min-width: 260px; }
  .toolbar .grow, .pager .grow { flex: 1; min-width: 0; }
  .count { font-size: 13px; color: #5a6473; }
  .panel { background: #fff; border: 1px solid #e0e3eb; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th { position: sticky; top: 0; background: #f8f9fc; text-align: left; font-size: 12px; color: #7f8c8d; padding: 9px 10px; border-bottom: 1px solid #e0e3eb; white-space: nowrap; }
  tbody td { padding: 8px 10px; border-bottom: 1px solid #f2f4f8; vertical-align: top; }
  tbody tr:hover { background: #fafbfd; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.mono, .mono { font-family: Consolas, "Courier New", monospace; }
  td.idx { color: #95a5a6; width: 46px; }
  td.target { word-break: break-all; max-width: 320px; }
  td.file { word-break: break-all; max-width: 300px; color: #5a6473; font-size: 12px; }
  td.args { word-break: break-all; max-width: 240px; color: #5a6473; font-size: 12px; }
  td.args:empty::before, td.args .none { color: #c8cdd6; }
  .pkg { color: #95a5a6; font-size: 11px; margin-left: 6px; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; color: #fff; white-space: nowrap; }
  .tag.t-class { background: #4a90e2; }
  .tag.t-field { background: #f39c12; }
  .tag.t-method { background: #16a085; }
  .tag.t-constructor { background: #8e44ad; }
  .pager { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 12px 28px 28px; }
  .pager button { font: inherit; font-size: 13px; padding: 6px 14px; border: 1px solid #d5d9e2; background: #fff; color: #2c3e50; border-radius: 5px; cursor: pointer; }
  .pager button:hover:not(:disabled) { border-color: #4a90e2; color: #4a90e2; }
  .pager button:disabled { opacity: 0.45; cursor: not-allowed; }
  .pager .page-info { font-size: 13px; color: #5a6473; }
  .pager input { font: inherit; font-size: 13px; width: 64px; padding: 6px 8px; border: 1px solid #d5d9e2; border-radius: 5px; text-align: center; }
  .empty-row td { text-align: center; color: #95a5a6; font-style: italic; padding: 28px 0; }
  footer { padding: 14px 28px; text-align: center; font-size: 12px; color: #95a5a6; border-top: 1px solid #e0e3eb; background: #fff; }
</style>
</head>
<body>
<header>
  <h1>@${escapeHtml(simple)}${
    name !== simple ? `<span class="pkg">${escapeHtml(name)}</span>` : ''
  }</h1>
  <p>注解引用明细 · 共 ${list.length} 处${
    opts.note ? ` · ${escapeHtml(opts.note)}` : ''
  } · 返回 <a href="${escapeAttr(opts.indexHref ?? 'index.html')}">总览首页</a></p>
</header>
<section class="stats">${statsHtml}</section>
<main>
  <div class="toolbar">
    <input type="text" id="q" placeholder="搜索目标 / 类 / 文件 / 参数" />
    <select id="kind">
      <option value="all">全部位置</option>
      ${TARGET_ORDER.map((t) => `<option value="${t}">${TARGET_LABEL[t]}</option>`).join('')}
    </select>
    <select id="size">${sizeOptions
      .map((s) => `<option value="${s}"${s === opts.pageSize ? ' selected' : ''}>每页 ${s} 条</option>`)
      .join('')}</select>
    <span class="grow"></span>
    <span class="count" id="count"></span>
  </div>
  <div class="panel">
    <table>
      <thead><tr>
        <th class="num">#</th><th>目标</th><th>位置</th><th>所属类</th><th>文件</th><th class="num">行</th><th>注解参数</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
</main>
<div class="pager">
  <button id="first">首页</button>
  <button id="prev">上一页</button>
  <span class="page-info">第 <input type="text" id="page" value="1" /> / <span id="pages">1</span> 页</span>
  <button id="next">下一页</button>
  <button id="last">末页</button>
  <span class="grow"></span>
  <span class="count" id="range"></span>
</div>
<footer>由 codeParseForRes 生成</footer>
<script>
var DATA = ${dataJson};
var KIND_LABEL = {"class":"类","field":"字段","method":"方法","constructor":"构造器"};
var state = { q: "", kind: "all", page: 1, size: ${opts.pageSize} };

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function simpleName(fqn) {
  var i = String(fqn).lastIndexOf(".");
  return i >= 0 ? fqn.slice(i + 1) : fqn;
}
function matches(o) {
  if (state.kind !== "all" && o.target !== state.kind) return false;
  var q = state.q.trim().toLowerCase();
  if (!q) return true;
  var hay = (o.targetName + " " + o.classFqn + " " + (o.filePath || "") + " " + (o.arguments || "")).toLowerCase();
  return hay.indexOf(q) >= 0;
}
function view() {
  var list = DATA.filter(matches);
  var pages = Math.max(1, Math.ceil(list.length / state.size));
  if (state.page > pages) state.page = pages;
  if (state.page < 1) state.page = 1;
  var start = (state.page - 1) * state.size;
  var slice = list.slice(start, start + state.size);

  var html = slice.map(function (o, i) {
    return '<tr>' +
      '<td class="num idx">' + (start + i + 1) + '</td>' +
      '<td class="target mono">' + esc(o.targetName) + '</td>' +
      '<td><span class="tag t-' + o.target + '">' + KIND_LABEL[o.target] + '</span></td>' +
      '<td class="mono">' + esc(o.classSimpleName) + '<span class="pkg">' + esc(o.package) + '</span></td>' +
      '<td class="file mono" title="' + esc(o.filePath) + '">' + esc(o.filePath) + '</td>' +
      '<td class="num">' + (o.line == null ? '-' : o.line) + '</td>' +
      '<td class="args mono">' + (o.arguments ? esc(o.arguments) : '<span class="none">-</span>') + '</td>' +
      '</tr>';
  }).join("");
  document.getElementById("tbody").innerHTML = html || '<tr class="empty-row"><td colspan="7">没有匹配的记录</td></tr>';

  document.getElementById("count").textContent = "筛选出 " + list.length + " 条 / 共 " + DATA.length + " 条";
  document.getElementById("pages").textContent = String(pages);
  document.getElementById("page").value = String(state.page);
  document.getElementById("range").textContent = list.length
    ? "当前显示第 " + (start + 1) + " - " + Math.min(start + state.size, list.length) + " 条"
    : "";
  document.getElementById("first").disabled = state.page <= 1;
  document.getElementById("prev").disabled = state.page <= 1;
  document.getElementById("next").disabled = state.page >= pages;
  document.getElementById("last").disabled = state.page >= pages;
}
function gotoPage(p) { state.page = p; view(); }

document.getElementById("q").addEventListener("input", function (e) { state.q = e.target.value; state.page = 1; view(); });
document.getElementById("kind").addEventListener("change", function (e) { state.kind = e.target.value; state.page = 1; view(); });
document.getElementById("size").addEventListener("change", function (e) { state.size = parseInt(e.target.value, 10) || 50; state.page = 1; view(); });
document.getElementById("page").addEventListener("change", function (e) { gotoPage(parseInt(e.target.value, 10) || 1); });
document.getElementById("first").addEventListener("click", function () { gotoPage(1); });
document.getElementById("prev").addEventListener("click", function () { gotoPage(state.page - 1); });
document.getElementById("next").addEventListener("click", function () { gotoPage(state.page + 1); });
document.getElementById("last").addEventListener("click", function () { gotoPage(parseInt(document.getElementById("pages").textContent, 10) || 1); });

view();
</script>
</body>
</html>`;
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
