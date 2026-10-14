// 通知公告: 列表(搜索 + 触底分页) / 行片段 / 新增编辑 / 删除
// 逐条对齐旧站 fastapi/app/admin/notices.py
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { targetsList, targetsMark } from '../../core/notice_targets.js';
import { beijingNow } from '../../core/timeutil.js';
import { assetUrl } from '../../core/media_scheme.js';
import { adminLayout } from '../lib/layout.js';
import {
  addButton, editShell, emptyRow, filterButtons, hiddenField, listShell, numberField, pagerScript, searchBar,
  searchInput, searchSelect, selectField, staticScript, switchField, textareaField, textField
} from '../lib/partials.js';
import { statusButtons, statusCell } from '../lib/status.js';
import { listController } from '../lib/listPage.js';
import {
  PER_PAGE, auditLog, buildListUrl, clampPage, intOr,
  invalidateEntityCache, normalizeDatetime, positiveId, strOf, textOf
} from '../lib/utils.js';
import { json, redirect } from '../lib/http.js';

const MANAGE_URL = '/admin/notice_manage';
const LEVELS = [['info', '公告'], ['warning', '提醒'], ['important', '重要']];
const LEVEL_LABELS = Object.fromEntries(LEVELS);
const LEVEL_BADGES = { important: 'danger', warning: 'warning', info: 'secondary' };
const DEFAULT_LEVEL = 'info';
// 接收人(2.5.9): 值必须与 core/user_notice.js 的"指定用户"(3)以及小程序端可见性口径一致
const RECEIVERS = [[0, '所有用户'], [1, '内部测试用户'], [2, '普通用户'], [3, '指定用户']];
const RECEIVER_LABELS = Object.fromEntries(RECEIVERS);
const RECEIVER_BADGES = { 0: 'secondary', 1: 'danger', 2: 'info', 3: 'primary' };
const RECEIVER_ALL = 0;
const RECEIVER_PICKED = 3;
// 搜人结果封顶: 够"按昵称搜出某个人"用, 又不至于一次渲染几百行
const PICKER_LIMIT = 20;
const PICKER_COLUMNS = 'id,nickname,username,avatar,is_trusted';
// 一次最多指定多少位收件人(2.6.0): 够运营用, 同时挡住"有人把全站用户都勾上"那种提交 ——
// 收件人存成逗号串(见 core/notice_targets.js), 没有上限的话一条公告能把这列撑到几百 KB
const MAX_TARGETS = 200;
// 批量删除(2.6.1): 一次最多删多少条 —— 与笔记页同一个上限(BATCH_MAX), 挡住"全库勾一遍"的提交
const BATCH_MAX = 200;
const BATCH_URL = '/admin/notice_batch_delete';
// 首列是批量操作的"全选"复选框: 走 listShell 的 { html: true } 列, 否则会被转义成源码文本
const COLUMNS = [
  { label: '<input type="checkbox" id="rowCheckAll" aria-label="全选">', html: true },
  'ID', '标题', '类型', '接收人', '生效时间', '排序', '状态', '操作'
];

// 页面路径前缀: 公告的"跳转页面"只接受小程序页面, 与旧站 catalog.is_page_path 同口径
const PAGE_PREFIXES = ['/pages/', '/subpackages/'];
const isPagePath = (value) => PAGE_PREFIXES.some((prefix) => strOf(value).startsWith(prefix));

// 列表筛选参数(唯一解析点): 列表页与行片段必须解析同一份, 否则触底加载出来的行与首屏不是同一批
function parseFilters(source) {
  const receiver = ['0', '1', '2', '3'].includes(strOf(source.receiver)) ? strOf(source.receiver) : 'all';
  return { keyword: strOf(source.keyword), status: strOf(source.status), receiver };
}

