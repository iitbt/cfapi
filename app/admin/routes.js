// 控制面板 + 未迁入口的占位页
// 2.6.9 精简: 卡片从 14 张压到 5 张(把"已显示/待审核"并进同一张卡, 删掉低频与别处已有的数字),
// 只留"经营要看的一眼" + 2 张趋势 + 3 个最新列表 —— 版本/服务器时间/依赖状态/表数量/存储占用这些在
// 「系统信息」与对外状态页已经有了, 这里不再重复。
// 统计口径仍与旧站 dashboard.py / overview.collect_counts 一致: 数字一次 UNION 取回、趋势分开查、列表各一条
import { escapeHtml } from '../core/html.js';
import { all, one } from '../core/db.js';
import { beijingDaysAgo, beijingMidnight } from '../core/timeutil.js';
import { adminLayout } from './lib/layout.js';
import { intOr, strOf } from './lib/utils.js';

// 纯 SVG 折线(零依赖, 与旧站的 sparkline 宏等价): 固定 7 个点, 最高点贴顶
function sparkline(values) {
  const list = (values && values.length) ? values : [0];
  const max = Math.max(...list, 1);
  const points = list.map((value, index) => {
    const x = list.length === 1 ? 0 : (index / (list.length - 1)) * 120;
    const y = 30 - (Number(value) || 0) / max * 26;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="sparkline" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true">`
    + `<polyline fill="none" stroke="currentColor" stroke-width="2" points="${points}"></polyline></svg>`;
}

function num(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

async function collectCounts(env, windows) {
  const sql = 'SELECT '
    + '(SELECT COUNT(*) FROM users) AS total_users, '
    + '(SELECT COUNT(*) FROM users WHERE create_time >= ?) AS today_users, '
    + '(SELECT COUNT(*) FROM users WHERE create_time >= ?) AS week_users, '
    + '(SELECT COUNT(*) FROM users WHERE create_time >= ? AND create_time < ?) AS prev_week_users, '
    + '(SELECT COUNT(*) FROM users WHERE create_time >= ?) AS yesterday_users, '
    + '(SELECT COUNT(*) FROM news WHERE deleted_at IS NULL) AS total_news, '
    + "(SELECT COUNT(*) FROM news WHERE status='approved' AND deleted_at IS NULL) AS approved_news, "
    + "(SELECT COUNT(*) FROM news WHERE status='pending' AND deleted_at IS NULL) AS pending_news, "
    + '(SELECT COUNT(*) FROM news_comments) AS total_comments, '
    + "(SELECT COUNT(*) FROM news_comments WHERE status='pending') AS pending_comments, "
    + '(SELECT COUNT(*) FROM news_likes) AS total_likes, '
    + '(SELECT COUNT(*) FROM news_favorites) AS total_favorites';
  const row = await one(env, sql, windows.today, windows.week, windows.prevWeek, windows.week,
    windows.yesterday) || {};
  const counts = {};
  for (const [key, value] of Object.entries(row)) counts[key] = intOr(value, 0);
  return counts;
}

// 近 7 日每日新增(缺日期补 0): 用 substr 截日期, 两个驱动都支持(旧站踩过 SQLite 专有函数的坑)
async function trend(env, table, dateColumn, extraWhere = '') {
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    days.push(beijingMidnight(new Date(Date.now() - offset * 86400000)).slice(0, 10));
  }
  const rows = await all(env,
    `SELECT substr(${dateColumn},1,10) AS d, COUNT(*) AS c FROM ${table} `
    + `WHERE ${dateColumn} >= ?${extraWhere} GROUP BY d ORDER BY d`,
    `${days[0]} 00:00:00`).catch(() => []);
  const map = {};
  for (const row of rows) map[strOf(row.d)] = intOr(row.c, 0);
  return days.map((day) => map[day] || 0);
}

// 统计卡: value/hint 允许带 HTML(数字与"待审核"角标由调用方拼), label 一律转义
function card(label, value, hint = '') {
  return `<div class="col-6 col-md-3"><div class="card-stat">
  <div class="lbl">${escapeHtml(label)}</div>
  <div class="num">${value}</div>
  ${hint ? `<div class="lbl">${hint}</div>` : ''}
</div></div>`;
}

function miniList(title, rows, renderRow, href) {
  const body = rows.length
    ? rows.map(renderRow).join('')
    : '<li class="list-group-item text-muted small">暂无数据</li>';
  return `<div class="card mt-3"><div class="card-body">
  <div class="d-flex align-items-center mb-2">
    <div class="form-label mb-0">${escapeHtml(title)}</div>
    <a class="ms-auto small" href="${href}">查看全部</a>
  </div>
  <ul class="list-group list-group-flush">${body}</ul>
</div></div>`;
}

export async function dashboardPage(ctx) {
  const windows = {
    today: beijingMidnight(),
    yesterday: beijingMidnight(new Date(Date.now() - 86400000)),
    week: beijingDaysAgo(7),
    prevWeek: beijingDaysAgo(14)
  };
  let counts = {};
  let trendUsers = [0, 0, 0, 0, 0, 0, 0];
  let trendNews = [0, 0, 0, 0, 0, 0, 0];
  let latestUsers = [];
  let latestNews = [];
  let latestComments = [];
  let error = '';
  // 单条失败只让那一块空着, 不影响其它卡片(与改前串行版"部分成功"的观感一致)
  const soft = (promise, fallback) => promise.catch((err) => {
    console.error('统计数据加载失败', err && err.message);
    error = '部分统计数据加载失败，以下数字可能不完整。请刷新重试。';
    return fallback;
  });
  try {
    // 6 条查询互不依赖 → 一次并发发出: 总耗时 ≈ 最慢的一条, 而不是 6 条之和
    // (状态页实测一次 D1 往返约 240ms, 串行就是 1.4 秒 —— 这是控制面板"打开慢"的主因)
    [counts, trendUsers, trendNews, latestUsers, latestNews, latestComments] = await Promise.all([
      soft(collectCounts(ctx.env, windows), {}),
      soft(trend(ctx.env, 'users', 'create_time'), [0, 0, 0, 0, 0, 0, 0]),
      soft(trend(ctx.env, 'news', 'publish_time', ' AND deleted_at IS NULL'), [0, 0, 0, 0, 0, 0, 0]),
      soft(all(ctx.env, 'SELECT id, username, nickname, create_time FROM users ORDER BY id DESC LIMIT 8'), []),
      soft(all(ctx.env,
        'SELECT id, title, category, publish_time FROM news WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 8'), []),
      soft(all(ctx.env,
        'SELECT c.id, c.content, c.status, u.nickname FROM news_comments c LEFT JOIN users u ON c.user_id = u.id '
        + 'ORDER BY c.id DESC LIMIT 8'), [])
    ]);
  } catch (err) {
    console.error('统计数据加载失败', err && err.stack ? err.stack : err);
    error = '统计数据加载失败，以下数字可能不完整。请查看 Workers 日志或稍后刷新重试。';
  }

  const todayDelta = counts.today_users - counts.yesterday_users;
  const weekDelta = counts.week_users - counts.prev_week_users;
  const deltaText = (value) => (value > 0 ? `较上期 +${value}` : (value < 0 ? `较上期 ${value}` : '与上期持平'));

  // 5 张卡(2.6.9 精简): 用户 / 近 7 日新增 / 笔记(含已显示与待审核) / 留言(含待审核) / 互动
  const warn = (value, text) => `<span class="${value ? 'text-warning' : ''}">${text}</span>`;
  const cards = [
    card('总用户数', num(counts.total_users), `今日 +${num(counts.today_users)} · ${deltaText(todayDelta)}`),
    card('近 7 日新增用户', num(counts.week_users), deltaText(weekDelta)),
    card('笔记', num(counts.total_news),
      `已显示 ${num(counts.approved_news)} · ${warn(counts.pending_news, `待审核 ${num(counts.pending_news)}`)}`),
    card('留言', num(counts.total_comments), warn(counts.pending_comments, `待审核 ${num(counts.pending_comments)}`)),
    card('互动（点赞 / 收藏）', `${num(counts.total_likes)} / ${num(counts.total_favorites)}`, '点赞总数 / 收藏总数')
  ].join('');

  const trendCards = `<div class="row g-3 mt-1">
  <div class="col-md-6"><div class="card-stat">
    <div class="lbl">近 7 日新增用户趋势</div>
    <div class="num">${num(trendUsers.reduce((sum, value) => sum + value, 0))}</div>
    <div class="lbl">最近一天 ${num(trendUsers[trendUsers.length - 1])} 人</div>
    <div class="text-primary">${sparkline(trendUsers)}</div>
  </div></div>
  <div class="col-md-6"><div class="card-stat">
    <div class="lbl">近 7 日笔记发布趋势</div>
    <div class="num">${num(trendNews.reduce((sum, value) => sum + value, 0))}</div>
    <div class="lbl">最近一天 ${num(trendNews[trendNews.length - 1])} 篇</div>
    <div class="text-success">${sparkline(trendNews)}</div>
  </div></div>
</div>`;

  const lists = miniList('最新注册用户', latestUsers, (row) => `<li class="list-group-item d-flex">
    <span class="text-truncate">${escapeHtml(strOf(row.nickname) || strOf(row.username) || '-')}</span>
    <span class="ms-auto small text-muted">${escapeHtml(strOf(row.create_time).slice(5, 16))}</span>
  </li>`, '/admin/users')
    + miniList('最新笔记', latestNews, (row) => `<li class="list-group-item d-flex">
    <a class="text-truncate" href="/admin/news_preview?id=${row.id}">${escapeHtml(strOf(row.title) || '(无标题)')}</a>
    <span class="ms-auto small text-muted">${escapeHtml(strOf(row.publish_time).slice(5, 16))}</span>
  </li>`, '/admin/news_manage')
    + miniList('最新留言', latestComments, (row) => `<li class="list-group-item">
    <div class="text-truncate">${escapeHtml(strOf(row.content))}</div>
    <div class="small text-muted">${escapeHtml(strOf(row.nickname) || '匿名')} · ${escapeHtml(strOf(row.status))}</div>
  </li>`, '/admin/comments_manage');

  return adminLayout(Object.assign({}, ctx, {
    title: '控制面板', currentPage: 'dashboard',
    error: error || ctx.error,
    content: `<div class="row g-3">${cards}</div>${trendCards}${lists}`
  }));
}

export function pendingPage(ctx, item) {
  const content = `<div class="card-stat">
  <h5 class="mb-2">${escapeHtml(item.title)}</h5>
  <p class="mb-1">这个页面还没迁到 Cloudflare Workers。</p>
  <p class="mb-0 text-muted">旧站路径 <code>/admin/${escapeHtml(item.key)}</code>；排期与做法见 <code>app/api-cf/admin/README.md</code>。</p>
</div>`;
  return adminLayout(Object.assign({}, ctx, {
    title: item.title, currentPage: item.key, content
  }));
}
