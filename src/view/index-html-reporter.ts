/**
 * 首页入口渲染器。
 *
 * 生成一个自包含的 HTML 首页，作为各可视化报告的统一入口。
 * 设计为"页面描述列表"驱动：调用方传入需要展示的页面清单，
 * 渲染器据此生成卡片式导航。日后新增界面只需在调用处追加一条
 * IndexPageLink，无需改动本文件。
 *
 * 自包含 HTML，无外部依赖。
 */

export interface IndexPageLink {
  /** 唯一键，用于无障碍 aria-label 等 */
  key: string;
  /** 卡片标题 */
  title: string;
  /** 一句话描述该页面所展示的内容 */
  description: string;
  /** 相对 href（通常为同目录另一输出文件名） */
  href: string;
  /** 强调色（十六进制），用于卡片左侧色条与图标底色 */
  accent?: string;
  /** 卡片图标，内联 SVG path 的 d 值（24x24 viewBox）；留空则显示首字徽标 */
  iconPath?: string;
  /** 若该页未生成则置灰不可点击 */
  disabled?: boolean;
}

export interface IndexStatsEntry {
  label: string;
  value: number | string;
}

export interface IndexHtmlOptions {
  /** 页面标题，默认"代码可视化总览" */
  title?: string;
  /** 顶部统计指标 */
  stats?: IndexStatsEntry[];
}

const DEFAULT_ACCENT = '#4a90e2';

/**
 * 渲染首页 HTML。
 *
 * @param links  页面卡片列表
 * @param opts   可选标题与统计指标
 */
export function renderIndexHtml(links: IndexPageLink[], opts: IndexHtmlOptions = {}): string {
  const title = opts.title ?? '代码可视化总览';
  const stats = opts.stats ?? [];

  const cardsHtml = links.map((p) => renderCard(p)).join('\n');

  const statsHtml = stats.length
    ? `<section class="stats">${stats
        .map(
          (s) => `<div class="stat"><span class="stat-value">${escapeHtml(String(s.value))}</span><span class="stat-label">${escapeHtml(s.label)}</span></div>`,
        )
        .join('')}</section>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f6fa; color: #2c3e50; min-height: 100vh; display: flex; flex-direction: column; }
  header { background: #2c3e50; color: #ecf0f1; padding: 28px 32px; }
  header h1 { font-size: 22px; font-weight: 600; }
  header p { margin-top: 6px; font-size: 13px; opacity: 0.75; }
  main { flex: 1; padding: 32px; max-width: 1080px; width: 100%; margin: 0 auto; }
  .stats { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 28px; }
  .stat { background: #fff; border: 1px solid #e0e3eb; border-radius: 6px; padding: 14px 20px; min-width: 120px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .stat-value { display: block; font-size: 22px; font-weight: 600; color: #2c3e50; }
  .stat-label { display: block; margin-top: 4px; font-size: 12px; color: #7f8c8d; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; }
  .card { position: relative; display: flex; flex-direction: column; background: #fff; border: 1px solid #e0e3eb; border-radius: 8px; padding: 22px 22px 22px 26px; text-decoration: none; color: inherit; transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; overflow: hidden; }
  .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: var(--accent, ${DEFAULT_ACCENT}); }
  .card:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.08); border-color: #c5cad6; }
  .card.disabled { opacity: 0.5; pointer-events: none; cursor: not-allowed; }
  .card-head { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
  .card-icon { width: 40px; height: 40px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0; font-size: 18px; font-weight: 600; }
  .card-icon svg { width: 22px; height: 22px; fill: currentColor; }
  .card-title { font-size: 16px; font-weight: 600; color: #2c3e50; }
  .card-desc { font-size: 13px; line-height: 1.6; color: #5a6473; }
  .card-arrow { margin-top: 14px; font-size: 12px; color: #4a90e2; display: inline-flex; align-items: center; gap: 4px; }
  footer { padding: 16px 32px; text-align: center; font-size: 12px; color: #95a5a6; border-top: 1px solid #e0e3eb; background: #fff; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <p>选择下方任一视图进入对应可视化报告</p>
</header>
<main>
  ${statsHtml}
  <section class="grid">
${cardsHtml}
  </section>
</main>
<footer>由 codeParseForRes 生成</footer>
</body>
</html>`;
}

function renderCard(p: IndexPageLink): string {
  const accent = p.accent ?? DEFAULT_ACCENT;
  const iconHtml = p.iconPath
    ? `<svg viewBox="0 0 24 24"><path d="${p.iconPath}"/></svg>`
    : escapeHtml(p.title.slice(0, 1) || '?');
  const cls = p.disabled ? 'card disabled' : 'card';
  const hrefAttr = p.disabled ? '' : ` href="${escapeAttr(p.href)}"`;
  const arrow = p.disabled
    ? `<span class="card-arrow">未生成</span>`
    : `<span class="card-arrow">进入 →</span>`;
  return `    <a class="${cls}"${hrefAttr} aria-label="${escapeAttr(p.title)}" style="--accent:${escapeAttr(accent)}">
      <span class="card-head">
        <span class="card-icon" style="background:${escapeAttr(accent)}">${iconHtml}</span>
        <span class="card-title">${escapeHtml(p.title)}</span>
      </span>
      <span class="card-desc">${escapeHtml(p.description)}</span>
      ${arrow}
    </a>`;
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