// 只按标题搜: 正文几百字, 全表 LIKE 慢(旧站也是这个取舍)
function noticeWhere(filters) {
  const clauses = [];
  const args = [];
  const keyword = filters.keyword;
  if (keyword) {
    clauses.push('title LIKE ?');
    args.push(`%${keyword}%`);
  }
  if (filters.status === '1' || filters.status === '0') {
    clauses.push('status = ?');
    args.push(intOr(filters.status, 0));
  }
  if (filters.receiver !== 'all') {
    clauses.push('receiver_type = ?');
    args.push(intOr(filters.receiver, RECEIVER_ALL));
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', args };
}

// 指定用户的公告要在列表里显示"发给谁": 一次把这页涉及的收件人昵称查回来(避免每行一条 SQL)
async function receiversOf(env, rows) {
  const ids = [];
  (rows || []).forEach((row) => {
    if (intOr(row.receiver_type, RECEIVER_ALL) !== RECEIVER_PICKED) return;
    targetsList(row.target_user_ids).forEach((id) => {
      if (ids.indexOf(id) === -1) ids.push(id);
    });
  });
  if (!ids.length) return {};
  const marks = ids.map(() => '?').join(',');
  const list = await all(env, `SELECT id,nickname,username FROM users WHERE id IN (${marks})`, ...ids);
  const map = {};
  list.forEach((user) => {
    map[String(user.id)] = strOf(user.nickname) || strOf(user.username) || ('用户#' + user.id);
  });
  return map;
}

// 接收人单元格: 类型徽章 + (指定用户时)收件人昵称(可多个, 超过 3 位折成"等 N 人");
// 用户已不在库里时把 id 显出来, 免得看起来"没接收人"; 一位都没选是**异常数据**(存不进去, 但老库可能有), 直接标红
function receiverCell(row, receivers) {
  const type = intOr(row.receiver_type, RECEIVER_ALL);
  const label = RECEIVER_LABELS[type] || RECEIVER_LABELS[RECEIVER_ALL];
  const badge = `<span class="badge text-bg-${RECEIVER_BADGES[type] || 'secondary'}">${escapeHtml(label)}</span>`;
  if (type !== RECEIVER_PICKED) return badge;
  const ids = targetsList(row.target_user_ids);
  if (!ids.length) return `${badge}<div class="small text-danger">未选收件人</div>`;
  const names = ids.map((id) => (receivers || {})[String(id)] || ('用户#' + id + '（已删除）'));
  const shown = names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 人` : names.join('、');
  return `${badge}<div class="small text-muted text-truncate" title="${escapeHtml(names.join('、'))}">`
    + `${escapeHtml(shown)} <span class="text-muted">#${ids.join(',#')}</span></div>`;
}

// 时间归一化走 lib/utils.js 的唯一实现(normalizeDatetime): 本页以前自己又抄了一份,
// 两份口径一旦不一致, "设了开始时间的公告永不展示"这个老坑就会以另一种形式回来
function fmtTime(value) {
  const text = strOf(value);
  return text ? text.slice(0, 16) : '不限';
}

// 公告的状态单元格比别处多一层"生效时间"提示: 徽章走共用实现, 提示文案是本页特有
function statusCellWithNotes(ctx, row) {
  const notes = [];
  const now = beijingNow();
  if (intOr(row.status, 0) !== 1) notes.push('<span class="text-danger">已停用，小程序不显示</span>');
  else if (strOf(row.start_at) && strOf(row.start_at) > now) notes.push('<span class="text-muted">未到生效时间</span>');
  else if (strOf(row.end_at) && strOf(row.end_at) < now) notes.push('<span class="text-muted">已过生效时间</span>');
  const badge = statusCell('app_notice', row);
  return badge + (notes.length ? '<div class="small mt-1">' + notes.join('<br>') + '</div>' : '');
}

function actionsCell(ctx, row) {
  const page = clampPage(ctx.query.page, null);
  const buttons = statusButtons('app_notice', row);
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/notice_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=notice&amp;id=${row.id}&amp;page=${page}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

export function renderRows(ctx, rows, receivers) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '暂无公告');
  return rows.map((row) => {
    const level = LEVEL_LABELS[strOf(row.level)] ? strOf(row.level) : DEFAULT_LEVEL;
    const link = strOf(row.link_value);
    const title = escapeHtml(row.title || '-');
    const linkHtml = link
      ? `<div class="small text-muted text-truncate"><code>${escapeHtml(link)}</code> <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></div>`
      : '';
    return `<tr>
  <td><input type="checkbox" class="form-check-input rowCheck" value="${row.id}" aria-label="选择公告 ${row.id}"></td>
  <td class="text-nowrap">${row.id}</td>
  <td><div class="text-truncate clamp-lg" title="${escapeHtml(row.title || '')}">${title}</div>${linkHtml}</td>
  <td class="text-nowrap"><span class="badge text-bg-${LEVEL_BADGES[level]}">${escapeHtml(LEVEL_LABELS[level])}</span></td>
  <td class="text-nowrap">${receiverCell(row, receivers)}</td>
  <td class="text-nowrap small">${escapeHtml(fmtTime(row.start_at))} ~ ${escapeHtml(fmtTime(row.end_at))}</td>
  <td class="text-nowrap">${row.sort_order}</td>
  <td class="text-nowrap">${statusCellWithNotes(ctx, row)}</td>
  <td class="text-nowrap">${actionsCell(ctx, row)}</td>
</tr>`;
  }).join('');
}

