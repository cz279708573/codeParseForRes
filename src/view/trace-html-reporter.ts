import type { Graph, GraphNode, GraphEdge } from '../model/types';

/**
 * 方法链路追踪可视化。
 *
 * 与 graph-html-reporter 不同，本视图只关注"方法"这一种节点：
 *   - 顶部搜索框仅检索方法节点
 *   - 选中方法后，画布上按规则展开其对外关系：
 *     1) 接口方法（所属类 kind === 'interface'）：
 *        展开所有"实现了该接口方法"的方法（入边 implement-method 的 source）
 *     2) 抽象方法（含 abstract 修饰符）：
 *        展开所有重写该方法的方法（入边 override 的 source）
 *     3) 普通方法：
 *        展开对外调用（出边 call / field-access）+ 被重写（入边 override）
 *
 * 画布为从左至右的思维导图布局：根在最左，每次展开的子节点落在父节点右侧。
 * 每次展开均生成新的画布实例 id，即使数据节点已存在于画布上也视为不同点，
 * 故同一数据节点可在不同枝上重复出现，互不影响布局。
 *
 * 自包含 HTML，无外部依赖。
 */
/** 模板中内嵌 JSON 的占位符，落盘时替换为真实数据 */
const GRAPH_JSON_PLACEHOLDER = '\u0000GRAPH_JSON_DATA\u0000';

export interface TraceHtmlOptions {
  /** 返回首页的链接（通常为 <baseName>.index.html）；传空字符串则不渲染返回入口 */
  indexHref?: string;
}

export function renderTraceHtml(graph: Graph, opts: TraceHtmlOptions = {}): string {
  const { head, tail } = traceHtmlParts(opts);
  return head + JSON.stringify(graph).replace(/</g, '\\u003c') + tail;
}

/**
 * 拆成 head / JSON / tail 三段，供超大数据流式落盘。
 */
export function traceHtmlParts(opts: TraceHtmlOptions = {}): { head: string; tail: string } {
  const tpl = buildTraceHtmlTemplate(GRAPH_JSON_PLACEHOLDER, opts.indexHref ?? 'index.html');
  const idx = tpl.indexOf(GRAPH_JSON_PLACEHOLDER);
  return { head: tpl.slice(0, idx), tail: tpl.slice(idx + GRAPH_JSON_PLACEHOLDER.length) };
}

