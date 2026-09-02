import * as path from 'path';
import type { ParseResult, ClassInfo } from '../model/types';

/**
 * 将 ParseResult 渲染为自包含的 HTML 可视化页面。
 *
 * 设计：
 *  - 左栏：类列表（可搜索、可点击）
 *  - 右栏：类详情（元信息、注解、注释、字段、方法、相关关系）
 *  - 中央：SVG 关系图（手写力导向，节点可拖拽，边按关系类型着色）
 *  - 顶部：统计与关系类型过滤
 *
 * 页面自包含：CSS+JS 全部内联，JSON 数据内嵌为 <script type="application/json">。
 */
export function renderHtmlReport(result: ParseResult): string {
  // 内嵌 JSON：转义 </script> 以防 XSS 式中断
  const jsonText = JSON.stringify(result).replace(/<\/script>/g, '<\\/script>');

  const nodeColors: Record<string, string> = {
    class: '#4a90e2',
    interface: '#27ae60',
    enum: '#e67e22',
    record: '#8e44ad',
  };
  const edgeColors: Record<string, string> = {
    inherit: '#e74c3c',
    implement: '#2980b9',
    call: '#27ae60',
    'field-access': '#f39c12',
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>Java 代码关系图谱</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6fa; color: #2c3e50; height: 100vh; display: flex; flex-direction: column; }
  header { background: #2c3e50; color: #ecf0f1; padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 16px; font-weight: 500; }
  header .stats { font-size: 13px; opacity: 0.85; }
  header .filters { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; }
  header .filter { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; font-size: 12px; padding: 3px 8px; border-radius: 3px; background: rgba(255,255,255,0.1); }
  header .filter input { margin: 0; cursor: pointer; }
  header .filter.off { opacity: 0.4; }
  .layout { flex: 1; display: flex; min-height: 0; }
  .sidebar { width: 280px; min-width: 200px; background: #fff; border-right: 1px solid #e0e3eb; display: flex; flex-direction: column; }
  .sidebar .search { padding: 8px; border-bottom: 1px solid #e0e3eb; }
  .sidebar .search input { width: 100%; padding: 6px 8px; font-size: 13px; border: 1px solid #d0d3db; border-radius: 3px; }
  .sidebar .list { flex: 1; overflow-y: auto; }
  .sidebar .item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f0f2f7; font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .sidebar .item:hover { background: #f5f6fa; }
  .sidebar .item.active { background: #e8f0fe; }
  .sidebar .item .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .sidebar .item .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .detail .ann { background: #fff8e1; border-left: 3px solid #f39c12; padding: 4px 8px; margin-bottom: 4px; font-size: 12px; }
  .detail .cmt { background: #f1f8e9; border-left: 3px solid #7cb342; padding: 4px 8px; margin-bottom: 4px; font-size: 12px; white-space: pre-wrap; }
  .detail table { width: 100%; border-collapse: collapse; }
  .detail td { padding: 4px 6px; border-bottom: 1px solid #eef0f4; vertical-align: top; }
  .detail td.name { color: #2c3e50; font-weight: 500; }
  .detail td.type { color: #8e44ad; font-family: Consolas, monospace; font-size: 12px; }
  .detail .rel { font-size: 12px; margin-bottom: 3px; }
  .detail .rel .arrow { color: #95a5a6; margin: 0 4px; }
  .detail .rel.call { color: #27ae60; }
  .detail .rel.inherit { color: #e74c3c; }
  .detail .rel.implement { color: #2980b9; }
  .detail .rel\\[class~=field-access\\] { color: #f39c12; }
  .empty { color: #95a5a6; font-style: italic; padding: 8px; }
  .unresolved { border-top: 1px solid #e0e3eb; max-height: 40%; display: flex; flex-direction: column; }
  .unresolved .uhd { padding: 8px 12px; cursor: pointer; background: #fff5f5; font-size: 12px; color: #c0392b; user-select: none; display: flex; justify-content: space-between; }
  .unresolved .ulist { overflow-y: auto; display: none; }
  .unresolved.open .ulist { display: block; }
  .unresolved .uitem { padding: 6px 12px; border-bottom: 1px solid #f0e0e0; font-size: 12px; }
  .unresolved .uitem .sym { font-weight: 600; color: #c0392b; font-family: Consolas, monospace; }
  .unresolved .uitem .kind { color: #7f8c8d; font-size: 11px; margin-left: 6px; }
  .unresolved .uitem .loc { color: #5a6473; font-size: 11px; margin-top: 2px; word-break: break-all; }
  .unresolved .uitem .loc code { background: #f0f2f7; padding: 1px 4px; border-radius: 2px; font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>Java 代码关系图谱</h1>
  <div class="stats" id="stats"></div>
  <div class="filters" id="filters"></div>
</header>
<div class="layout">
  <aside class="sidebar">
    <div class="search"><input id="search" placeholder="搜索类名…" /></div>
    <div class="list" id="classList"></div>
    <div class="unresolved" id="unresolvedBox">
      <div class="uhd" id="unresolvedHd"><span>未决符号</span><span id="unresolvedCount"></span></div>
      <div class="ulist" id="unresolvedList"></div>
    </div>
  </aside>
  <div class="main">
    <div class="graph"><svg id="svg"></svg></div>
    <aside class="detail" id="detail"><div class="empty">选择左侧类以查看详情</div></aside>
  </div>
</div>
<script type="application/json" id="data">${jsonText}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var nodeColors = ${JSON.stringify(nodeColors)};
  var edgeColors = ${JSON.stringify(edgeColors)};

  // ---- 统计与过滤 ----
  var stats = document.getElementById('stats');
  var relTypes = ['inherit','implement','call','field-access'];
  var activeTypes = {}; relTypes.forEach(function(t){ activeTypes[t] = true; });
  stats.textContent = '类 ' + data.classes.length + ' · 关系 ' + data.relations.length + ' · 未决 ' + data.unresolvedSymbols.length;

  // ---- 未决符号列表 ----
  var unresolvedBox = document.getElementById('unresolvedBox');
  var unresolvedHd = document.getElementById('unresolvedHd');
  var unresolvedCount = document.getElementById('unresolvedCount');
  var unresolvedList = document.getElementById('unresolvedList');
  unresolvedCount.textContent = data.unresolvedSymbols.length;
  unresolvedHd.onclick = function(){ unresolvedBox.classList.toggle('open'); };
  (data.unresolvedSymbols || []).forEach(function(u){
    var item = document.createElement('div');
    item.className = 'uitem';
    var loc = '';
    if (u.file) loc += '<div class="loc">文件: <code>' + escapeHtml(u.file) + '</code></div>';
    if (u.startIndex != null) loc += '<div class="loc">位置: <code>[' + u.startIndex + ',' + (u.endIndex != null ? u.endIndex : u.startIndex) + ')</code></div>';
    if (u.contextClass) loc += '<div class="loc">上下文: <code>' + escapeHtml(u.contextClass) + (u.contextMember ? '.' + escapeHtml(u.contextMember) : '') + '</code></div>';
    item.innerHTML = '<div><span class="sym">' + escapeHtml(u.symbol) + '</span><span class="kind">' + escapeHtml(u.kind) + '</span></div>' + loc;
    unresolvedList.appendChild(item);
  });

  // ---- 类索引 ----
  var classes = data.classes;
  var classByFqn = {};
  classes.forEach(function(c){ classByFqn[c.fqn] = c; });

  // ---- 左栏类列表 ----
  var classListEl = document.getElementById('classList');
  var searchInput = document.getElementById('search');
  var selectedFqn = null;

  function renderList(filter) {
    filter = (filter || '').toLowerCase();
    classListEl.innerHTML = '';
    classes.forEach(function(c) {
      if (filter && c.fqn.toLowerCase().indexOf(filter)< 0 && c.simpleName.toLowerCase().indexOf(filter)< 0) return;
      var item = document.createElement('div');
      item.className = 'item' + (c.fqn === selectedFqn ? ' active' : '');
      item.innerHTML = '<span class="dot" style="background:' + (nodeColors[c.kind] || '#888') + '"></span>' +
                       '<span class="name">' + escapeHtml(c.simpleName) + '</span>';
      item.title = c.fqn;
      item.onclick = function(){ selectClass(c.fqn); };
      classListEl.appendChild(item);
    });
  }
  searchInput.oninput = function(){ renderList(searchInput.value); };
  renderList();

  // ---- 详情面板 ----
  var detailEl = document.getElementById('detail');
  function selectClass(fqn) {
    selectedFqn = fqn;
    renderList(searchInput.value);
    var c = classByFqn[fqn];
    if (!c) { detailEl.innerHTML = '<div class="empty">无此类</div>'; return; }
    var html = '<h2>' + escapeHtml(c.simpleName) + '<span class="kind-badge" style="background:' + (nodeColors[c.kind]||'#888') + '">' + c.kind + '</span></h2>';
    html += '<section><h3>元信息</h3>';
    html += '<div class="meta-line">FQN: <code>' + escapeHtml(c.fqn) + '</code></div>';
    html += '<div class="meta-line">文件: <code>' + escapeHtml(c.filePath) + '</code></div>';
    if (c.package) html += '<div class="meta-line">包: <code>' + escapeHtml(c.package) + '</code></div>';
    if (c.superClass) html += '<div class="meta-line">父类: <code>' + escapeHtml(c.superClass) + '</code></div>';
    if (c.interfaces && c.interfaces.length) html += '<div class="meta-line">实现: <code>' + escapeHtml(c.interfaces.join(', ')) + '</code></div>';
    if (c.modifiers && c.modifiers.length) html += '<div class="meta-line">修饰: ' + c.modifiers.map(function(m){return '<code>'+escapeHtml(m)+'</code>';}).join(' ') + '</div>';
    html += '</section>';

    if (c.annotations && c.annotations.length) {
      html += '<section><h3>注解</h3>';
      c.annotations.forEach(function(a){
        html += '<div class="ann">@' + escapeHtml(a.name) + (a.arguments ? '(' + escapeHtml(a.arguments) + ')' : '') + '</div>';
      });
      html += '</section>';
    }
    if (c.comments && c.comments.length) {
      html += '<section><h3>注释</h3>';
      c.comments.forEach(function(cm){
        html += '<div class="cmt">' + escapeHtml(cm.text) + '</div>';
      });
      html += '</section>';
    }
    if (c.fields && c.fields.length) {
      html += '<section><h3>属性 (' + c.fields.length + ')</h3><table>';
      c.fields.forEach(function(f){
        html += '<tr><td class="name">' + escapeHtml(f.name) + '</td><td class="type">' + escapeHtml(f.type) + '</td></tr>';
      });
      html += '</table></section>';
    }
    if (c.methods && c.methods.length) {
      html += '<section><h3>方法 (' + c.methods.length + ')</h3><table>';
      c.methods.forEach(function(m){
        var sig = (m.returnType ? escapeHtml(m.returnType) + ' ' : '') + '<b>' + escapeHtml(m.name) + '</b>(' + m.parameters.map(function(p){return escapeHtml(p.type)+' '+escapeHtml(p.name);}).join(', ') + ')';
        html += '<tr><td class="name">' + sig + '</td></tr>';
      });
      html += '</table></section>';
    }

    // 相关关系
    var related = data.relations.filter(function(r){ return r.source.class === fqn || r.target.class === fqn; });
    if (related.length) {
      html += '<section><h3>相关关系 (' + related.length + ')</h3>';
      related.forEach(function(r){
        var dir = (r.source.class === fqn ? 'out' : 'in');
        var cls = r.type;
        var txt = '<div class="rel ' + r.type + '">';
        if (dir === 'out') {
          txt += escapeHtml(r.source.member||'') + ' <span class="arrow">—'+rType(r.type)+'→</span> ' + escapeHtml(shortName(r.target.class)) + (r.target.member?'.'+escapeHtml(r.target.member):'');
        } else {
          txt += escapeHtml(shortName(r.source.class)) + (r.source.member?'.'+escapeHtml(r.source.member):'') + ' <span class="arrow">—'+rType(r.type)+'→</span> ' + escapeHtml(r.target.member||'');
        }
        txt += '</div>';
        html += txt;
      });
      html += '</section>';
    }
    detailEl.innerHTML = html;

    // 图中高亮
    highlightNode = fqn;
  }

  function shortName(fqn){ var i = fqn.lastIndexOf('.'); return i<0 ? fqn : fqn.slice(i+1); }
  function rType(t){ return {inherit:'继承',implement:'实现',call:'调用','field-access':'访问'}[t] || t; }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  // ---- 力导向关系图 ----
  var svg = document.getElementById('svg');
  var width = svg.clientWidth || 800;
  var height = svg.clientHeight || 600;
  var nodes = classes.map(function(c){
    return { fqn: c.fqn, label: c.simpleName, kind: c.kind, x: width/2 + (Math.random()-0.5)*200, y: height/2 + (Math.random()-0.5)*200, vx:0, vy:0 };
  });
  var nodeMap = {}; nodes.forEach(function(n){ nodeMap[n.fqn] = n; });
  var edges = data.relations.filter(function(r){ return nodeMap[r.source.class] && nodeMap[r.target.class]; }).map(function(r){
    return { source: r.source.class, target: r.target.class, type: r.type };
  });

  // 过滤控件
  var filtersEl = document.getElementById('filters');
  relTypes.forEach(function(t){
    var el = document.createElement('label');
    el.className = 'filter';
    el.innerHTML = '<input type="checkbox" checked data-type="'+t+'"><span style="color:'+edgeColors[t]+'">●</span>'+rType(t);
    el.firstChild.onchange = function(){ activeTypes[t] = el.firstChild.checked; el.classList.toggle('off', !el.firstChild.checked); restart(); };
    filtersEl.appendChild(el);
  });

  function visibleEdges(){ return edges.filter(function(e){ return activeTypes[e.type]; }); }

  var dragNode = null, dragOff = {x:0,y:0}, highlightNode = null;

  svg.addEventListener('mousedown', function(e){
    if (e.target.tagName === 'circle' || e.target.tagName === 'text') {
      var fqn = e.target.getAttribute('data-fqn');
      if (fqn) { dragNode = nodeMap[fqn]; dragOff = {x: e.offsetX - dragNode.x, y: e.offsetY - dragNode.y}; }
    }
  });
  svg.addEventListener('mousemove', function(e){
    if (dragNode) { dragNode.x = e.offsetX - dragOff.x; dragNode.y = e.offsetY - dragOff.y; dragNode.vx=0; dragNode.vy=0; }
  });
  window.addEventListener('mouseup', function(){ dragNode = null; });
  svg.addEventListener('click', function(e){
    var fqn = e.target.getAttribute('data-fqn');
    if (fqn && !dragNode) selectClass(fqn);
  });

  function tick() {
    // 简易力导向：斥力 + 边吸力 + 居中
    var vis = visibleEdges();
    for (var i=0;i<nodes.length;i++){
      var n = nodes[i];
      for (var j=0;j<nodes.length;j++){
        if (i===j) continue;
        var m = nodes[j];
        var dx = n.x - m.x, dy = n.y - m.y;
        var d2 = dx*dx + dy*dy;
        if (d2 < 1) d2 = 1;
        var f = 8000 / d2;
        var d = Math.sqrt(d2);
        n.vx += (dx/d) * f;
        n.vy += (dy/d) * f;
      }
    }
    vis.forEach(function(e){
      var a = nodeMap[e.source], b = nodeMap[e.target];
      var dx = b.x - a.x, dy = b.y - a.y;
      var d = Math.sqrt(dx*dx + dy*dy) || 1;
      var f = (d - 140) * 0.02;
      a.vx += (dx/d) * f; a.vy += (dy/d) * f;
      b.vx -= (dx/d) * f; b.vy -= (dy/d) * f;
    });
    nodes.forEach(function(n){
      if (n === dragNode) return;
      n.vx += (width/2 - n.x) * 0.002;
      n.vy += (height/2 - n.y) * 0.002;
      n.x += n.vx *= 0.85;
      n.y += n.vy *= 0.85;
      n.x = Math.max(30, Math.min(width-30, n.x));
      n.y = Math.max(20, Math.min(height-20, n.y));
    });
    restart();
    requestAnimationFrame(tick);
  }

  function restart() {
    var parts = [];
    parts.push('<defs>');
    Object.keys(edgeColors).forEach(function(t){
      parts.push('<marker id="arr-'+t+'" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="'+edgeColors[t]+'"/></marker>');
    });
    parts.push('</defs>');
    visibleEdges().forEach(function(e){
      var a = nodeMap[e.source], b = nodeMap[e.target];
      var dx = b.x - a.x, dy = b.y - a.y;
      var d = Math.sqrt(dx*dx+dy*dy) || 1;
      var r = 16;
      var x1 = a.x + (dx/d)*r, y1 = a.y + (dy/d)*r;
      var x2 = b.x - (dx/d)*r, y2 = b.y - (dy/d)*r;
      var cls = (highlightNode && (e.source===highlightNode || e.target===highlightNode)) ? '' : 'opacity:0.35;';
      parts.push('<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="'+edgeColors[e.type]+'" stroke-width="1.4" marker-end="url(#arr-'+e.type+')" style="'+cls+'"/>');
    });
    nodes.forEach(function(n){
      var dim = (highlightNode && highlightNode !== n.fqn) ? 'opacity:0.4;' : '';
      var stroke = (highlightNode === n.fqn) ? '#000' : '#fff';
      parts.push('<circle cx="'+n.x+'" cy="'+n.y+'" r="16" fill="'+(nodeColors[n.kind]||'#888')+'" stroke="'+stroke+'" stroke-width="2" data-fqn="'+n.fqn+'" style="cursor:pointer;'+dim+'"/>');
      parts.push('<text x="'+n.x+'" y="'+(n.y+26)+'" text-anchor="middle" font-size="11" fill="#2c3e50" data-fqn="'+n.fqn+'" style="pointer-events:none;'+dim+'">'+escapeHtml(n.label)+'</text>');
    });
    svg.innerHTML = parts.join('');
  }

  window.addEventListener('resize', function(){ width = svg.clientWidth; height = svg.clientHeight; });
  selectClass(classes[0] ? classes[0].fqn : null);
  tick();
})();
</script>
</body>
</html>`;
}

/**
 * 便利：从 ParseResult 生成 HTML 并写入指定路径。
 */
export function buildHtmlReportPath(jsonPath: string): string {
  const dir = path.dirname(jsonPath);
  const base = path.basename(jsonPath, path.extname(jsonPath));
  return path.join(dir, base + '.html');
}