// 批量区(2.6.1): 勾选多行后按 action 提交, 同时把当前的筛选与页码带回 ——
// 结构与笔记页的 batchBar 一致(同一套 id: batchForm/batchIds/rowCheck, 因此能共用 static/js/news_batch.js),
// data-unit 只用于把脚本里的提示文案与二次确认换成"公告"(脚本拿不到该属性时默认按"笔记")。
// 二次确认不写在这里的 onsubmit: 脚本是用 form.submit() 提交的, 那条路径**不触发** onsubmit, 确认由脚本自己做。
function batchBar(ctx) {
  const filters = parseFilters(ctx.query);
  return `<form method="post" action="${BATCH_URL}" id="batchForm" data-unit="公告"
  class="d-flex flex-wrap align-items-center gap-2 mb-3 border rounded p-2">
  <input type="hidden" name="ids" id="batchIds">
  <input type="hidden" name="keyword" value="${escapeHtml(filters.keyword)}">
  <input type="hidden" name="status" value="${escapeHtml(filters.status)}">
  <input type="hidden" name="receiver" value="${escapeHtml(filters.receiver)}">
  <input type="hidden" name="page" value="${clampPage(ctx.query.page, null)}">
  <span class="small text-muted">批量操作</span>
  <button class="btn btn-sm btn-outline-danger" type="button" data-batch="delete">删除所选</button>
</form>`;
}

async function managePage(ctx) {
  const filters = parseFilters(ctx.query);
  const where = noticeWhere(filters);
  // 取数 + 分页骨架走公共实现(lib/listPage.js)
  const { total, totalPages, page, rows, error } = await listController(ctx, {
    table: 'app_notices', where, orderBy: 'sort_order ASC, id DESC', label: '获取公告列表'
  });
  // 搜索条: 共用实现(顺序统一为"下拉 → 输入框 → 搜索按钮"); 参数名 status/keyword 与取值不变
  const searchForm = searchBar({
    action: MANAGE_URL,
    body: searchSelect({
      name: 'status', value: filters.status,
      items: [['all', '全部状态'], ['1', '启用'], ['0', '停用']]
    }) + searchInput({ name: 'keyword', value: filters.keyword, placeholder: '按标题搜索' })
  });
  // 接收人筛选(2.5.9): 走 2.2.6 的统一实现(按钮组, 基准 = 留言管理页);
  // 与搜索表单共存, 切换时把 status/keyword 一起带上, 免得筛完接收人把关键字筛丢了
  const receiverFilter = filterButtons({
    param: 'receiver', active: filters.receiver, baseUrl: MANAGE_URL, label: '按接收人筛选',
    extra: { status: filters.status, keyword: filters.keyword },
    items: [['all', '全部接收人']].concat(RECEIVERS.map(([value, label]) => [String(value), label]))
  });
  const content = batchBar(ctx) + listShell({
    title: '通知公告', columns: COLUMNS, rows: renderRows(ctx, rows, await receiversOf(ctx.env, rows)),
  tableAttrs: ' data-status-filter-param="status"',
    // 2.3.3 三行结构: ① 添加公告 ② 接收人筛选(2.5.9) ③ 搜索表单(关键字 + 状态下拉)
    actions: addButton('/admin/notice_edit?id=0', '添加公告'),
    filters: receiverFilter,
    search: searchForm,
    tbodyId: 'noticeTbody', sentinelId: 'noticeLoadMore', textId: 'noticeLoadMoreText',
    hintId: 'noticeLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '条', backTopId: 'noticeBackTopBtn', jumpBtnId: 'noticeJumpBtn', jumpInputId: 'noticeJumpInput'
  });
  return adminLayout({
    title: '通知公告管理', currentPage: 'notice_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'noticeTbody', sentinelId: 'noticeLoadMore', textId: 'noticeLoadMoreText',
      rowsUrl: '/admin/notice_rows', currentPage: page, totalPages, total, perPage: PER_PAGE,
      unit: '条', hintId: 'noticeLoadedHint', announceLabel: '公告', baseUrl: MANAGE_URL,
      backTopId: 'noticeBackTopBtn', jumpBtnId: 'noticeJumpBtn', jumpInputId: 'noticeJumpInput',
      // 触底加载靠"本页有没有 rowCheck"判断是不是空页: 公告列表也有勾选框了(2.6.1), 必须传
      rowMarker: 'rowCheck', version: ctx.version
    }) + staticScript('js/news_batch.js', ctx.version)
  });
}