function buildTraceHtmlTemplate(jsonText: string, indexHref: string): string {
  const homeLink = indexHref
    ? `\n  <a class="home-link" href="${escapeAttr(indexHref)}" title="返回总览首页">← 返回首页</a>`
    : '';
  const methodColor = '#16a085';
  const fieldColor = '#f39c12';
  const callColor = '#27ae60';
  const fieldAccessColor = '#e67e22';
  const implMethodColor = '#5dade2';
  const centerColor = '#e74c3c';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>方法链路追踪</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6fa; color: #2c3e50; height: 100vh; display: flex; flex-direction: column; }
  header { background: #2c3e50; color: #ecf0f1; padding: 10px 20px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 16px; font-weight: 500; }
  header .home-link { font-size: 12px; color: #ecf0f1; text-decoration: none; padding: 3px 10px; border-radius: 3px; background: rgba(255,255,255,0.12); white-space: nowrap; }
  header .home-link:hover { background: rgba(255,255,255,0.26); }
  header .stats { font-size: 13px; opacity: 0.85; }
  header .search-wrap { margin-left: auto; position: relative; width: 420px; max-width: 50vw; }
  header .search-wrap input { width: 100%; padding: 8px 12px; font-size: 13px; border: 1px solid #d0d3db; border-radius: 4px; }
  header .search-wrap .suggestions { position: absolute; top: 100%; left: 0; right: 0; max-height: 320px; overflow-y: auto; background: #fff; border: 1px solid #d0d3db; border-top: none; border-radius: 0 0 4px 4px; z-index: 100; display: none; }
  header .search-wrap .suggestions.show { display: block; }
  header .search-wrap .sug-item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f0f2f7; font-size: 12px; }
  header .search-wrap .sug-item:hover { background: #e8f0fe; }
  header .search-wrap .sug-item .sug-label { font-weight: 500; color: #16a085; }
  header .search-wrap .sug-item .sug-fqn { font-size: 11px; color: #7f8c8d; margin-top: 2px; word-break: break-all; }
  .breadcrumb { padding: 8px 20px; background: #fff; border-bottom: 1px solid #e0e3eb; font-size: 12px; color: #5a6473; min-height: 34px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .breadcrumb .tag { padding: 3px 8px; border-radius: 3px; font-size: 11px; }
  .breadcrumb .tag.iface { background: #eaf2fb; color: #2980b9; }
  .breadcrumb .tag.impl { background: #e8f8f0; color: #16a085; }
  .breadcrumb .tag.call { background: #eef7ee; color: #27ae60; }
  .breadcrumb .tag.field { background: #fdf3e7; color: #e67e22; }
  .breadcrumb code { background: #f0f2f7; padding: 1px 5px; border-radius: 2px; font-size: 11px; }
  .main { flex: 1; display: flex; min-height: 0; }
  .graph { flex: 1; position: relative; background: #fafbfc; overflow: hidden; }
  .graph svg { width: 100%; height: 100%; cursor: grab; }
  .graph svg:active { cursor: grabbing; }
  .detail { width: 320px; min-width: 240px; background: #fff; border-left: 1px solid #e0e3eb; overflow-y: auto; padding: 14px; font-size: 13px; }
  .detail h2 { font-size: 14px; margin-bottom: 8px; word-break: break-all; color: #16a085; }
  .detail section { margin-bottom: 14px; }
  .detail section h3 { font-size: 12px; color: #7f8c8d; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .detail .meta-line { color: #5a6473; margin-bottom: 3px; word-break: break-all; }
  .detail .meta-line code { background: #f0f2f7; padding: 1px 4px; border-radius: 2px; font-size: 12px; }
  .detail .rel { font-size: 12px; margin-bottom: 4px; cursor: pointer; }
  .detail .rel:hover { text-decoration: underline; color: #2980b9; }
  .detail .rel .arrow { color: #95a5a6; margin: 0 4px; }
  .hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); color: #95a5a6; font-size: 14px; font-style: italic; text-align: center; pointer-events: none; }
  .hint .big { font-size: 18px; color: #7f8c8d; margin-bottom: 8px; }
  .empty { color: #95a5a6; font-style: italic; padding: 8px; }
</style>
</head>
<body>
<header>
  <h1>方法链路追踪</h1>${homeLink}
  <div class="stats" id="stats"></div>
  <div class="search-wrap">
    <input id="search" placeholder="搜索方法名（仅方法节点）…" autocomplete="off" />
    <div class="suggestions" id="suggestions"></div>
  </div>
</header>
<div class="breadcrumb" id="breadcrumb"></div>
<div class="main">
  <div class="graph"><svg id="svg"></svg></div>
  <aside class="detail" id="detail"><div class="empty">在顶部搜索并选择一个方法节点</div></aside>
</div>
<script type="application/json" id="data">${jsonText}</script>
<script>
(function () {
  var graph = JSON.parse(document.getElementById('data').textContent);

  var methodColor = ${JSON.stringify(methodColor)};
  var fieldColor = ${JSON.stringify(fieldColor)};
  var callColor = ${JSON.stringify(callColor)};
  var fieldAccessColor = ${JSON.stringify(fieldAccessColor)};
  var implMethodColor = ${JSON.stringify(implMethodColor)};
  var centerColor = ${JSON.stringify(centerColor)};

  // 节点/边索引
  var nodeById = {};
  graph.nodes.forEach(function (n) { nodeById[n.id] = n; });
  var outEdges = {}, inEdges = {};
  graph.edges.forEach(function (e) {
    (outEdges[e.source] = outEdges[e.source] || []).push(e);
    (inEdges[e.target] = inEdges[e.target] || []).push(e);
  });

  // 方法节点与外部方法节点参与搜索
  var methodNodes = graph.nodes.filter(function (n) { return n.type === 'method' || (n.type === 'external' && n.id.indexOf('#') >= 0); });

  document.getElementById('stats').textContent = '方法节点 ' + methodNodes.length + ' · 总节点 ' + graph.nodes.length + ' · 总边 ' + graph.edges.length;

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // 判断某方法是否为接口方法：其所属类 kind === 'interface'
  function isInterfaceMethod(methodNode) {
    if (!methodNode || !methodNode.classFqn) return false;
    var cls = nodeById[methodNode.classFqn];
    return !!cls && cls.kind === 'interface';
  }

  // 判断某方法是否为抽象方法：含 abstract 修饰符
  function isAbstractMethod(methodNode) {
    if (!methodNode) return false;
    return !!(methodNode.modifiers && methodNode.modifiers.indexOf('abstract') >= 0);
  }

  // 追踪种类：'iface' 接口方法 | 'abstract' 抽象方法 | 'concrete' 普通方法
  function traceKind(methodNode) {
    if (isInterfaceMethod(methodNode)) return 'iface';
    if (isAbstractMethod(methodNode)) return 'abstract';
    return 'concrete';
  }

  // ==================== 搜索 ====================
  var searchInput = document.getElementById('search');
  var suggestionsEl = document.getElementById('suggestions');
  var selectedMethodId = null;

  function renderSuggestions(filter) {
    suggestionsEl.innerHTML = '';
    var f = (filter || '').toLowerCase();
    if (!f) { suggestionsEl.classList.remove('show'); return; }
    var matches = [];
    methodNodes.forEach(function (n) {
      if (n.label.toLowerCase().indexOf(f) >= 0 || n.id.toLowerCase().indexOf(f) >= 0) {
        matches.push(n);
      }
    });
    matches.sort(function (a, b) {
      var la = a.label.toLowerCase(), lb = b.label.toLowerCase();
      var sa = la.indexOf(f), sb = lb.indexOf(f);
      if (sa !== sb) return sa - sb;
      return a.label.length - b.label.length;
    });
    matches = matches.slice(0, 50);
    if (matches.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'sug-item';
      empty.style.cursor = 'default';
      empty.style.color = '#95a5a6';
      empty.textContent = '无匹配方法';
      suggestionsEl.appendChild(empty);
      suggestionsEl.classList.add('show');
      return;
    }
    matches.forEach(function (n) {
      var item = document.createElement('div');
      item.className = 'sug-item';
      var kind = traceKind(n);
      var badge = '';
      if (kind === 'iface') badge = ' <span style="color:#2980b9;font-size:10px;">[接口]</span>';
      else if (kind === 'abstract') badge = ' <span style="color:#8e44ad;font-size:10px;">[抽象]</span>';
      item.innerHTML =
        '<div class="sug-label">' + escapeHtml(n.label) + badge + '</div>' +
        '<div class="sug-fqn">' + escapeHtml(n.classFqn) + (n.dataType ? ' : ' + escapeHtml(n.dataType) : '') + '</div>';
      item.onclick = function () {
        selectedMethodId = n.id;
        searchInput.value = n.label;
        suggestionsEl.classList.remove('show');
        renderCanvas(n.id);
      };
      suggestionsEl.appendChild(item);
    });
    suggestionsEl.classList.add('show');
  }

  searchInput.oninput = function () { renderSuggestions(searchInput.value); };
  searchInput.onfocus = function () { if (searchInput.value) renderSuggestions(searchInput.value); };
  searchInput.onkeydown = function (e) {
    if (e.key === 'Enter') {
      var first = suggestionsEl.querySelector('.sug-item:not([style*="cursor: default"])');
      if (first) first.click();
    } else if (e.key === 'Escape') {
      suggestionsEl.classList.remove('show');
    }
  };
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.search-wrap')) suggestionsEl.classList.remove('show');
  });

  // ==================== 面包屑 ====================
  var breadcrumbEl = document.getElementById('breadcrumb');
  function renderBreadcrumb(methodNode, relatedEdges, kind) {
    var html = '<span style="color:#2c3e50;">当前方法：</span>';
    html += '<code>' + escapeHtml(methodNode.classFqn) + '#' + escapeHtml(methodNode.label) + '</code>';
    if (kind === 'iface') {
      html += '<span class="tag iface">接口方法</span>';
      html += '<span class="tag impl">实现方法 ' + relatedEdges.length + '</span>';
    } else if (kind === 'abstract') {
      html += '<span class="tag" style="background:#f4ecf7;color:#8e44ad;">抽象方法</span>';
      html += '<span class="tag" style="background:#fdeaea;color:#c0392b;">重写方法 ' + relatedEdges.length + '</span>';
    } else {
      var calls = relatedEdges.filter(function (e) { return e.type === 'call'; }).length;
      var fas = relatedEdges.filter(function (e) { return e.type === 'field-access'; }).length;
      var ovs = relatedEdges.filter(function (e) { return e.type === 'override'; }).length;
      if (ovs) html += '<span class="tag" style="background:#fdeaea;color:#c0392b;">重写方法 ' + ovs + '</span>';
      if (calls) html += '<span class="tag call">调用方法 ' + calls + '</span>';
      if (fas) html += '<span class="tag field">访问字段 ' + fas + '</span>';
      if (!calls && !fas && !ovs) html += '<span class="tag" style="background:#eee;color:#7f8c8d;">无对外关系</span>';
    }
    breadcrumbEl.innerHTML = html;
  }

  // ==================== 详情面板 ====================
  var detailEl = document.getElementById('detail');
  function renderDetail(methodNode, relatedEdges, kind) {
    var n = methodNode;
    var isExternal = n.type === 'external';
    var kindBadge = isExternal ? ' <span style="font-size:11px;color:#95a5a6;">[外部]</span>'
      : kind === 'iface' ? ' <span style="font-size:11px;color:#2980b9;">[接口方法]</span>'
      : kind === 'abstract' ? ' <span style="font-size:11px;color:#8e44ad;">[抽象方法]</span>' : '';
    var html = '<h2>' + escapeHtml(n.label) + kindBadge + '</h2>';
    html += '<section><h3>元信息</h3>';
    html += '<div class="meta-line">ID: <code>' + escapeHtml(n.id) + '</code></div>';
    html += '<div class="meta-line">所属类: <code>' + escapeHtml(n.classFqn) + '</code></div>';
    if (isExternal) html += '<div class="meta-line">来源: <code>外部依赖（非源码）</code></div>';
    if (n.dataType) html += '<div class="meta-line">返回类型: <code>' + escapeHtml(n.dataType) + '</code></div>';
    if (n.isConstructor) html += '<div class="meta-line">构造器: 是</div>';
    if (n.parameters && n.parameters.length) {
      html += '<div class="meta-line">参数: ' + n.parameters.map(function (p) { return '<code>' + escapeHtml(p.type) + '</code> ' + escapeHtml(p.name); }).join(', ') + '</div>';
    }
    if (n.modifiers && n.modifiers.length) html += '<div class="meta-line">修饰: ' + n.modifiers.map(function (m) { return '<code>' + escapeHtml(m) + '</code>'; }).join(' ') + '</div>';
    if (n.filePath) html += '<div class="meta-line">文件: <code>' + escapeHtml(n.filePath) + '</code></div>';
    html += '</section>';

    var title;
    if (kind === 'iface') title = '实现该方法的方法（入边 implement-method）';
    else if (kind === 'abstract') title = '重写该方法的方法（入边 override）';
    else title = '对外关系（出边 call / field-access · 入边 override）';
    if (relatedEdges.length) {
      html += '<section><h3>' + title + ' (' + relatedEdges.length + ')</h3>';
      relatedEdges.forEach(function (e) {
        var isIncoming = (e.type === 'implement-method' || e.type === 'override');
        var otherId = isIncoming ? e.source : e.target;
        var other = nodeById[otherId];
        var color = e.type === 'call' ? callColor : (e.type === 'field-access' ? fieldAccessColor : (e.type === 'override' ? '#c0392b' : implMethodColor));
        var eLabel = e.type === 'call' ? '调用' : (e.type === 'field-access' ? '访问' : (e.type === 'override' ? '重写' : '实现'));
        if (isIncoming) {
          html += '<div class="rel" data-target="' + escapeHtml(otherId) + '" data-edge-type="' + e.type + '"><span style="color:' + color + '">' + escapeHtml(other ? other.label : otherId) + '</span> <span class="arrow">—' + eLabel + '→</span></div>';
        } else {
          html += '<div class="rel" data-target="' + escapeHtml(otherId) + '" data-edge-type="' + e.type + '"><span style="color:' + color + '">' + eLabel + '</span> <span class="arrow">→</span> ' + escapeHtml(other ? other.label : otherId) + '</div>';
        }
      });
      html += '</section>';
    } else {
      html += '<section><h3>' + title + '</h3><div class="empty">无</div></section>';
    }
    detailEl.innerHTML = html;

    // 点击关系项：在当前聚焦实例下，向右展开该具体子节点
    detailEl.querySelectorAll('.rel').forEach(function (el) {
      el.onclick = function () {
        var tid = el.getAttribute('data-target');
        var etype = el.getAttribute('data-edge-type');
        if (highlightId && instances[highlightId]) {
          expandOneChild(highlightId, tid, etype);
        }
      };
    });
  }

  // ==================== 画布（思维导图：从左至右树状布局）====================
  var svg = document.getElementById('svg');
  var width = svg.clientWidth || 800;
  var height = svg.clientHeight || 600;

  // 画布实例模型：每次展开均生成新 canvasId，使同一数据节点在不同枝上可重复出现
  // instance: { canvasId, nodeId, label, type, x, y, parentCanvasId, depth }
  var instances = {};        // canvasId -> instance
  var instanceEdges = {};   // edgeId -> { source, target, type }（source/target 均为 canvasId）
  var childKeyMap = {};     // parentCanvasId|childNodeId|edgeType -> childCanvasId（同一父下不重复展开同一子）
  var rootCanvasId = null;  // 根实例（搜索选中点）
  var highlightId = null;   // 当前聚焦的 canvasId
  var cidSeq = 0;
  function newCanvasId() { return 'c' + (++cidSeq) + '_' + Math.floor(Math.random() * 100000); }

  var hintEl = document.createElement('div');
  hintEl.className = 'hint';
  hintEl.innerHTML = '<div class="big">画布空空如也</div>请在顶部搜索框中输入方法名，选择方法节点以追踪其链路<br/>双击画布节点可向右叠加展开下一层关系';
  svg.parentElement.appendChild(hintEl);

  // 双击判定：因 restart 重建 SVG 子树，原生 dblclick 不可靠，故以 mousedown 间隔判定
  var dragNode = null, dragOff = { x: 0, y: 0 }, dragMoved = false, downPos = null, downId = null;
  var lastDownId = null, lastDownTime = 0;
  svg.addEventListener('mousedown', function (e) {
    var fid = e.target.getAttribute('data-id'); // canvasId
    if (fid && instances[fid]) {
      var now = Date.now();
      // 双击判定：同一实例、两次 mousedown 间隔 < 350ms、且尚未拖拽
      if (lastDownId === fid && now - lastDownTime < 350) {
        var inst = instances[fid];
        var dn = nodeById[inst.nodeId];
        if (dn && (dn.type === 'method' || dn.type === 'external')) {
          var trace = expandInstance(fid);
          if (trace) {
            selectedMethodId = inst.nodeId;
            searchInput.value = dn.label;
            renderBreadcrumb(dn, trace.edges, trace.kind);
            renderDetail(dn, trace.edges, trace.kind);
          }
          selectHighlight(fid);
        }
        lastDownId = null; lastDownTime = 0;
        dragNode = null; downPos = null; downId = null; // 阻止 mouseup 触发单击选中
        return;
      }
      lastDownId = fid; lastDownTime = now;
      dragNode = instances[fid];
      dragOff = { x: e.offsetX - dragNode.x, y: e.offsetY - dragNode.y };
      downPos = { x: e.offsetX, y: e.offsetY };
      dragMoved = false;
      downId = fid;
    }
  });
  svg.addEventListener('mousemove', function (e) {
    if (dragNode) {
      if (downPos && (Math.abs(e.offsetX - downPos.x) > 3 || Math.abs(e.offsetY - downPos.y) > 3)) dragMoved = true;
      if (dragMoved) { dragNode.x = e.offsetX - dragOff.x; dragNode.y = e.offsetY - dragOff.y; restart(); }
    }
  });
  window.addEventListener('mouseup', function () {
    if (!dragMoved && downId && instances[downId]) {
      var inst = instances[downId];
      var n = nodeById[inst.nodeId];
      if (n && (n.type === 'method' || n.type === 'external')) {
        // 单击方法/外部节点：仅选中并展示其一度关系信息，不向画布叠加
        selectedMethodId = inst.nodeId;
        searchInput.value = n.label;
        var trace = buildTrace(inst.nodeId);
        renderBreadcrumb(n, trace.edges, trace.kind);
        renderDetail(n, trace.edges, trace.kind);
        selectHighlight(downId);
      } else {
        selectHighlight(downId);
      }
    }
    // 拖拽不算单击，不应衔接双击判定
    if (dragMoved) { lastDownId = null; lastDownTime = 0; }
    dragNode = null; downPos = null; downId = null;
  });

  function selectHighlight(canvasId) { highlightId = canvasId; }

  // 构建某方法的一度关系（数据层）
  function buildTrace(methodId) {
    var n = nodeById[methodId];
    if (!n || (n.type !== 'method' && n.type !== 'external')) return { nodes: [], edges: [], kind: 'concrete' };
    // 外部方法节点视同 concrete，仅展示出边 call/field-access
    var kind = n.type === 'external' ? 'concrete' : traceKind(n);
    var nodes = [n];
    var edges = [];
    var collected = {};
    collected[methodId] = true;
    if (kind === 'iface') {
      // 接口方法：展开所有实现该方法的方法（入边 implement-method）
      (inEdges[methodId] || []).forEach(function (e) {
        if (e.type === 'implement-method' && !collected[e.source]) {
          var src = nodeById[e.source];
          if (src) { nodes.push(src); edges.push(e); collected[e.source] = true; }
        } else if (e.type === 'implement-method' && collected[e.source]) {
          edges.push(e);
        }
      });
    } else if (kind === 'abstract') {
      // 抽象方法：展开所有重写该方法的方法（入边 override）
      (inEdges[methodId] || []).forEach(function (e) {
        if (e.type === 'override' && !collected[e.source]) {
          var src = nodeById[e.source];
          if (src) { nodes.push(src); edges.push(e); collected[e.source] = true; }
        } else if (e.type === 'override' && collected[e.source]) {
          edges.push(e);
        }
      });
    } else {
      // 普通方法：展开对外调用（出边 call / field-access）+ 被重写（入边 override）
      (outEdges[methodId] || []).forEach(function (e) {
        if ((e.type === 'call' || e.type === 'field-access') && !collected[e.target]) {
          var tgt = nodeById[e.target];
          if (tgt) { nodes.push(tgt); edges.push(e); collected[e.target] = true; }
        } else if ((e.type === 'call' || e.type === 'field-access') && collected[e.target]) {
          edges.push(e);
        }
      });
      (inEdges[methodId] || []).forEach(function (e) {
        if (e.type === 'override' && !collected[e.source]) {
          var src = nodeById[e.source];
          if (src) { nodes.push(src); edges.push(e); collected[e.source] = true; }
        } else if (e.type === 'override' && collected[e.source]) {
          edges.push(e);
        }
      });
    }
    return { nodes: nodes, edges: edges, kind: kind };
  }

  // 展开画布实例：为该实例的一度关系每个节点创建新的子实例（落在父节点右侧）。
  // 即使数据节点已在画布他处出现，亦生成新 canvasId 视为不同点。
  function expandInstance(canvasId) {
    var inst = instances[canvasId];
    if (!inst) return null;
    var n = nodeById[inst.nodeId];
    if (!n || (n.type !== 'method' && n.type !== 'external')) return null;
    var trace = buildTrace(inst.nodeId);
    trace.edges.forEach(function (e) {
      var isIncoming = (e.type === 'implement-method' || e.type === 'override');
      var childNodeId = isIncoming ? e.source : e.target;
      addChildInstance(canvasId, childNodeId, e.type);
    });
    layoutTree();
    return trace;
  }

  // 在指定父实例下添加单个子实例（去重：同一父下不重复展开同一数据子节点 + 同一边类型）
  function addChildInstance(parentCanvasId, childNodeId, edgeType) {
    var key = parentCanvasId + '|' + childNodeId + '|' + edgeType;
    if (childKeyMap[key]) return null; // 同一父下此子已展开
    var childNode = nodeById[childNodeId];
    if (!childNode) return null;
    var parent = instances[parentCanvasId];
    if (!parent) return null;
    var childId = newCanvasId();
    instances[childId] = {
      canvasId: childId, nodeId: childNodeId, label: childNode.label, type: childNode.type,
      x: 0, y: 0, parentCanvasId: parentCanvasId, depth: (parent.depth || 0) + 1
    };
    var eid = 'e' + (++cidSeq);
    instanceEdges[eid] = { source: parentCanvasId, target: childId, type: edgeType };
    childKeyMap[key] = childId;
    return childId;
  }

  // 仅展开一个子节点（详情面板关系项点击用）
  function expandOneChild(parentCanvasId, childNodeId, edgeType) {
    var childId = addChildInstance(parentCanvasId, childNodeId, edgeType);
    if (childId) layoutTree();
    return childId;
  }

  // 思维导图布局：以 rootCanvasId 为根，从左至右分层；子节点在父节点右侧，同层垂直排布。
  // 后序计算子树叶子数，前序按叶子比例分配垂直空间。
  function layoutTree() {
    if (!rootCanvasId) return;
    var childrenOf = {};
    Object.keys(instances).forEach(function (cid) {
      var inst = instances[cid];
      var pid = inst.parentCanvasId || '__root__';
      (childrenOf[pid] = childrenOf[pid] || []).push(cid);
    });
    function leafCount(cid) {
      var kids = childrenOf[cid] || [];
      if (!kids.length) return 1;
      var s = 0;
      for (var i = 0; i < kids.length; i++) s += leafCount(kids[i]);
      return s;
    }
    var stepX = 230, startX = 60;
    var top = 30, bottom = Math.max(height - 30, top + 60);
    function assign(cid, depth, yTop, yBottom) {
      var inst = instances[cid];
      inst.depth = depth;
      inst.x = startX + depth * stepX;
      var kids = childrenOf[cid] || [];
      if (!kids.length) { inst.y = (yTop + yBottom) / 2; return; }
      var total = leafCount(cid);
      var cur = yTop;
      kids.forEach(function (k) {
        var lc = leafCount(k);
        var h = (yBottom - yTop) * (lc / total);
        assign(k, depth + 1, cur, cur + h);
        cur += h;
      });
      inst.y = (yTop + yBottom) / 2;
    }
    assign(rootCanvasId, 0, top, bottom);
    restart();
  }

  function restart() {
    var parts = ['<defs>'];
    var edgeStyles = {
      'call': { color: callColor, dash: '' },
      'field-access': { color: fieldAccessColor, dash: '' },
      'implement-method': { color: implMethodColor, dash: '5,3' },
      'override': { color: '#c0392b', dash: '4,2' }
    };
    Object.keys(edgeStyles).forEach(function (t) {
      var s = edgeStyles[t];
      parts.push('<marker id="arr-' + t + '" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="' + s.color + '"/></marker>');
    });
    parts.push('</defs>');

    var radius = { method: 16, field: 9, class: 18, external: 12 };
    // 边（曲线，使思维导图枝条更柔和）
    Object.keys(instanceEdges).forEach(function (eid) {
      var e = instanceEdges[eid];
      var a = instances[e.source], b = instances[e.target];
      if (!a || !b) return;
      var s = edgeStyles[e.type] || { color: '#888', dash: '' };
      var ra = radius[a.type] || 12, rb = radius[b.type] || 12;
      var dx = b.x - a.x, dy = b.y - a.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var x1 = a.x + (dx / d) * ra, y1 = a.y + (dy / d) * ra;
      var x2 = b.x - (dx / d) * rb, y2 = b.y - (dy / d) * rb;
      var mx = (x1 + x2) / 2;
      var dash = s.dash ? 'stroke-dasharray="' + s.dash + '" ' : '';
      var hl = (e.source === highlightId || e.target === highlightId);
      parts.push('<path d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '" fill="none" stroke="' + s.color + '" stroke-width="' + (hl ? 2.2 : 1.4) + '" ' + dash + 'marker-end="url(#arr-' + e.type + ')" />');
    });
    // 节点
    Object.keys(instances).forEach(function (cid) {
      var inst = instances[cid];
      var r = radius[inst.type] || 12;
      var color;
      if (cid === rootCanvasId) color = centerColor;
      else if (inst.type === 'method') color = methodColor;
      else if (inst.type === 'field') color = fieldColor;
      else if (inst.type === 'external') color = '#95a5a6';
      else color = '#4a90e2';
      var hl = cid === highlightId;
      parts.push('<circle cx="' + inst.x + '" cy="' + inst.y + '" r="' + (hl ? r + 2 : r) + '" fill="' + color + '" stroke="#fff" stroke-width="' + (hl ? 3 : 2) + '" data-id="' + escapeHtml(cid) + '" style="cursor:pointer;"/>');
      parts.push('<text x="' + (inst.x + r + 5) + '" y="' + (inst.y + 4) + '" text-anchor="start" font-size="' + (cid === rootCanvasId ? 12 : 10) + '" font-weight="' + (cid === rootCanvasId ? '600' : '400') + '" fill="#2c3e50" style="pointer-events:none;">' + escapeHtml(inst.label) + '</text>');
    });
    svg.innerHTML = parts.join('');
  }

  // 搜索选中触发：重置画布，以该方法为根并向右展开其一度关系
  function renderCanvas(methodId) {
    var n = nodeById[methodId];
    if (!n) return;
    hintEl.style.display = 'none';
    instances = {}; instanceEdges = {}; childKeyMap = {};
    cidSeq = 0;
    var rootId = newCanvasId();
    rootCanvasId = rootId;
    instances[rootId] = { canvasId: rootId, nodeId: methodId, label: n.label, type: n.type, x: 0, y: 0, parentCanvasId: null, depth: 0 };
    var trace = expandInstance(rootId); // 展开根的一度关系 + 布局 + 渲染
    if (!trace) trace = buildTrace(methodId);
    renderBreadcrumb(n, trace.edges, trace.kind);
    renderDetail(n, trace.edges, trace.kind);
    selectedMethodId = methodId;
    highlightId = rootId;
  }

  window.addEventListener('resize', function () { width = svg.clientWidth; height = svg.clientHeight; layoutTree(); });
})();
</script>
</body>
</html>`;
}

/** 编译期 HTML 属性转义（与运行时脚本内的 escapeHtml 互不影响） */
function escapeAttr(s: string): string {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
