import type { Graph, GraphNode, GraphEdge } from '../model/types';

/**
 * 将 Graph 渲染为自包含 HTML 可视化页面。
 *
 * 节点三形：
 *   - class  大圆 r=20
 *   - method 中圆 r=14
 *   - field  小圆 r=8
 * 边九色：
 *   - contains       灰虚线（类含成员）
 *   - inherit         红（类继承类）
 *   - implement        蓝（类实现接口）
 *   - override         深红（方法重写父类方法）
 *   - implement-method 浅蓝（方法实现接口方法）
 *   - call             绿（方法调用方法）
 *   - field-access     橙（方法访问字段）
 *   - instantiate      紫（方法 new 创建类）
 *   - type-ref         灰实线（类型引用）
 */
export function renderGraphHtml(graph: Graph): string {
  const jsonText = JSON.stringify(graph).replace(/<\/script>/g, '<\\/script>');

  const nodeColors: Record<string, string> = {
    class: '#4a90e2',
    method: '#16a085',
    field: '#f39c12',
    annotation: '#c0392b',
    external: '#95a5a6',
  };
  const nodeRadius: Record<string, number> = { class: 20, method: 14, field: 8, annotation: 10, external: 12 };
  const edgeColors: Record<string, string> = {
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
  const edgeDash: Record<string, string> = {
    contains: '4,3',
    'type-ref': '2,2',
    annotate: '1,3',
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>Java 代码图对象</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6fa; color: #2c3e50; height: 100vh; display: flex; flex-direction: column; }
  header { background: #2c3e50; color: #ecf0f1; padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 16px; font-weight: 500; }
  header .stats { font-size: 13px; opacity: 0.85; }
  header .filters { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
  header .filter { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; font-size: 11px; padding: 3px 7px; border-radius: 3px; background: rgba(255,255,255,0.1); }
  header .filter input { margin: 0; cursor: pointer; }
  header .filter.off { opacity: 0.35; }
  header .ntypes { display: flex; gap: 6px; padding-left: 8px; border-left: 1px solid rgba(255,255,255,0.2); }
  header .ntype { font-size: 11px; display: flex; align-items: center; gap: 3px; }
  .layout { flex: 1; display: flex; min-height: 0; }
  .sidebar { width: 280px; min-width: 200px; background: #fff; border-right: 1px solid #e0e3eb; display: flex; flex-direction: column; }
  .sidebar .search { padding: 8px; border-bottom: 1px solid #e0e3eb; }
  .sidebar .search input { width: 100%; padding: 6px 8px; font-size: 13px; border: 1px solid #d0d3db; border-radius: 3px; }
  .sidebar .search .actions { margin-top: 6px; display: flex; gap: 6px; }
  .sidebar .search .actions button { flex: 1; padding: 5px 8px; font-size: 12px; border: 1px solid #d0d3db; background: #fff; border-radius: 3px; cursor: pointer; color: #2c3e50; }
  .sidebar .search .actions button:hover { background: #f0f2f7; }
  .sidebar .search .actions button:disabled { opacity: 0.4; cursor: not-allowed; }
  .sidebar .search .dir { margin-top: 6px; display: flex; align-items: center; gap: 4px; font-size: 11px; color: #5a6473; }
  .sidebar .search .dir .dir-label { margin-right: 2px; }
  .sidebar .search .dir .dir-btn { flex: 1; padding: 4px 6px; font-size: 11px; border: 1px solid #d0d3db; background: #fff; border-radius: 3px; cursor: pointer; color: #2c3e50; }
  .sidebar .search .dir .dir-btn:hover { background: #f0f2f7; }
  .sidebar .search .dir .dir-btn.active { background: #2c3e50; color: #fff; border-color: #2c3e50; }
  .sidebar .list { flex: 1; overflow-y: auto; }
  .sidebar .item { padding: 6px 12px; cursor: pointer; border-bottom: 1px solid #f0f2f7; font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .sidebar .item:hover { background: #f5f6fa; }
  .sidebar .item.active { background: #e8f0fe; }
  .sidebar .item .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .sidebar .item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sidebar .item .badge { font-size: 10px; color: #7f8c8d; background: #eef0f4; padding: 1px 5px; border-radius: 8px; }
  .sidebar .item .expand { font-size: 10px; color: #2980b9; }
  .hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); color: #95a5a6; font-size: 14px; font-style: italic; text-align: center; pointer-events: none; }
  .hint .big { font-size: 16px; color: #7f8c8d; margin-bottom: 6px; }
  .main { flex: 1; display: flex; min-width: 0; }
  .graph { flex: 1; position: relative; background: #fafbfc; overflow: hidden; }
  .graph svg { width: 100%; height: 100%; cursor: grab; }
  .graph svg:active { cursor: grabbing; }
  .detail { width: 340px; min-width: 260px; background: #fff; border-left: 1px solid #e0e3eb; overflow-y: auto; padding: 14px; font-size: 13px; }
  .detail h2 { font-size: 15px; margin-bottom: 8px; word-break: break-all; }
  .detail .kind-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; color: #fff; margin-left: 6px; vertical-align: middle; }
  .detail section { margin-bottom: 14px; }
  .detail section h3 { font-size: 12px; color: #7f8c8d; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .detail .meta-line { color: #5a6473; margin-bottom: 3px; word-break: break-all; }
  .detail .meta-line code { background: #f0f2f7; padding: 1px 4px; border-radius: 2px; font-size: 12px; }
  .detail .rel { font-size: 12px; margin-bottom: 3px; }
  .detail .rel .arrow { color: #95a5a6; margin: 0 4px; }
  .empty { color: #95a5a6; font-style: italic; padding: 8px; }
</style>
</head>
<body>
<header>
  <h1>Java 代码图对象</h1>
  <div class="stats" id="stats"></div>
  <div class="ntypes" id="ntypes"></div>
  <div class="filters" id="filters"></div>
</header>
<div class="layout">
  <aside class="sidebar">
    <div class="search"><input id="search" placeholder="搜索节点…" />
      <div class="dir">
        <span class="dir-label">展开方向</span>
        <button class="dir-btn active" data-dir="both">出入</button>
        <button class="dir-btn" data-dir="out">仅出</button>
        <button class="dir-btn" data-dir="in">仅入</button>
      </div>
      <div class="actions"><button id="undoBtn" disabled>撤销展开</button></div>
    </div>
    <div class="list" id="nodeList"></div>
  </aside>
  <div class="main">
    <div class="graph"><svg id="svg"></svg></div>
    <aside class="detail" id="detail"><div class="empty">选择左侧节点以查看详情</div></aside>
  </div>
</div>
<script type="application/json" id="data">${jsonText}</script>
<script>
(function () {
  var graph = JSON.parse(document.getElementById('data').textContent);
  var nodeColors = ${JSON.stringify(nodeColors)};
  var nodeRadius = ${JSON.stringify(nodeRadius)};
  var edgeColors = ${JSON.stringify(edgeColors)};
  var edgeDash = ${JSON.stringify(edgeDash)};
  var eTypeLabel = {contains:'包含',inherit:'继承',implement:'实现',override:'重写','implement-method':'实现方法',call:'调用','field-access':'访问',instantiate:'实例化','type-ref':'类型引用',annotate:'注解'};
  var nTypeLabel = {class:'类',method:'方法',field:'字段',annotation:'注解',external:'外部'};

  document.getElementById('stats').textContent = '节点 ' + graph.nodes.length + ' · 边 ' + graph.edges.length;

  // 节点/边索引
  var nodeById = {}; graph.nodes.forEach(function(n){ nodeById[n.id] = n; });
  // 邻接表（双向，便于详情列出相关边）
  var outEdges = {}, inEdges = {};
  graph.edges.forEach(function(e){
    (outEdges[e.source] = outEdges[e.source] || []).push(e);
    (inEdges[e.target] = inEdges[e.target] || []).push(e);
  });

  // 节点类型过滤
  var activeNodeTypes = {class:true, method:true, field:true, annotation:true, external:true};
  var ntypesEl = document.getElementById('ntypes');
  ['class','method','field','annotation','external'].forEach(function(t){
    var el = document.createElement('label');
    el.className = 'ntype';
    el.innerHTML = '<input type="checkbox" checked data-nt="'+t+'"><span style="color:'+nodeColors[t]+'">●</span>'+nTypeLabel[t];
    el.firstChild.onchange = function(){ activeNodeTypes[t] = el.firstChild.checked; el.classList.toggle('off', !el.firstChild.checked); restart(); renderList(searchInput.value); };
    ntypesEl.appendChild(el);
  });

  // 边类型过滤
  var edgeTypes = ['contains','inherit','implement','override','implement-method','call','field-access','instantiate','type-ref','annotate'];
  var activeEdges = {}; edgeTypes.forEach(function(t){ activeEdges[t] = true; });
  var filtersEl = document.getElementById('filters');
  edgeTypes.forEach(function(t){
    var el = document.createElement('label');
    el.className = 'filter';
    el.innerHTML = '<input type="checkbox" checked data-et="'+t+'"><span style="color:'+edgeColors[t]+'">'+(edgeDash[t]?'◸':'●')+'</span>'+eTypeLabel[t];
    el.firstChild.onchange = function(){ activeEdges[t] = el.firstChild.checked; el.classList.toggle('off', !el.firstChild.checked); restart(); };
    filtersEl.appendChild(el);
  });

  // 左栏节点列表
  var nodeListEl = document.getElementById('nodeList');
  var searchInput = document.getElementById('search');
  var selectedId = null;
  var listCleared = false;   // 选中搜索候选项后置为 true，列表不再显示任何节点；用户重新输入时复位
  function renderList(filter) {
    nodeListEl.innerHTML = '';
    if (listCleared) return;  // 列表已清空，不展示任何节点
    filter = (filter || '').toLowerCase();
    if (!filter) {
      var tip = document.createElement('div');
      tip.className = 'empty';
      tip.style.padding = '12px';
      tip.textContent = '输入关键词以搜索节点';
      nodeListEl.appendChild(tip);
      return;
    }
    var count = 0;
    graph.nodes.forEach(function(n){
      if (!activeNodeTypes[n.type]) return;
      if (n.id.toLowerCase().indexOf(filter)< 0 && n.label.toLowerCase().indexOf(filter) < 0) return;
      var item = document.createElement('div');
      item.className = 'item' + (n.id === selectedId ? ' active' : '');
      item.innerHTML = '<span class="dot" style="background:'+nodeColors[n.type]+'"></span>' +
                       '<span class="name">' + escapeHtml(n.label) + '</span>' +
                       '<span class="badge">' + nTypeLabel[n.type] + '</span>' +
                       '<span class="expand">重置</span>';
      item.title = n.id + '（点击重置画布至该节点）';
      item.onclick = function(){ listCleared = true; resetToNode(n.id); };
      nodeListEl.appendChild(item);
      count++;
    });
    if (count === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.padding = '12px';
      empty.textContent = '无匹配节点';
      nodeListEl.appendChild(empty);
    }
  }
  searchInput.oninput = function(){ listCleared = false; renderList(searchInput.value); };
  renderList('');

  // 详情面板
  var detailEl = document.getElementById('detail');
  function selectNode(id) {
    selectedId = id;
    renderList(searchInput.value);
    var activeEl = nodeListEl.querySelector('.item.active');
    if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    var n = nodeById[id];
    if (!n) { detailEl.innerHTML = '<div class="empty">无此节点</div>'; return; }
    var html = '<h2>' + escapeHtml(n.label) + '<span class="kind-badge" style="background:'+nodeColors[n.type]+'">' + nTypeLabel[n.type] + '</span></h2>';
    html += '<section><h3>元信息</h3>';
    html += '<div class="meta-line">ID: <code>' + escapeHtml(n.id) + '</code></div>';
    html += '<div class="meta-line">类型: <code>' + nTypeLabel[n.type] + '</code></div>';
    if (n.classFqn && n.classFqn !== n.id) html += '<div class="meta-line">所属类: <code>' + escapeHtml(n.classFqn) + '</code></div>';
    if (n.type === 'external') html += '<div class="meta-line">来源: <code>外部依赖（非源码）</code></div>';
    if (n.kind) html += '<div class="meta-line">类种: <code>' + n.kind + '</code></div>';
    if (n.dataType) html += '<div class="meta-line">数据类型: <code>' + escapeHtml(n.dataType) + '</code></div>';
    if (n.isConstructor) html += '<div class="meta-line">构造器: 是</div>';
    if (n.parameters && n.parameters.length) {
      html += '<div class="meta-line">参数: ' + n.parameters.map(function(p){return '<code>'+escapeHtml(p.type)+'</code> '+escapeHtml(p.name);}).join(', ') + '</div>';
    }
    if (n.modifiers && n.modifiers.length) html += '<div class="meta-line">修饰: ' + n.modifiers.map(function(m){return '<code>'+escapeHtml(m)+'</code>';}).join(' ') + '</div>';
    if (n.filePath) html += '<div class="meta-line">文件: <code>' + escapeHtml(n.filePath) + '</code></div>';
    if (n.startIndex != null) html += '<div class="meta-line">位置: <code>[' + n.startIndex + ',' + (n.endIndex != null ? n.endIndex : n.startIndex) + ')</code></div>';
    html += '</section>';

    // 注解：annotation 节点展示自身参数；class/method/field 节点展示其注解列表
    if (n.type === 'annotation') {
      var a = (n.annotations && n.annotations[0]) || null;
      if (a) {
        html += '<section><h3>注解参数</h3>';
        html += '<div class="meta-line">@' + escapeHtml(a.name) + (a.arguments ? '(' + escapeHtml(a.arguments) + ')' : '') + '</div>';
        html += '</section>';
      }
    } else if (n.annotations && n.annotations.length) {
      html += '<section><h3>注解 (' + n.annotations.length + ')</h3>';
      n.annotations.forEach(function(a){
        html += '<div class="meta-line">@' + escapeHtml(a.name) + (a.arguments ? '(' + escapeHtml(a.arguments) + ')' : '') + '</div>';
      });
      html += '</section>';
    }

    // 出边
    var outs = (outEdges[id] || []).filter(function(e){ return activeEdges[e.type]; });
    if (outs.length) {
      html += '<section><h3>出边 (' + outs.length + ')</h3>';
      outs.forEach(function(e){
        var t = nodeById[e.target];
        html += '<div class="rel"><span style="color:'+edgeColors[e.type]+'">'+eTypeLabel[e.type]+'</span> <span class="arrow">→</span> ' + escapeHtml(t ? t.label : e.target) + '</div>';
      });
      html += '</section>';
    }
    // 入边
    var ins = (inEdges[id] || []).filter(function(e){ return activeEdges[e.type]; });
    if (ins.length) {
      html += '<section><h3>入边 (' + ins.length + ')</h3>';
      ins.forEach(function(e){
        var s = nodeById[e.source];
        html += '<div class="rel">' + escapeHtml(s ? s.label : e.source) + ' <span class="arrow">—'+eTypeLabel[e.type]+'→</span></div>';
      });
      html += '</section>';
    }
    detailEl.innerHTML = html;
    highlightNode = id;
  }

  function escapeHtml(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  // 力导向 —— 仅渲染已展开集合
  var svg = document.getElementById('svg');
  var width = svg.clientWidth || 800;
  var height = svg.clientHeight || 600;

  // 所有节点的布局状态（坐标），但只在 expanded 集合中才参与模拟与渲染
  var layout = {};
  graph.nodes.forEach(function(n){
    layout[n.id] = { id: n.id, label: n.label, type: n.type, x: width/2 + (Math.random()-0.5)*200, y: height/2 + (Math.random()-0.5)*200, vx:0, vy:0 };
  });
  var expanded = {};   // 已展开节点 id 集合
  var hintEl = document.createElement('div');
  hintEl.className = 'hint';
  hintEl.innerHTML = '<div class="big">画布空空如也</div>请在左侧搜索并点击节点，以展开其一度关系<br/>双击画布节点可继续追加展开';
  svg.parentElement.appendChild(hintEl);

  function visibleEdges(){
    return graph.edges.filter(function(e){
      if (!activeEdges[e.type] || !expanded[e.source] || !expanded[e.target]) return false;
      var s = nodeById[e.source], t = nodeById[e.target];
      if (!s || !t) return false;
      return activeNodeTypes[s.type] && activeNodeTypes[t.type];
    });
  }

  var expandMode = 'both'; // both | out | in
  var dirBtns = document.querySelectorAll('.dir-btn');
  dirBtns.forEach(function(btn){
    btn.onclick = function(){
      dirBtns.forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      expandMode = btn.getAttribute('data-dir');
    };
  });

  function getNeighbors(id) {
    var set = {};
    if (expandMode === 'out' || expandMode === 'both') {
      (outEdges[id] || []).forEach(function(e){ set[e.target] = true; });
    }
    if (expandMode === 'in' || expandMode === 'both') {
      (inEdges[id] || []).forEach(function(e){ set[e.source] = true; });
    }
    return Object.keys(set);
  }

  function resetToNode(id) {
    var n = nodeById[id];
    if (!n) return;
    Object.keys(expanded).forEach(function(k){ delete expanded[k]; });
    historyStack.length = 0;
    var toAdd = [id];
    getNeighbors(id).forEach(function(nid){
      if (!expanded[nid]) toAdd.push(nid);
    });
    toAdd.forEach(function(i){ expanded[i] = true; });
    historyStack.push(toAdd);
    hintEl.style.display = 'none';
    updateUndoBtn();
    selectNode(id);
  }
  function expandNode(id) {
    var n = nodeById[id];
    if (!n) return;
    // 收集本次新增的节点：id 自身 + 依当前方向的一度邻居中尚未展开者
    var toAdd = [];
    if (!expanded[id]) toAdd.push(id);
    getNeighbors(id).forEach(function(nid){
      if (!expanded[nid]) toAdd.push(nid);
    });
    if (toAdd.length) {
      toAdd.forEach(function(i){ expanded[i] = true; });
      historyStack.push(toAdd);
      hintEl.style.display = 'none';
    }
    updateUndoBtn();
    selectNode(id);
  }

  var historyStack = [];
  var undoBtn = document.getElementById('undoBtn');
  function updateUndoBtn(){ undoBtn.disabled = historyStack.length === 0; }
  undoBtn.onclick = function(){
    if (!historyStack.length) return;
    var last = historyStack.pop();
    last.forEach(function(id){ delete expanded[id]; });
    updateUndoBtn();
    // 若展开集合空了，恢复提示
    var hasAny = false;
    for (var k in expanded) { hasAny = true; break; }
    if (!hasAny) hintEl.style.display = '';
    // 若当前高亮节点已被移除，清空高亮与详情
    if (highlightNode && !expanded[highlightNode]) {
      highlightNode = null;
      selectedId = null;
      detailEl.innerHTML = '<div class="empty">选择左侧节点以查看详情</div>';
      renderList(searchInput.value);
    }
  };
  updateUndoBtn();

  // 画布事件：轻点=选中(详情)，连续两次轻点(间隔<350ms)=展开一度关系
  // 因 tick() 每帧重建 SVG 子树，原生 dblclick 在 DOM 实例更迭下不可靠，故自行以 mousedown 间隔判定
  var dragNode = null, dragOff = {x:0,y:0}, highlightNode = null, dragMoved = false, downPos = null, downId = null, downTime = 0;
  var lastDownId = null, lastDownTime = 0;
  svg.addEventListener('mousedown', function(e){
    var fqn = e.target.getAttribute('data-id');
    if (fqn && layout[fqn] && expanded[fqn]) {
      var now = Date.now();
      // 双击判定：同一节点、两次 mousedown 间隔 < 350ms、且未发生拖拽
      if (lastDownId === fqn && now - lastDownTime < 350) {
        expandNode(fqn);              // 从全图邻接表取该节点一度关系，出/入受 expandMode 控制
        lastDownId = null; lastDownTime = 0;
        dragNode = null; downPos = null; downId = null;  // 阻止后续 mouseup 触发重复 selectNode
        return;
      }
      lastDownId = fqn; lastDownTime = now;
      dragNode = layout[fqn]; dragOff = {x: e.offsetX - dragNode.x, y: e.offsetY - dragNode.y}; downPos = {x: e.offsetX, y: e.offsetY}; dragMoved = false; downId = fqn; downTime = now;
    }
  });
  svg.addEventListener('mousemove', function(e){
    if (dragNode) {
      if (downPos && (Math.abs(e.offsetX - downPos.x) > 3 || Math.abs(e.offsetY - downPos.y) > 3)) dragMoved = true;
      if (dragMoved) { dragNode.x = e.offsetX - dragOff.x; dragNode.y = e.offsetY - dragOff.y; dragNode.vx=0; dragNode.vy=0; }
    }
  });
  window.addEventListener('mouseup', function(){
    if (!dragMoved && downId && Date.now() - downTime< 500) selectNode(downId);
    // 若发生拖拽，取消双击判定窗口（拖拽不算单击，不应衔接双击）
    if (dragMoved) { lastDownId = null; lastDownTime = 0; }
    dragNode = null; downPos = null; downId = null;
  });

  function tick() {
    var vis = visibleEdges();
    var activeIds = Object.keys(expanded);
    // 斥力（仅展开节点之间）
    for (var i=0;i<activeIds.length;i++){
      var n = layout[activeIds[i]];
      if (!n || !activeNodeTypes[n.type]) continue;
      for (var j=i+1;j<activeIds.length;j++){
        var m = layout[activeIds[j]];
        if (!m || !activeNodeTypes[m.type]) continue;
        var dx = n.x - m.x, dy = n.y - m.y;
        var d2 = dx*dx + dy*dy; if (d2<1) d2=1;
        var d = Math.sqrt(d2);
        var f = 9000 / d2;
        n.vx += (dx/d) * f; n.vy += (dy/d) * f;
        m.vx -= (dx/d) * f; m.vy -= (dy/d) * f;
      }
    }
    vis.forEach(function(e){
      var a = layout[e.source], b = layout[e.target];
      if (!a || !b) return;
      var dx = b.x - a.x, dy = b.y - a.y;
      var d = Math.sqrt(dx*dx + dy*dy) || 1;
      var rest = e.type === 'contains' ? 60 : 150;
      var k = e.type === 'contains' ? 0.05 : 0.015;
      var f = (d - rest) * k;
      a.vx += (dx/d) * f; a.vy += (dy/d) * f;
      b.vx -= (dx/d) * f; b.vy -= (dy/d) * f;
    });
    activeIds.forEach(function(id){
      var n = layout[id];
      if (!n || n === dragNode || !activeNodeTypes[n.type]) return;
      n.vx += (width/2 - n.x) * 0.002;
      n.vy += (height/2 - n.y) * 0.002;
      n.x += n.vx *= 0.85; n.y += n.vy *= 0.85;
      n.x = Math.max(30, Math.min(width-30, n.x));
      n.y = Math.max(20, Math.min(height-20, n.y));
    });
    restart();
    requestAnimationFrame(tick);
  }

  function restart() {
    var parts = ['<defs>'];
    Object.keys(edgeColors).forEach(function(t){
      parts.push('<marker id="arr-'+t+'" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="'+edgeColors[t]+'"/></marker>');
    });
    parts.push('</defs>');
    visibleEdges().forEach(function(e){
      var a = layout[e.source], b = layout[e.target];
      if (!a || !b) return;
      var r = nodeRadius[a.type] || 12;
      var r2 = nodeRadius[b.type] || 12;
      var dx = b.x - a.x, dy = b.y - a.y;
      var d = Math.sqrt(dx*dx+dy*dy) || 1;
      var x1 = a.x + (dx/d)*r, y1 = a.y + (dy/d)*r;
      var x2 = b.x - (dx/d)*r2, y2 = b.y - (dy/d)*r2;
      var dash = edgeDash[e.type] ? 'stroke-dasharray="'+edgeDash[e.type]+'" ' : '';
      parts.push('<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="'+edgeColors[e.type]+'" stroke-width="1.4" '+dash+'marker-end="url(#arr-'+e.type+')" />');
    });
    Object.keys(expanded).forEach(function(id){
      var n = layout[id];
      if (!n || !activeNodeTypes[n.type]) return;
      var r = nodeRadius[n.type] || 12;
      parts.push('<circle cx="'+n.x+'" cy="'+n.y+'" r="'+r+'" fill="'+(nodeColors[n.type]||'#888')+'" stroke="#fff" stroke-width="2" data-id="'+n.id+'" style="cursor:pointer;"/>');
      parts.push('<text x="'+n.x+'" y="'+(n.y+r+12)+'" text-anchor="middle" font-size="10" fill="#2c3e50" data-id="'+n.id+'" style="pointer-events:none;">'+escapeHtml(n.label)+'</text>');
    });
    svg.innerHTML = parts.join('');
  }

  window.addEventListener('resize', function(){ width = svg.clientWidth; height = svg.clientHeight; });
  tick();
})();
</script>
</body>
</html>`;
}