async function rowsFragment(ctx) {
  const where = noticeWhere(parseFilters(ctx.query));
  const page = clampPage(ctx.query.page, null);
  let rows = [];
  try {
    rows = await all(ctx.env,
      `SELECT * FROM app_notices${where.sql} ORDER BY sort_order ASC, id DESC LIMIT ? OFFSET ?`,
      ...where.args, PER_PAGE + 1, (page - 1) * PER_PAGE);
  } catch (err) {
    console.error('获取公告分页数据失败', err && err.message);
    return json({ success: false, message: '加载失败，请稍后重试' });
  }
  const hasMore = rows.length > PER_PAGE;
  rows = rows.slice(0, PER_PAGE);
  if (!rows.length) return json({ success: true, rows: '', has_more: false });
  return json({ success: true, rows: renderRows(ctx, rows, await receiversOf(ctx.env, rows)), has_more: hasMore });
}

// 搜人(2.5.9, 仅超管用): 空关键词 = 最近注册的 20 个(打开页面就能直接挑), 有关键词 = 昵称/用户名模糊, 纯数字按 ID 精确
async function pickUsers(env, query) {
  const q = strOf(query).trim();
  try {
    if (!q) {
      return await all(env, `SELECT ${PICKER_COLUMNS} FROM users WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?`, PICKER_LIMIT);
    }
    if (/^\d+$/.test(q)) {
      return await all(env, `SELECT ${PICKER_COLUMNS} FROM users WHERE id = ?`, intOr(q, 0));
    }
    const like = `%${q}%`;
    return await all(env, `SELECT ${PICKER_COLUMNS} FROM users WHERE deleted_at IS NULL AND (nickname LIKE ? OR username LIKE ?) ORDER BY id DESC LIMIT ?`,
      like, like, PICKER_LIMIT);
  } catch (err) {
    console.error('搜索用户失败', err && err.message);
    return [];
  }
}

// 已选收件人可能不在当前搜索结果里(很早注册的账号, 或刚换了关键词): 按 id 单独查回来画"已选清单"。
// 只靠候选列表的话, 搜一次人就看不出这条公告现在到底发给谁(2.6.0 起还会用隐藏域把这些人带过表单, 见 receiverCard)
async function usersByIds(env, ids) {
  const list = (ids || []).filter((id) => id > 0);
  if (!list.length) return [];
  const marks = list.map(() => '?').join(',');
  return (await all(env, `SELECT ${PICKER_COLUMNS} FROM users WHERE id IN (${marks})`, ...list).catch(() => [])) || [];
}

