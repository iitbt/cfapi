// 数据库管理（旧站「系统设置 → 数据库工具」那一页在 Cloudflare 侧的合并版）
//
// 逐条对齐旧站 app/admin/dbadmin.py(表浏览 + SQL) 与 maint.py(安全内核)。
// 旧站入口是聚合页 `?tab=manage`; Cloudflare 侧没有"本地库文件"概念(没有备份/压缩/VACUUM),
// 所以两页合并成一页, 并且**保持两个地址都可达**:
//   /admin/db_tools   —— 旧站侧栏入口(保持菜单地址不变; 菜单文案 2.2.9 起叫「数据库管理」)
//   /admin/db_manage  —— 旧站数据库管理页地址(保持可达)
//
// 一屏能干什么(2.2.9; 对照 Cloudflare D1 控制台"更不方便"的地方):
//   · 表清单: 全部表 + 行数(按需统计, 默认只有这一屏统计)、表名本地搜索、一键复制表名/字段名;
//   · 字段总览: **一条 SQL** 把全库"表 + 字段"列在一屏(表函数 pragma_table_info; D1 不支持则回退逐表 PRAGMA);
//   · 表结构: 列/类型/可空/默认值/主键/索引及索引列 + 复制列名与建表语句 + 每列一键"排序/筛选"跳到数据页;
//   · 数据: 点列头排序、按字段筛选、跨列关键字搜索、20|50 行一页、勾选多行批量复制/批量删除,
//     单行可复制 JSON/INSERT/生成 UPDATE, 也可**直接编辑**这一行(或删除)后立即回写;
//   · SQL 控制台: 常用语句快捷入口、本机执行历史、结果表格化(翻页/复制 TSV|JSON)、失败给数据库原文;
//   · 成本可见: 每次执行/每次渲染都显示 D1 的 meta(读 N 行 · 写 N 行 · N ms), 并有本机会话累计
//     —— 账号额度有限(读取行 5M), 这一页要能让人一眼看出"这次花了多少"。
//
// 权限(与旧站三道闸同款, 2.2.9 未动一分):
//   ① 页面: superOnly(GET 不被写路径中间件拦, 必须自己判 —— 旧站注释专门强调过这点);
//   ② 写: 写路径 /admin/db_manage 已登记在 entities.SUPER_ONLY_WRITE_PATHS(分发前拦一道);
//   ③ 开关: ENABLE_SQL_TOOL=1 才开放(旧站生产默认关).
//   **2.2.9 的"单行编辑/删除/批量删除"没有新增任何写接口**: 它们都是前端按主键/rowid 生成**一条** SQL,
//   再走既有的 POST /admin/db_manage/exec(同一条安全内核: 白名单业务表 + confirm=1 + 审计 + 用量回传)。
//   这样"能改哪里、怎么改"的口径只有一处, 不会出现"页面能改但 SQL 不能改"这种两套判定。
import { escapeHtml } from '../../core/html.js';
import { settings } from '../../core/config.js';
import { adminLayout } from '../lib/layout.js';
import { filterButtons, pageHeader, searchBar, searchInput, searchSelect, staticScript } from '../lib/partials.js';
import { auditLog, buildListUrl, intOr, strOf } from '../lib/utils.js';
import { json } from '../lib/http.js';
import {
  MAX_EXEC_ROWS, MAX_PAGE_SIZE, PAGE_SIZES, SAFE_TABLES, SENSITIVE_COLUMN_NAMES,
  allColumns, classifyStatement, runStatement, tableList, tableMeta, tablePage, tableRow, tableRows
} from '../lib/dbTool.js';

const PAGE_URL = '/admin/db_manage';
const ALIAS_URL = '/admin/db_tools';
const PAGE_TITLE = '数据库管理';
//: 单行编辑/批量删除的 rowid 上限(与数据页单页一致, 避免"一条 DELETE 带一千个参数")
const MAX_BATCH_ROWS = MAX_PAGE_SIZE;

//: 表内视图(参数 ?view=): 数据 / 表结构 / 字段总览
const VIEWS = [['data', '数据'], ['structure', '表结构'], ['columns', '字段总览']];
const viewOf = (raw) => {
  const value = strOf(raw);
  return value === 'structure' || value === 'columns' ? value : 'data';
};

//: 可写范围 = 与执行 SQL 同一份白名单业务表。不在清单里的表(admin_users / app_* 等)只能看,
//  页面会把编辑与批量按钮藏起来(不信前端也白搭: 服务端 exec 会再拦一次)
const isWritable = (name) => SAFE_TABLES.includes(name);

// 页面级闸门: 非超管回控制面板; 开关关闭时给明确说明而不是空白页
function gate(ctx, env) {
  if (!ctx.session.isSuper) {
    return '/admin/dashboard?error=' + encodeURIComponent('该页面仅超级管理员可访问');
  }
  if (!settings(env).enableSqlTool) {
    return null;
  }
  return undefined;
}

function disabledPage(ctx) {
  return adminLayout(Object.assign({}, ctx, {
    title: PAGE_TITLE,
    currentPage: 'db_tools',
    content: `<div class="card"><div class="card-body">
  <h5 class="card-title">数据库管理未开启</h5>
  <p class="mb-2">这一页能浏览全表数据、也能执行 SQL，因此与旧后台同口径：<b>默认关闭</b>。</p>
  <p class="mb-0">需要时在 Cloudflare 的变量里把 <code>ENABLE_SQL_TOOL</code> 设为 <code>1</code> 再部署；用完建议改回 <code>0</code>。</p>
</div></div>`
  }));
}

/** 复制按钮: 后端只出 data-copy, 真正写剪贴板的是页尾那一个委派处理器。 */
function copyButton(value, label, extra = '') {
  return `<button type="button" class="btn btn-sm btn-outline-secondary ${extra}"`
    + ` data-copy="${escapeHtml(value)}" title="复制 ${escapeHtml(label)}">`
    + `<i class="bi bi-clipboard" aria-hidden="true"></i> ${escapeHtml(label)}</button>`;
}