async function editPage(ctx) {
  const noticeId = intOr(ctx.query.id, 0);
  const isNew = noticeId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;
  if (isNew) {
    row = {
      id: 0, title: '', content: '', level: DEFAULT_LEVEL, link_type: '', link_value: '',
      start_at: '', end_at: '', sort_order: 0, status: 1, receiver_type: RECEIVER_ALL, target_user_ids: ''
    };
  } else {
    row = await one(ctx.env, 'SELECT * FROM app_notices WHERE id = ?', noticeId).catch(() => null);
    if (!row) return editView(ctx, { isNew: false, row: null, error: '找不到该公告', errorField: '' });
  }

  // 接收人只在超管可见可改(要求: 编辑与用户选择仅超管)
  const canPick = !!ctx.session.isSuper;
  // 库里的原值: 非超管提交时必须原样保留 —— 否则普通管理员改一次正文就把定向公告重置成"所有用户"
  const storedIds = targetsList(row.target_user_ids);
  let pickedIds = storedIds;      // 界面上"已选"的那批(未 POST 时 = 库里的值)
  let userQuery = '';

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const title = strOf(form.title);
    const content = textOf(form.content);
    const level = strOf(form.level) || DEFAULT_LEVEL;
    const linkValue = strOf(form.link_value);
    const startAt = normalizeDatetime(form.start_at);
    const endAt = normalizeDatetime(form.end_at);
    const sortOrder = intOr(form.sort_order, 0);
    const status = form.status ? 1 : 0;
    // link_type 由 link_value 派生(不是表单字段)
    const linkType = isPagePath(linkValue) ? 'page' : '';
    const postedType = intOr(form.receiver_type, RECEIVER_ALL);
    const receiverType = canPick && RECEIVER_LABELS[postedType] !== undefined
      ? postedType
      : intOr(row.receiver_type, RECEIVER_ALL);
    // 收件人在表单里是**同名多值**(勾选的复选框 + "搜索结果外那几位"的隐藏域), readForm 按提交顺序拼成逗号串
    const postedIds = canPick ? targetsList(form.target_user_id) : storedIds;
    // 「移除」按钮自带 remove_user_id=要摘掉的那位: 同样只重画本页, 不落库
    const removedId = canPick ? intOr(form.remove_user_id, 0) : 0;
    const chosenIds = postedIds.filter((id) => id !== removedId);
    // 界面画的始终是"当前勾了谁"(在类型之间来回切不会把已选弄没); 真正落库的值另算:
    //   非超管 → 原样保留库里的; 类型=指定用户 → 勾了谁存谁; 其它类型 → 清空(与 2.5.9 同一口径)
    pickedIds = canPick ? chosenIds : storedIds;
    const savedIds = canPick ? (receiverType === RECEIVER_PICKED ? chosenIds : []) : storedIds;
    userQuery = strOf(form.user_q);
    row = {
      id: noticeId, title, content, level, link_type: linkType, link_value: linkValue,
      start_at: startAt, end_at: endAt, sort_order: sortOrder, status,
      receiver_type: receiverType, target_user_ids: targetsMark(savedIds)
    };

    // 「搜索用户」与每位收件人后面的「移除」都是表单里的普通提交按钮(自己带 name/value):
    // 拿着当前草稿重画一次页面, 不校验也不落库 —— 后台不引入弹窗/AJAX 那一套(素材库是唯一例外)
    if (strOf(form.action) === 'search_user' || removedId) {
      return renderEdit({ error: '', errorField: '' });
    }

    if (!title) {
      error = '请填写公告标题';
      errorField = 'title';
    } else if (!LEVEL_LABELS[level]) {
      error = '公告类型不正确';
      errorField = 'level';
    } else if (linkValue && !linkType) {
      error = '跳转页面必须以 /pages/ 或 /subpackages/ 开头, 或留空表示不跳转';
      errorField = 'link_value';
    } else if (startAt && endAt && startAt > endAt) {
      error = '生效开始时间不能晚于结束时间';
      errorField = 'end_at';
    // 收件人的两条校验只对超管生效: 非超管根本没有这个控件(页面上只有一行只读文案), 报出来他也没法处理 ——
    // 而且非超管的 savedIds 是库里的原值, 拿脏数据(类型=3 但收件人为空的老行)把他卡住是说不通的
    } else if (canPick && receiverType === RECEIVER_PICKED && !savedIds.length) {
      error = '接收人选择「指定用户」时必须至少选一位用户';
      errorField = 'receiver_type';
    } else if (canPick && savedIds.length > MAX_TARGETS) {
      error = `指定用户一次最多选 ${MAX_TARGETS} 位`;
      errorField = 'receiver_type';
    }

    if (!error) {
      try {
        if (isNew) {
          await run(ctx.env,
            'INSERT INTO app_notices (title, content, level, link_type, link_value, start_at, end_at, sort_order, status, receiver_type, target_user_ids, create_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            title, content, level, linkType, linkValue, startAt, endAt, sortOrder, status, receiverType, targetsMark(savedIds), beijingNow());
        } else {
          await run(ctx.env,
            'UPDATE app_notices SET title=?, content=?, level=?, link_type=?, link_value=?, start_at=?, end_at=?, sort_order=?, status=?, receiver_type=?, target_user_ids=? WHERE id=?',
            title, content, level, linkType, linkValue, startAt, endAt, sortOrder, status, receiverType, targetsMark(savedIds), noticeId);
        }
        invalidateEntityCache('notice');
        auditLog(`admin.app_notice.${isNew ? 'create' : 'update'}`, {
          user: ctx.session.username, notice_id: noticeId, title, receiver_type: receiverType, target_count: savedIds.length
        });
        return redirect(buildListUrl(MANAGE_URL, { message: isNew ? '公告已添加' : '公告已更新' }));
      } catch (err) {
        console.error(`保存公告失败 id=${noticeId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return renderEdit({});

  // 画编辑页: 候选列表走搜索词, 已选清单按 id 查(两边互相独立, 少一个都不行)
  async function renderEdit(extra) {
    const pickedUsers = canPick ? await usersByIds(ctx.env, pickedIds) : [];
    const users = canPick ? await pickUsers(ctx.env, userQuery) : [];
    return editView(ctx, Object.assign(
      { isNew, row, error, errorField, users, userQuery, pickedIds, pickedUsers }, extra || {}
    ));
  }
}

// 接收人类型: **必须是单选按钮组, 不是下拉框** —— 「指定用户」那一段的显隐靠纯 CSS
// (`#noticeReceiver3:checked ~ .notice-picker`, 见 admin.css), 而 select 的选中项没法被纯 CSS 的兄弟选择器命中。
// 四个选项一眼看全也比下拉少一次点击。name/value 与 2.5.9 的下拉框完全一致(后端与筛选 UI 不用改)。
// **这四组 radio/label 必须平铺**、不套 .form-check 容器: `~` 只认同一父元素下的后续兄弟,
// 套一层容器就与 .notice-picker 隔了一层 —— 2.6.0 正是这么写的, 于是那条 CSS 永远命不中, 选「指定用户」什么都不出现。
function receiverRadios(current, errorField) {
  const bad = errorField === 'receiver_type';
  return RECEIVERS.map(([value, label]) => {
    const id = `noticeReceiver${value}`;
    const checked = intOr(current, RECEIVER_ALL) === value;
    return `<input class="form-check-input notice-radio${bad ? ' is-invalid' : ''}" type="radio" name="receiver_type" id="${id}" value="${value}"${checked ? ' checked' : ''}>
<label class="form-check-label notice-radio-label" for="${id}">${escapeHtml(label)}</label>`;
  }).join('\n');
}

// 头像小圆点: 没头像就用灰底占位(候选列表与已选清单共用, 免得"头像位忽大忽小")
function avatarDot(env, avatar) {
  const url = strOf(avatar);
  return url
    ? `<img src="${escapeHtml(assetUrl(env, url, ''))}" class="rounded-circle flex-shrink-0 notice-avatar" alt="" onerror="this.style.visibility='hidden'">`
    : '<span class="rounded-circle bg-secondary-subtle flex-shrink-0 notice-avatar"></span>';
}

function nameOfUser(user) {
  return strOf(user && user.nickname) || strOf(user && user.username) || '（无昵称）';
}

// 「接收人」控件(2.5.9 起, 仅超管; 2.6.0 起"指定用户"可多选)。
// 为什么不用弹窗 + AJAX(素材库那一套): 后台其余页面都是"整页重渲染"风格, 这里在同一个 form 里放两个普通提交按钮
// (搜索用户 / 每位已选后面的移除)就够了 —— 不加 JS、不加接口、不加静态资源(见 README 的"实现约定")。
// 显隐: 类型≠【指定用户】时这一段由 CSS 隐藏, 但**隐藏的控件照样会被提交** ——
// 所以后端在 receiver_type≠3 时一律忽略提交上来的 target_user_id(在 editPage 里做), 不靠前端"保证不提交"。
function receiverCard(env, { receiverType, pickedIds, pickedUsers, users, userQuery, errorField }) {
  const current = targetsList(pickedIds);
  const found = {};
  (pickedUsers || []).forEach((user) => { found[String(user.id)] = user; });
  // 已选清单(每位带「移除」): 顺序 = 勾选顺序; 用户已不在库里也照列, 否则这一位就再也摘不掉了
  const chips = current.map((id) => {
    const user = found[String(id)];
    const name = user ? nameOfUser(user) : `用户#${id}（已删除）`;
    return `<span class="badge text-bg-light border d-inline-flex align-items-center gap-1 me-1 mb-1 py-2">
  ${avatarDot(env, user && user.avatar)}
  <span>${escapeHtml(name)}<span class="text-muted small"> #${id}</span></span>
  <button class="btn btn-sm btn-outline-danger py-0 px-1 ms-1" type="submit" name="remove_user_id" value="${id}">移除</button>
</span>`;
  }).join('');

  // 候选列表(复选框, 可多选); 顺手记下"已选里哪些已经画在列表里了"
  const rendered = [];
  const rows = (users || []).map((user) => {
    const id = intOr(user.id, 0);
    const checked = current.indexOf(id) >= 0;
    if (checked) rendered.push(id);
    const tag = intOr(user.is_trusted, 0) === 1 ? '<span class="badge text-bg-danger ms-1">内部测试</span>' : '';
    return `<label class="d-flex align-items-center gap-2 border rounded p-2 mb-1 notice-user-option">
  <input class="form-check-input mt-0" type="checkbox" name="target_user_id" value="${id}"${checked ? ' checked' : ''}>
  ${avatarDot(env, user.avatar)}
  <span class="text-truncate">${escapeHtml(nameOfUser(user))}${tag}<span class="text-muted small"> #${id}</span></span>
</label>`;
  }).join('');
  // 已选但不在候选列表里的: 用隐藏域一起提交 —— 否则"搜一次人"或"摘下一位"之后, 他们会悄悄从收件人里掉出去
  const hidden = current.filter((id) => rendered.indexOf(id) === -1)
    .map((id) => hiddenField('target_user_id', id)).join('');

  return `<div class="card mb-3"><div class="card-body">
    <div class="form-label">接收人 <span class="text-muted small">（仅超级管理员可改）</span></div>
    <div class="small text-muted mb-1">发送给</div>
    ${receiverRadios(receiverType, errorField)}
    <div class="notice-picker mt-2">
      <div class="form-text mb-1">已选 ${current.length} 位${current.length
        ? '（点某一位后面的「移除」即可摘掉）'
        : '（勾选下面的用户，可多选）'}</div>
      ${chips ? `<div class="mb-2">${chips}</div>` : ''}
      <div class="input-group input-group-sm mb-2">
        ${searchInput({ name: 'user_q', value: userQuery || '', placeholder: '按昵称 / 用户名 / ID 搜人' })}
        <button class="btn btn-sm btn-outline-secondary" type="submit" name="action" value="search_user">搜索用户</button>
      </div>
      <div class="border rounded p-2 notice-user-list">
        ${rows || '<div class="text-muted small">没有匹配的用户，换个关键词试试。</div>'}
      </div>
    </div>
    ${hidden}
    <div class="form-text">最多列出 ${PICKER_LIMIT} 位（默认按 ID 倒序），一次最多指定 ${MAX_TARGETS} 位。点「搜索用户」只会重新加载本页，已填的标题与正文不会丢。用户只以 ID 记录，不会把 openid 写进公告或下发到小程序。</div>
  </div></div>`;
}

function editView(ctx, { isNew, row, error, errorField, users, userQuery, pickedIds, pickedUsers }) {
  if (!row) {
    return adminLayout({
      title: '编辑公告', currentPage: 'notice_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该公告',
      content: '<div class="card"><div class="card-body">找不到该公告，可能已被删除。</div></div>'
    });
  }
  const main = textField({
    name: 'title', label: '公告标题', value: row.title, required: true, maxlength: 100,
    placeholder: '如 系统维护通知', errorField
  }) + textareaField({
    name: 'content', label: '公告正文', value: row.content, rows: 8, errorField
  }) + textField({
    name: 'link_value', label: '跳转页面', value: row.link_value, maxlength: 500, errorField,
    placeholder: '小程序页面路径，如 /pages/notice/notice?id=1（留空表示不跳转）'
  }) + (ctx.session.isSuper
    ? receiverCard(ctx.env, {
      receiverType: intOr(row.receiver_type, RECEIVER_ALL),
      pickedIds, pickedUsers, users, userQuery, errorField
    })
    // 非超管: 只读告知, 免得"我编辑了公告却不知道它只发给某些人"
    : `<div class="form-text">接收人：${escapeHtml(RECEIVER_LABELS[intOr(row.receiver_type, RECEIVER_ALL)] || RECEIVER_LABELS[RECEIVER_ALL])}（仅超级管理员可修改）</div>`);
  const side = selectField({ name: 'level', label: '公告类型', options: LEVELS, value: row.level, errorField })
    + textField({ name: 'start_at', label: '生效开始时间', value: row.start_at, errorField, placeholder: 'YYYY-MM-DD HH:MM' })
    + textField({ name: 'end_at', label: '生效结束时间', value: row.end_at, errorField, placeholder: 'YYYY-MM-DD HH:MM' })
    + numberField({ name: 'sort_order', label: '排序 (小在前)', value: row.sort_order, errorField })
    + switchField({ name: 'status', label: '立即启用', checked: intOr(row.status, 0) === 1 });
  const content = editShell({
    action: `/admin/notice_edit${isNew ? '' : `?id=${row.id}`}`,
    main, side, backUrl: MANAGE_URL, backLabel: '返回列表',
    primaryLabel: isNew ? '添加公告' : '保存修改'
  });
  return adminLayout({
    title: '编辑公告', currentPage: 'notice_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content
  });
}

// 删除公告的唯一实现(2.6.1): 先清已读记录、再删公告。
// 顺序不能反 —— 公告一删就再也查不出该清哪些 notice_id, 留下的孤儿行会让**将来同 id 的新公告**"没读过却已是已读"。
// 单条删除与批量删除都走这里: 各写一遍迟早有一处忘了清, 而 app_notice_reads 没有外键, 数据库不会替你拦。
async function purgeNotices(env, ids) {
  const list = (ids || []).filter((id) => id > 0);
  if (!list.length) return;
  const marks = list.map(() => '?').join(',');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM app_notice_reads WHERE notice_id IN (${marks})`).bind(...list),
    env.DB.prepare(`DELETE FROM app_notices WHERE id IN (${marks})`).bind(...list)
  ]);
}

async function deleteSubmit(ctx) {
  const rawId = ctx.form.id;
  if (!positiveId(rawId)) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误' }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT title FROM app_notices WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该公告' }));
    await purgeNotices(ctx.env, [intOr(rawId, 0)]);
    auditLog('admin.app_notice.delete', { user: ctx.session.username, notice_id: intOr(rawId, 0), title: row.title || '' });
    invalidateEntityCache('notice');
    message = '公告已删除';
  } catch (err) {
    console.error(`删除公告失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试' }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message }));
}

// 批量删除(2.6.1): 与笔记页同一套做法(勾选 → 脚本把 id 拼进隐藏域 → 一个 POST 端点),
// 但**多清一张表**: app_notice_reads 是"用户读过哪条公告"的附属记录(全库无外键, 必须应用层级联),
// 不一起删就留下孤儿行 —— 同一条 notice_id 被将来的新公告复用时, 用户会看到"没读过却已是已读"。
async function batchSubmit(ctx) {
  const form = ctx.form;
  const filters = { keyword: strOf(form.keyword), status: strOf(form.status), receiver: strOf(form.receiver) };
  const page = strOf(form.page) || null;
  // ids 是一个逗号串(不是同名多值: 隐藏域只有一个), 去重 + 丢非法值 + 封顶, 与笔记页同口径
  const ids = Array.from(new Set(strOf(form.ids).split(',')
    .map((item) => intOr(item.trim(), 0)).filter((id) => id > 0))).slice(0, BATCH_MAX);
  if (!ids.length) {
    return redirect(buildListUrl(MANAGE_URL, { error: '没有选中任何公告', filters, page }));
  }
  let message = '';
  try {
    // 先查一遍还在的 id: 勾了之后被别人删掉的那些要跳过, 否则 DELETE 的 changes 对不上, 也没法告诉用户跳了几条
    const marks = ids.map(() => '?').join(',');
    const found = await all(ctx.env, `SELECT id FROM app_notices WHERE id IN (${marks})`, ...ids);
    const valid = found.map((item) => intOr(item.id, 0)).filter((id) => id > 0);
    if (!valid.length) {
      return redirect(buildListUrl(MANAGE_URL, { error: '选中的公告都已不存在（可能已被其他人删除）', filters, page }));
    }
    await purgeNotices(ctx.env, valid);
    invalidateEntityCache('notice');
    auditLog('admin.app_notice.batch_delete', {
      user: ctx.session.username, count: valid.length, ids: valid.join(',')
    });
    message = `已删除 ${valid.length} 条公告`;
    const missing = ids.length - valid.length;
    if (missing > 0) message += `，另有 ${missing} 条已不存在已跳过`;
  } catch (err) {
    console.error('批量删除公告失败', err && err.stack ? err.stack : err);
    return redirect(buildListUrl(MANAGE_URL, { error: '批量删除失败，请稍后重试', filters, page }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, filters, page }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'HEAD'], path: '/admin/notice_rows', handler: rowsFragment },
  { methods: ['GET', 'POST'], path: '/admin/notice_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/notice_delete', handler: deleteSubmit },
  { methods: ['POST'], path: BATCH_URL, handler: batchSubmit }
];