function link(url, label, extra = '') {
  return `<a class="btn btn-sm btn-outline-secondary ${extra}" href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

//: 行数据的取法: **不内嵌整行 JSON**, 只带 rowid; 点按钮时按需取那一行(1 次查询)
//  理由: 2.2.7 把整行 JSON 塞进 data-row, news 表(带正文)50 行就 269KB HTML —— 每次翻页都重传;
//  而且长文本还得截断, 复制出来的 INSERT/UPDATE 反而不准确。改为按需取: 页面回到 ~35KB, 值还是完整的。
function rowButtons(name, data, row, writable) {
  const rowid = row.__rowid === undefined || row.__rowid === null ? '' : String(row.__rowid);
  if (!rowid) return '<span class="small text-muted" title="这张表没有 rowid，请用 SQL 控制台按主键查">—</span>';
  const common = `data-table="${escapeHtml(name)}" data-rowid="${escapeHtml(rowid)}"`;
  return `<button type="button" class="btn btn-sm btn-outline-secondary" data-row-action="json" ${common} title="取这一行并复制为 JSON（按需取数，值完整）"><i class="bi bi-clipboard" aria-hidden="true"></i></button>`
    + `<button type="button" class="btn btn-sm btn-outline-secondary" data-row-action="insert" ${common} title="取这一行并复制为 INSERT 语句"><i class="bi bi-plus-square" aria-hidden="true"></i></button>`
    + `<button type="button" class="btn btn-sm btn-outline-secondary" data-row-action="update" ${common} data-pk="${escapeHtml((data.pkColumns || []).join(','))}" title="取这一行并生成 UPDATE 填到 SQL 控制台"><i class="bi bi-pencil-square" aria-hidden="true"></i></button>`
    + (writable
      ? `<button type="button" class="btn btn-sm btn-outline-primary" data-row-action="edit" ${common} data-pk="${escapeHtml((data.pkColumns || []).join(','))}" title="编辑这一行（保存时生成一条 UPDATE 走 exec，仍需二次确认）"><i class="bi bi-pencil" aria-hidden="true"></i></button>`
      : '')
    + `<button type="button" class="btn btn-sm btn-outline-primary" data-row-action="full" ${common} title="取这一行的完整数据（含长文本）并展开"><i class="bi bi-arrows-fullscreen" aria-hidden="true"></i></button>`;
}

/**
 * 表清单卡片: 表名 / 行数 / 快捷操作(数据、结构、复制表名), 表名可本地搜索。
 * withCounts=false 时一条 COUNT 都不发(只读一次表清单) —— D1 单线程串行执行, N 张表的 COUNT(*)
 * 就是 N 次全表扫描, 所以只有"表清单视图"默认统计, 其余视图默认不统计、需要时再点。
 */
async function renderTableList(env, withCounts) {
  const list = await tableList(env, { withCounts });
  if (!list.ok) {
    return '<div class="alert alert-danger mb-0">读取表清单失败（数据库可能暂时不可用，详见 Workers 日志）</div>';
  }
  const rows = list.tables.map((item) => `<tr data-table-row="${escapeHtml(item.name)}">
    <td><code>${escapeHtml(item.name)}</code>${SAFE_TABLES.includes(item.name) ? '' : ' <span class="badge text-bg-warning" title="执行 SQL 只允许白名单业务表">只读</span>'}</td>
    <td>${item.count === null ? '<span class="text-muted">未统计</span>' : item.count}</td>
    <td class="text-end text-nowrap">
      <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(buildListUrl(PAGE_URL, { filters: { table: item.name, view: 'data' } }))}">浏览数据</a>
      <a class="btn btn-sm btn-outline-secondary" href="${escapeHtml(buildListUrl(PAGE_URL, { filters: { table: item.name, view: 'structure' } }))}">看结构</a>
      <a class="btn btn-sm btn-outline-secondary" href="${escapeHtml(buildListUrl(PAGE_URL, { filters: { table: item.name, view: 'columns' } }))}">看字段</a>
      ${copyButton(item.name, '复制表名')}
    </td>
  </tr>`).join('');
  const toggle = withCounts
    ? link(buildListUrl(PAGE_URL, { filters: { counts: '0' } }), '不统计行数（更快）')
    : link(buildListUrl(PAGE_URL, { filters: { counts: '1' } }), `统计 ${list.tables.length} 张表的行数`);
  return `<div class="d-flex flex-wrap align-items-center gap-2 mb-2">
    <h6 class="mb-0">数据表状态</h6>
    ${searchInput({ attrs: 'data-filter-tables', placeholder: '按表名筛选（本地）' })}
    ${toggle}
    ${withCounts ? `<span class="ms-auto small text-muted">共 ${list.tables.length} 张表 · 合计 ${Number(list.total || 0).toLocaleString('en-US')} 行</span>`
    : `<span class="ms-auto small text-muted">共 ${list.tables.length} 张表 · 行数未统计（省掉 ${list.tables.length} 条 COUNT）</span>`}
  </div>
  <div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
    <thead><tr><th>表名</th><th>行数</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="text-muted">库里还没有表</td></tr>'}</tbody>
  </table></div>
  <div class="small text-muted mt-2">
    浏览范围是全部表，执行 SQL 只允许白名单业务表（${SAFE_TABLES.length} 张）。
    行数是逐表 <code>COUNT(*)</code>：D1 <b>单线程串行执行</b>，一次统计 = N 次全表扫描，
    所以只在「表清单」这一屏默认统计，看结构/看数据时不统计（打开某张表只查它自己那一行数）。
  </div>`;
}

/** 表结构卡片: 列(类型/可空/默认值/主键/索引/说明) + 索引明细 + 一键复制。 */
async function renderStructure(ctx, name) {
  // withCount: 顺带把这张表的行数带回来(结构页要显示), 复用同一次存在性检查, 不多发语句
  const meta = await tableMeta(ctx.env, name, { withSql: true, withCount: true });
  if (!meta.ok) {
    return `<div class="alert alert-warning mb-0">${escapeHtml(meta.reason)}</div>`;
  }
  const total = meta.rowCount;
  const indexedBy = new Map();
  for (const index of meta.indexes) {
    for (const column of index.columns) {
      const label = index.unique ? '唯一索引' : '索引';
      indexedBy.set(column, indexedBy.has(column) ? `${indexedBy.get(column)}、${label}` : label);
    }
  }
  const columnNames = meta.columnNames.join(', ');
  // 每列给两个快捷动作(2.2.9): 直接跳到数据页"按这列排序 / 按这列筛选" —— 结构页看完字段往往下一步就是看数据
  const colRows = meta.columns.map((col) => `<tr>
    <td><code>${escapeHtml(col.name)}</code> ${copyButton(col.name, '复制')}</td>
    <td>${escapeHtml(col.type || '—')}</td>
    <td>${col.notnull ? '非空' : '可空'}</td>
    <td>${col.default === '' ? '<span class="text-muted">—</span>' : `<code>${escapeHtml(col.default)}</code>`}</td>
    <td>${col.pk ? '<span class="badge text-bg-primary">主键</span>' : ''}</td>
    <td><span class="small text-muted">${escapeHtml(indexedBy.get(col.name) || '—')}</span></td>
    <td class="text-muted">${escapeHtml(col.comment || '—')}</td>
    <td class="text-end text-nowrap">
      <a class="btn btn-sm btn-outline-secondary" title="按这一列排序"
         href="${escapeHtml(buildListUrl(PAGE_URL, { filters: { table: name, view: 'data', sort: col.name, dir: 'asc' } }))}"><i class="bi bi-sort-down" aria-hidden="true"></i></a>
      <a class="btn btn-sm btn-outline-secondary" title="按这一列筛选"
         href="${escapeHtml(buildListUrl(PAGE_URL, { filters: { table: name, view: 'data', col: col.name } }))}"><i class="bi bi-funnel" aria-hidden="true"></i></a>
    </td>
  </tr>`).join('');
  const indexRows = meta.indexes.map((index) => `<tr>
    <td><code>${escapeHtml(index.name)}</code></td>
    <td>${index.unique ? '唯一' : '普通'}</td>
    <td><code>${escapeHtml(index.columns.join(', ') || '—')}</code></td>
  </tr>`).join('');
  return `<div class="card mb-3"><div class="card-body">
    <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      <h6 class="mb-0"><code>${escapeHtml(name)}</code> 结构</h6>
      <span class="small text-muted">${meta.columns.length} 列 · 索引 ${meta.indexes.length} 个${total === null ? '' : ` · ${total} 行`} · ${meta.viaPragma ? 'PRAGMA 读取' : '解析建表语句（PRAGMA 不可用）'}</span>
      ${isWritable(name) ? '' : '<span class="badge text-bg-warning" title="不在可写白名单里：只读，改动请用 SQL 控制台的其它表或用 wrangler">只读表</span>'}
      <span class="ms-auto d-flex flex-wrap gap-2">
        ${copyButton(columnNames, '复制列名')}
        ${meta.createSql ? copyButton(meta.createSql, '复制建表语句') : ''}
        ${link(buildListUrl(PAGE_URL, { filters: { table: name, view: 'columns' } }), '字段总览')}
      </span>
    </div>
    <div class="table-responsive"><table class="table table-sm mb-0">
      <thead><tr><th>列</th><th>类型</th><th>可空</th><th>默认值</th><th>键</th><th>索引</th><th>说明</th><th></th></tr></thead>
      <tbody>${colRows}</tbody>
    </table></div>
    ${meta.indexes.length ? `<div class="table-responsive mt-3"><table class="table table-sm mb-0">
      <thead><tr><th>索引名</th><th>类型</th><th>列</th></tr></thead>
      <tbody>${indexRows}</tbody>
    </table></div>` : ''}
  </div></div>`;
}

/**
 * 字段总览(2.2.9): 「表与字段一屏可读」。
 * 正常情况只有 **1 条** SQL(`sqlite_master JOIN pragma_table_info`), 结果还进元数据缓存;
 * D1 若不支持这个表函数就回退逐表 PRAGMA(走缓存), 并在页面上如实说明现在是哪种取法。
 * `?table=` 可只看某一张表的字段(不额外查库, 只是在结果里过滤)。
 */
async function renderColumns(ctx, filterTable) {
  const data = await allColumns(ctx.env);
  if (!data.ok) {
    return '<div class="alert alert-warning mb-0">读取字段总览失败（详见 Workers 日志）</div>';
  }
  const tables = filterTable ? data.tables.filter((item) => item.name === filterTable) : data.tables;
  const groups = tables.map((table) => {
    const rows = table.columns.map((col) => `<tr>
      <td><code>${escapeHtml(col.name)}</code> ${copyButton(col.name, '复制')}</td>
      <td>${escapeHtml(col.type || '—')}</td>
      <td>${col.notnull ? '非空' : '可空'}</td>
      <td>${col.default === '' ? '<span class="text-muted">—</span>' : `<code>${escapeHtml(col.default)}</code>`}</td>
      <td>${col.pk ? '<span class="badge text-bg-primary">主键</span>' : ''}</td>
      <td class="text-end text-nowrap">
        <a class="btn btn-sm btn-outline-secondary" title="看数据（按这一列排序）"
           href="${escapeHtml(buildListUrl(PAGE_URL, { filters: { table: table.name, view: 'data', sort: col.name, dir: 'asc' } }))}"><i class="bi bi-table" aria-hidden="true"></i></a>
        <a class="btn btn-sm btn-outline-secondary" title="看这一列的表结构"
           href="${escapeHtml(buildListUrl(PAGE_URL, { filters: { table: table.name, view: 'structure' } }))}"><i class="bi bi-list-columns-reverse" aria-hidden="true"></i></a>
      </td>
    </tr>`).join('');
    return `<tbody class="table-group-divider">
      <tr class="table-light"><td colspan="6">
        <code>${escapeHtml(table.name)}</code>
        <span class="small text-muted">${table.columns.length} 列</span>
        ${isWritable(table.name) ? '' : '<span class="badge text-bg-warning" title="不在可写白名单里：只读">只读</span>'}
        <span class="ms-2 d-inline-flex gap-1">
          <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(buildListUrl(PAGE_URL, { filters: { table: table.name, view: 'data' } }))}">浏览数据</a>
          <a class="btn btn-sm btn-outline-secondary" href="${escapeHtml(buildListUrl(PAGE_URL, { filters: { table: table.name, view: 'structure' } }))}">看结构</a>
          ${copyButton(table.columns.map((col) => col.name).join(', '), '复制列名')}
        </span>
      </td></tr>
      ${rows || '<tr><td colspan="6" class="text-muted">读不到字段（表可能是空的或结构读取失败）</td></tr>'}
    </tbody>`;
  }).join('');
  const shownColumns = tables.reduce((sum, item) => sum + item.columns.length, 0);
  return `<div class="card mb-3"><div class="card-body">
    <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      <h6 class="mb-0">字段总览</h6>
      <span class="small text-muted">${tables.length} 张表 · ${shownColumns} 个字段${filterTable ? `（只看 ${escapeHtml(filterTable)}）` : ''}
        · ${data.mode === 'query' ? '一次 SQL 取回' : '逐表 PRAGMA（表函数不可用）'}
        ${data.stats ? ` · 本次 ${escapeHtml(data.stats.costText)}` : ''}</span>
      <span class="ms-auto d-flex flex-wrap gap-2">
        ${filterTable ? link(buildListUrl(PAGE_URL, { filters: { view: 'columns' } }), '看全部表') : ''}
      </span>
    </div>
    <div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
      <thead><tr><th>表 / 字段</th><th>类型</th><th>可空</th><th>默认值</th><th>主键</th><th></th></tr></thead>
      ${groups || '<tbody><tr><td colspan="6" class="text-muted">库里还没有表</td></tr></tbody>'}
    </table></div>
    <div class="small text-muted mt-2">
      这一屏是"表与字段一次看清"：字段取法见上面的说明，结果会进元数据缓存（结构不变就不再重复读）。
      要看某一列的数据内容，点右边第二个图标会带着「按该列排序」跳到数据页。
    </div>
  </div></div>`;
}

/** 数据卡片: 排序(点列头) + 按字段筛选 + 关键字搜索 + 分页 + 勾选批量 + 单行编辑/复制。 */
async function renderData(ctx, name, query) {
  const size = Math.min(Math.max(1, intOr(query.size, PAGE_SIZES[0])), MAX_PAGE_SIZE);
  const view = {
    sort: strOf(query.sort), dir: strOf(query.dir),
    column: strOf(query.col), value: strOf(query.val), q: strOf(query.q),
    prefix: strOf(query.prefix) === '1'
  };
  const data = await tablePage(ctx.env, name, strOf(query.page) || 1, size, view);
  if (!data.ok) {
    return `<div class="alert alert-warning mb-0">${escapeHtml(data.reason)}</div>`;
  }
  const baseFilters = {
    table: name, view: 'data', sort: data.sort, dir: data.sort ? data.dir : '',
    col: data.column, val: data.value, q: data.q, prefix: data.prefix ? '1' : '',
    size: size === PAGE_SIZES[0] ? '' : size
  };
  // 可勾选批量 = 可写表 + 有 rowid(按 rowid 定位最省: 一条 `DELETE ... WHERE rowid IN (…)`)
  const writable = isWritable(name);
  const selectable = writable && data.hasRowid;
  // 列头: 点一下按该列排序(再点一次换方向); 排序参数进 URL, 刷新/直链都能定位
  const head = (selectable ? '<th class="text-nowrap"><input type="checkbox" data-select-all aria-label="全选本页"></th>' : '')
    + data.rowKeys.map((key) => {
      if (key === '__rowid') return `<th class="text-muted" title="隐式行号(单行定位/批量操作都用它)">rowid</th>`;
      const active = data.sort === key;
      const nextDir = active && data.dir === 'ASC' ? 'desc' : 'asc';
      const arrow = active ? (data.dir === 'ASC' ? ' ▲' : ' ▼') : '';
      const url = buildListUrl(PAGE_URL, { filters: Object.assign({}, baseFilters, { sort: key, dir: nextDir }) });
      return `<th><a class="text-decoration-none" href="${escapeHtml(url)}" title="按 ${escapeHtml(key)} 排序">${escapeHtml(key)}${arrow}</a></th>`;
    }).join('') + '<th></th>';
  const body = data.rows.map((row) => {
    const cells = data.rowKeys.map((key) => {
      const text = strOf(row[key]);
      const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      const extra = key === '__rowid' ? ' class="text-muted small"' : '';
      // title 只在被截断时才挂(且只前 200 字符): 每格都挂一份 title 会让 HTML 成倍膨胀
      const tip = text.length > 120 ? ` title="${escapeHtml(text.slice(0, 200))}"` : '';
      return `<td${extra}${tip}>${escapeHtml(shown) || '—'}</td>`;
    }).join('');
    const rowid = row.__rowid === undefined || row.__rowid === null ? '' : String(row.__rowid);
    const pick = selectable
      ? `<td class="text-nowrap">${rowid
        ? `<input type="checkbox" data-row-pick value="${escapeHtml(rowid)}" aria-label="选择 rowid ${escapeHtml(rowid)}">`
        : ''}</td>`
      : '';
    return `<tr data-row-rowid="${escapeHtml(rowid)}">${pick}${cells}<td class="text-nowrap">${rowButtons(name, data, row, writable)}</td></tr>`;
  }).join('')
  const prev = data.page > 1 ? link(buildListUrl(PAGE_URL, { filters: baseFilters, page: data.page - 1 }), '上一页') : '';
  const next = data.page < data.pages ? link(buildListUrl(PAGE_URL, { filters: baseFilters, page: data.page + 1 }), '下一页') : '';
  const sizeForm = `<form class="d-flex align-items-center gap-2" method="get" action="${PAGE_URL}">
    <input type="hidden" name="table" value="${escapeHtml(name)}">
    <input type="hidden" name="view" value="data">
    ${data.sort ? `<input type="hidden" name="sort" value="${escapeHtml(data.sort)}"><input type="hidden" name="dir" value="${escapeHtml(data.dir.toLowerCase())}">` : ''}
    ${data.column && data.value ? `<input type="hidden" name="col" value="${escapeHtml(data.column)}"><input type="hidden" name="val" value="${escapeHtml(data.value)}">` : ''}
    ${data.q ? `<input type="hidden" name="q" value="${escapeHtml(data.q)}">` : ''}
    ${data.prefix ? '<input type="hidden" name="prefix" value="1">' : ''}
    <select class="form-select form-select-sm" name="size" style="width:auto" onchange="this.form.submit()">
      ${PAGE_SIZES.map((value) => `<option value="${value}"${value === size ? ' selected' : ''}>每页 ${value} 行</option>`).join('')}
    </select>
  </form>`;
  // 筛选/搜索条: 共用实现(原来 select 是 width:auto、图标是 bi-funnel; 现在与全站一致)
  const filterForm = searchBar({
    action: PAGE_URL,
    hidden: `<input type="hidden" name="table" value="${escapeHtml(name)}">`
      + '<input type="hidden" name="view" value="data">'
      + `<input type="hidden" name="size" value="${size}">`
      + (data.sort ? `<input type="hidden" name="sort" value="${escapeHtml(data.sort)}"><input type="hidden" name="dir" value="${escapeHtml(data.dir.toLowerCase())}">` : ''),
    body: searchSelect({
      name: 'col', value: data.column, wide: true,   // 字段名长, 这个下拉用 lg 宽度(12rem)
      items: [['', '按字段筛选…']].concat(data.columns.map((column) => [column, column]))
    })
      + searchInput({ name: 'val', value: data.value, placeholder: '包含该内容' })
      + searchInput({ name: 'q', value: data.q, placeholder: '全列关键字搜索' })
      // 前缀匹配: `kw%` 能用上索引, 是全表扫描下最省的一种写法(默认仍是包含匹配, 与旧站一致)
      + `<label class="d-flex align-items-center gap-1 small text-muted mb-0" title="只匹配开头: 能用上索引, 少读很多行">
          <input class="form-check-input mt-0" type="checkbox" name="prefix" value="1"${data.prefix ? ' checked' : ''}> 前缀匹配
        </label>`,
    extra: data.filtered ? link(buildListUrl(PAGE_URL, { filters: { table: name, view: 'data', size: size === PAGE_SIZES[0] ? '' : size } }), '清空筛选') : ''
  });
  // 关键字搜索是全表扫描(每行都过一次 LIKE), 把代价与"怎么搜更省"直接写在搜索条下面
  const searchHint = '<div class="small text-muted mb-2">关键字搜索是整表包含匹配（只搜文本列）；勾「前缀匹配」能让 D1 用上索引、少读很多行。</div>';
  const tips = [
    data.sort ? `按 <code>${escapeHtml(data.sort)}</code> ${data.dir === 'ASC' ? '升序' : '降序'}` : '',
    data.column && data.value ? `字段 <code>${escapeHtml(data.column)}</code> 含「${escapeHtml(data.value)}」` : '',
    data.q ? `关键字「${escapeHtml(data.q)}」${data.prefix ? '（前缀匹配）' : ''}` : '',
    data.q ? `关键字「${escapeHtml(data.q)}」` : ''
  ].filter(Boolean).join(' · ');
  return `<div class="card"><div class="card-body">
    <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      <h6 class="mb-0">数据（第 ${data.page}/${data.pages} 页，共 ${data.total} 行${data.filtered ? '（已筛选）' : ''}）</h6>
      ${sizeForm}
      <span class="ms-auto d-flex gap-2">${prev}${next}</span>
    </div>
    <div class="mb-2">${filterForm}</div>
    ${searchHint}
    ${tips ? `<div class="small text-muted mb-2">当前：${tips}（点列头可改排序，再点一次换方向）</div>` : '<div class="small text-muted mb-2">点列头可排序；行尾按钮依次是「复制 JSON / 复制 INSERT / 生成 UPDATE / 编辑 / 取完整行」。</div>'}
    ${selectable ? `<div class="d-flex flex-wrap align-items-center gap-2 mb-2" data-selection-bar>
      <span class="small text-muted" data-selection-count>已选 0 行</span>
      <button type="button" class="btn btn-sm btn-outline-secondary" data-batch-action="copy-json" disabled>复制所选 JSON</button>
      <button type="button" class="btn btn-sm btn-outline-secondary" data-batch-action="copy-tsv" disabled>复制所选 TSV</button>
      <button type="button" class="btn btn-sm btn-outline-danger" data-batch-action="delete" disabled>删除所选</button>
      <span class="small text-muted">批量的取数与删除都是<b>一条</b> SQL（<code>rowid IN (…)</code>），不做 N 次请求；删除前会二次确认并回显影响行数。</span>
      <span class="small" data-batch-msg></span>
    </div>` : `<div class="small text-muted mb-2">${writable
      ? '这张表没有 rowid（WITHOUT ROWID），不能按行勾选批量操作；请用 SQL 控制台按主键操作。'
      : '只读表（不在可写白名单里）：可以浏览、排序、筛选与复制，改动请用 SQL 控制台或 wrangler。'}</div>`}
    <div class="table-responsive"><table class="table table-sm table-striped align-middle mb-0"
      data-table="${escapeHtml(name)}" data-writable="${writable ? '1' : '0'}"
      data-selectable="${selectable ? '1' : '0'}" data-row-keys="${escapeHtml(data.rowKeys.join(','))}">
      <thead><tr>${head}</tr></thead>
      <tbody>${body || `<tr><td colspan="${(data.rowKeys.length || 1) + 1 + (selectable ? 1 : 0)}" class="text-muted">没有符合条件的数据</td></tr>`}</tbody>
    </table></div>
    <div id="rowEditor" class="mt-2"></div>
    <div id="rowDetail" class="mt-2"></div>
    ${data.stats ? `<span hidden data-page-cost="${escapeHtml(JSON.stringify({
      rowsRead: data.stats.rowsRead, rowsWritten: data.stats.rowsWritten, durationMs: data.stats.durationMs
    }))}"></span><div class="small text-muted mt-2">本次查询：${escapeHtml(data.stats.costText)}（1 条 <code>COUNT(*)</code> + 1 条取数；结构元信息走元数据缓存）</div>` : ''}
    <div class="small text-muted mt-1">
      敏感列（token / password / secret / openid 等）已自动打码，生成 INSERT/UPDATE 与行内编辑都会跳过这些列；
      单元格只显示前 120 字符（被截断的悬停看前 200 字符）；列表页<b>不透传整行数据</b> —— 点行尾按钮时才按 rowid 取那一行
      （拿到的是完整值，1 次查询，同一行只取一次）。
      本页只查这张表：1 条 <code>COUNT(*)</code> + 1 条取数 + 结构元信息（缓存），不再统计全库行数。
    </div>
  </div></div>`;
}

/** SQL 控制台: 快捷语句 + 本机历史 + 结果表格化(可翻页/复制) + 失败给数据库原文。 */
function sqlConsole() {
  const presets = [
    ['SELECT id, title, publish_time FROM news ORDER BY id DESC LIMIT 20', '笔记：最近 20 条'],
    ['SELECT id, nickname, status, is_trusted FROM users ORDER BY id DESC LIMIT 20', '用户：最近 20 条'],
    ['SELECT id, content, status FROM news_comments ORDER BY id DESC LIMIT 20', '留言：最近 20 条'],
    ['SELECT COUNT(*) AS c FROM news', '笔记总行数'],
    ['EXPLAIN QUERY PLAN SELECT * FROM news WHERE status = \'approved\'', '看某条查询的执行计划']
  ];
  return `<div class="card mt-3" id="sqlCard"><div class="card-body">
    <div class="d-flex flex-wrap align-items-center gap-2">
      <h6 class="mb-0">执行 SQL</h6>
      <span class="small text-muted">只允许 SELECT / INSERT / UPDATE / DELETE，且只能操作白名单业务表（${SAFE_TABLES.length} 张）；写操作会二次确认。</span>
    </div>
    <div class="d-flex flex-wrap gap-2 mt-2">
      <select class="form-select form-select-sm" style="width:auto" data-sql-preset>
        <option value="">常用语句…</option>
        ${presets.map(([sql, label]) => `<option value="${escapeHtml(sql)}">${escapeHtml(label)}</option>`).join('')}
      </select>
      <span class="small text-muted align-self-center" data-sql-history-label>本机历史：</span>
      <span class="d-flex flex-wrap gap-1" data-sql-history></span>
      <button type="button" class="btn btn-sm btn-outline-secondary ms-auto" data-sql-clear>清空输入</button>
    </div>
    <form id="sqlForm" class="mt-2">
      <textarea class="form-control font-monospace" id="sqlText" rows="4" placeholder="SELECT id, title FROM news LIMIT 5"></textarea>
      <div class="d-flex flex-wrap gap-2 mt-2 align-items-center">
        <button class="btn btn-primary btn-sm" type="submit">执行</button>
        <span class="small text-muted" id="sqlOut"></span>
        <span class="ms-auto small text-muted">结果最多回传 ${MAX_EXEC_ROWS} 行；写语句请务必带 WHERE。</span>
      </div>
    </form>
    <div id="sqlResult" class="mt-3"></div>
  </div></div>`;
}

/**
 * 成本与额度卡片(2.2.9): 额度口径说明 + 本机会话累计 + "这一页怎么省额度"。
 * 为什么不再写死用量数字: 手工快照必然过期(写进去当天就开始不准), 反而误导排障 ——
 * 实时值只有 Cloudflare 控制台看得到(查账户用量要额外 API 凭据, 这一页没有也不该有)。
 * 本机累计由页尾脚本从每次响应的 meta 里累加, 只存在这台浏览器的 localStorage 里, 不上传。
 */
function costCard() {
  return `<details class="card mb-3"><summary class="card-body py-2" style="cursor:pointer">
    成本与额度（本机会话累计 · 去哪看实时用量 · 这一页怎么省额度）
  </summary><div class="card-body pt-0">
    <div class="small text-muted mb-2">
      <b>实时用量只看 Cloudflare 控制台</b>：Dashboard → Workers &amp; Pages → D1 → 选库，能看行读写与存储；
      免费套餐的行读取额度是 <b>每天 500 万行</b>、写入 <b>10 万行/天</b>。
      <b>读取行是这一页最该盯的指标</b>：一次全表扫描就能吃掉一大截。
    </div>
    <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      <span class="badge text-bg-secondary">本机会话</span>
      <span class="small" data-cost-session>这一页还没执行过查询</span>
      <button type="button" class="btn btn-sm btn-outline-secondary" data-cost-reset>清零这一页的累计</button>
      <span class="small text-muted">（只记在这台浏览器里，含表详情与 SQL 的每次响应；不上传、不落库）</span>
    </div>
    <div class="small mb-0">
      <b>省额度的做法</b>（都已落在这页的实现里）：
      <ul class="mb-0">
        <li>元数据（表清单 / 列 / 索引 / 建表语句 / 字段总览）在 60 秒内复用，不重复读 <code>sqlite_master</code>；</li>
        <li>默认<b>只统计当前表</b>的行数：看结构/看数据时不再跑全库 20+ 条 <code>COUNT(*)</code>（那是全表扫描）；</li>
        <li>字段总览用<b>一条</b> SQL 取回全库字段，而不是逐表 PRAGMA；</li>
        <li>数据页每屏固定 2 条语句（<code>COUNT(*)</code> + 取数），批量复制/删除也都只有 1 条；</li>
        <li>行内编辑/删除按主键或 <code>rowid</code> 定位（走索引，<code>rows_read</code> 通常 1~2 行）。</li>
      </ul>
    </div>
  </div></details>`;
}

/**
 * D1 的限制与"这一页怎么绕"：写清楚"为什么慢/为什么不能做某些事", 免得下次又把并发当优化。
 * 内容是平台事实 + 本页做法, 不写没把握的数字(具体配额以 Cloudflare 文档/套餐为准)。
 */
function limitsCard() {
  return `<details class="card mb-3"><summary class="card-body py-2" style="cursor:pointer">
    D1 的限制与这一页的应对（单线程串行执行 · 查询成本 · 不支持的能力）
  </summary><div class="card-body pt-0">
    <ul class="mb-2 small">
      <li><b>单线程串行执行</b>：同一个库上的语句是一条一条跑的，<code>batch</code> 省的是 HTTP 往返、
        库侧仍逐条执行 —— 所以"把互不依赖的查询并发发出去"并不能变快，<b>减少语句条数</b>才有效。
        本页的做法：看某张表时不再统计全库行数（只在「表清单」这一屏统计）、索引列由一次 DDL 查询在本地解析
        （不再一条索引一次 PRAGMA）、数据页只发 1 条 <code>COUNT(*)</code> + 1 条取数。</li>
      <li><b>查询成本可估</b>：D1 每次执行都回 <code>meta</code>（<code>rows_read</code> /
        <code>rows_written</code> / <code>duration</code>），控制台的结果里会显示"读 N 行 · 写 N 行 · N ms"。
        全表扫描的 <code>rows_read</code> 会明显偏大 —— 看到它就说明该加索引或加 <code>LIMIT</code>。</li>
      <li><b>结果集一次性读进内存</b>：执行 SQL 时最多回传 ${MAX_EXEC_ROWS} 行（超出会在提示里说明），
        表格再按 50 行/页分页；数据浏览固定 20/50 行一页。长查询请自己加 <code>LIMIT</code>。</li>
      <li><b>没有本地库文件</b>：不能备份/VACUUM/压缩/整库下载 —— 导出与迁移走
        <code>wrangler d1 export</code> 或控制台（<code>DEPLOY.md</code>）。</li>
      <li><b>结构变更与事务不给入口</b>：<code>CREATE/ALTER/DROP</code>、<code>BEGIN/COMMIT</code>、
        <code>PRAGMA</code> 一律拒绝（与旧站同一道闸）；要改结构请走 <code>app/sql/*.sql</code> +
        <code>wrangler d1 execute --file</code>。<code>EXPLAIN QUERY PLAN</code> 属读语句，可以用。
        所以页面上的 <b>DROP / TRUNCATE 不是"确认后能执行"，而是直接拒绝</b>（比二次确认更硬）。</li>
      <li><b>没有交互式事务</b>：页面只能一条一条发语句（这也是安全内核的要求）。批量删除因此走
        <code>DELETE … WHERE rowid IN (…)</code> —— <b>一条语句一次原子生效</b>，而不是 N 条删一半。
        真需要"多条要么全成要么全不成"时，请用 D1 原生的 <code>batch</code>（本仓库只用它做只读 COUNT）。</li>
      <li><b>语句长度 / 单次结果体积 / 请求时长 / 写入吞吐都有上限</b>（具体数值随套餐，<b>待确认</b>）：
        本页的应对是"每屏语句数固定且很少"（见上面那条）、结果最多回传 ${MAX_EXEC_ROWS} 行、批量操作最多
        一次 ${MAX_BATCH_ROWS} 行、长内容按需单行取。真要跑大批量导入导出请用 <code>wrangler d1 execute/export</code>。</li>
      <li><b>D1 的 <code>meta</code> 是本页的成本可见来源</b>：每次执行/每屏渲染都显示
        <code>rows_read</code> / <code>rows_written</code> / <code>duration</code>，并把本机会话累计存在浏览器里
        （额度参考见上面「成本与额度」卡）。</li>
    </ul>
    <div class="small text-muted mb-0">
      需要查询编辑器/ER 图/多库管理这类能力时不要在本页硬塞（见 <code>README.md</code> 的
      「开源方案评估」）—— 本页的定位是"日常查数与排障"，比 D1 控制台少来回跳，但**不**做结构变更与数据导入导出。
    </div>
  </div></details>`;
}

async function pageHandler(ctx) {
  const verdict = gate(ctx, ctx.env);
  if (typeof verdict === 'string') return Response.redirect(new URL(verdict, ctx.url.origin).toString(), 302);
  if (verdict === null) return disabledPage(ctx);

  const table = strOf(ctx.query.table);
  const view = viewOf(ctx.query.view);
  // 全库行数统计只在"表清单视图"默认开: 看某张表的结构/数据/字段时默认不统计(省掉 N 条 COUNT(*)),
  // 需要时用 ?counts=1 强开, 表清单视图用 ?counts=0 关掉。
  const countsParam = strOf(ctx.query.counts);
  const withCounts = countsParam === '1' || (!table && view !== 'columns' && countsParam !== '0');
  // 敏感列清单下发给页尾脚本: 行内编辑与"生成 INSERT/UPDATE"都要跳过它们(展示值已打码, 照抄会覆盖真值)
  const sensitiveHolder = `<span hidden data-sensitive-columns="${escapeHtml(SENSITIVE_COLUMN_NAMES.join(','))}"></span>`;
  const content = sensitiveHolder
    + costCard()
    + limitsCard()
    + `<div class="card mb-3"><div class="card-body">${await renderTableList(ctx.env, withCounts)}</div></div>`
    + (table ? `<div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      ${filterButtons({
    baseUrl: PAGE_URL, param: 'view', active: view, label: '按视图切换',
    extra: { table }, items: VIEWS
  })}
      <span class="ms-auto">${link(buildListUrl(PAGE_URL, { filters: { counts: countsParam === '0' ? '0' : '' } }), '返回表清单')}</span>
    </div>` : '')
    // 字段总览既能"只看一张表"(?table=), 也能"全库一屏"(不传 table)
    + (view === 'columns'
      ? await renderColumns(ctx, table)
      : (table
        ? (view === 'structure'
          ? await renderStructure(ctx, table)
          : await renderData(ctx, table, ctx.query))
        : ''))
    + sqlConsole();

  return adminLayout(Object.assign({}, ctx, {
    title: PAGE_TITLE,
    currentPage: 'db_tools',
    content: pageHeader({ icon: 'bi-database-gear', title: PAGE_TITLE }) + content,
    scripts: staticScript('js/db_tools.js', ctx.version)
  }));
}

// 页尾脚本已搬到 static/js/db_tools.js(2.5.0): 它是三处里最长的一段(约 570 行), 搬出去才有语法检查;
// 引脚本标签见下面 renderPage 的 scripts(带 ?v= 版本号)。

// 表详情(JSON): 与旧站 /admin/db_manage/table 同形状; 2.2.7 起额外接受排序/筛选/搜索参数,
// 2.2.8 起**新增可选参数 rowid=**(取单行完整数据, 供页面"取完整行"按钮用; 不传时行为与之前完全一致)
async function tableJson(ctx) {
  if (!ctx.session.isSuper) return json({ code: 403, msg: '该操作仅超级管理员可执行' });
  if (!settings(ctx.env).enableSqlTool) return json({ code: 403, msg: '数据库工具未开启' });
  const name = strOf(ctx.query.table || ctx.query.name);
  const rowid = strOf(ctx.query.rowid);
  if (rowid) {
    const single = await tableRow(ctx.env, name, rowid);
    if (!single.ok) return json({ code: 404, msg: single.reason });
    return json({ code: 200, data: {
      name: single.name,
      rowid: Number(rowid),
      row: single.row,
      row_keys: single.rowKeys,
      pk_columns: single.pkColumns,
      single: true
    } });
  }
  // 2.2.9 新增可选参数 rowids=1,2,3: 批量"复制所选行"用 —— **一条** `rowid IN (…)` 取回(最多 50 行),
  // 不传时行为与之前完全一致(仍走下面的分页查询)
  const rowids = strOf(ctx.query.rowids);
  if (rowids) {
    const picked = await tableRows(ctx.env, name, rowids.split(','));
    if (!picked.ok) return json({ code: 404, msg: picked.reason });
    return json({ code: 200, data: {
      name: picked.name,
      rows: picked.rows,
      row_keys: picked.rowKeys,
      pk_columns: picked.pkColumns,
      stats: picked.stats,
      multi: true
    } });
  }
  const data = await tablePage(ctx.env, name, strOf(ctx.query.page) || 1, strOf(ctx.query.page_size) || PAGE_SIZES[0], {
    sort: strOf(ctx.query.sort), dir: strOf(ctx.query.dir),
    column: strOf(ctx.query.col), value: strOf(ctx.query.val), q: strOf(ctx.query.q)
  });
  if (!data.ok) return json({ code: 404, msg: data.reason });
  const meta = await tableMeta(ctx.env, name);
  return json({ code: 200, data: {
    name: data.name,
    columns: meta.ok ? meta.columns : [],
    indexes: meta.ok ? meta.indexes : [],
    rows: data.rows,
    row_keys: data.rowKeys,
    total: data.total,
    page: data.page,
    pages: data.pages,
    page_size: data.page_size,
    sort: data.sort,
    dir: data.dir,
    column: data.column,
    value: data.value,
    q: data.q,
    has_rowid: data.hasRowid
  } });
}

// 执行 SQL(JSON): 复用唯一安全内核; 写语句必须 confirm=1(后端再验, 防绕过前端)
async function execHandler(ctx) {
  if (!ctx.session.isSuper) return json({ code: 403, msg: '该操作仅超级管理员可执行' });
  if (!settings(ctx.env).enableSqlTool) return json({ code: 403, msg: '数据库工具未开启' });

  const body = ctx.form && Object.keys(ctx.form).length ? ctx.form : ctx.body || {};
  const sql = strOf(body.sql);
  const confirmed = String(body.confirm || '') === '1';
  if (!sql) return json({ code: 400, msg: '请输入要执行的 SQL' });
  const verdict = classifyStatement(sql);
  if (verdict.kind === 'write' && !confirmed) {
    return json({ code: 403, msg: '写操作需要二次确认：请在前端确认后重试' });
  }

  const result = await runStatement(ctx.env, sql);
  const username = ctx.session.username;
  if (result.error) {
    auditLog('admin.db_manage', { username, sql: sql.slice(0, 300), ok: false, detail: result.detail || '' });
    return json({ code: 400, msg: result.error, detail: result.detail || '' });
  }
  auditLog('admin.db_manage', {
    username, sql: sql.slice(0, 300), ok: true,
    affected: result.affected, cost_ms: result.costMs, danger: Boolean(verdict.danger)
  });
  return json({ code: 200, msg: result.message, data: {
    ran: result.ran,
    row_keys: result.rowKeys,
    rows: result.rows,
    affected: result.affected,
    cost_ms: result.costMs,
    // D1 的用量(rows_read/rows_written/duration): 页面拿它显示"这次查询花了多少", 做成本估算
    stats: result.stats || null,
    truncated: Boolean(result.truncated),
    warning: result.warning || ''
  } });
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: ALIAS_URL, handler: pageHandler },
  { methods: ['GET', 'HEAD'], path: PAGE_URL, handler: pageHandler },
  // 旧站是 /admin/db_manage/table; 后台分发是精确匹配, 这里登记两个写法都能用
  { methods: ['GET', 'HEAD'], path: '/admin/db_manage/table', handler: tableJson },
  { methods: ['GET', 'HEAD'], path: '/admin/db_manage_table_json', handler: tableJson },
  { methods: ['POST'], path: '/admin/db_manage/exec', handler: execHandler }
];
