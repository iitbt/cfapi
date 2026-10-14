// 通知公告: 列表(搜索 + 触底分页) / 行片段 / 新增编辑 / 删除
// 逐条对齐旧站 fastapi/app/admin/notices.py
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { beijingNow } from '../../core/timeutil.js';
import { assetUrl } from '../../core/media_scheme.js';
import { adminLayout } from '../lib/layout.js';
import {
  addButton, editShell, emptyRow, filterButtons, hiddenField, listShell, numberField, pagerScript, searchBar,
  searchInput, searchSelect, selectField, switchField, textareaField, textField
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
const COLUMNS = ['ID', '标题', '类型', '接收人', '生效时间', '排序', '状态', '操作'];

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
    const id = intOr(row.target_user_id, 0);
    if (intOr(row.receiver_type, RECEIVER_ALL) === RECEIVER_PICKED && id > 0 && ids.indexOf(id) === -1) ids.push(id);
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

// 接收人单元格: 类型徽章 + (指定用户时)收件人昵称; 用户已不在库里时把 id 显出来, 免得看起来"没接收人"
function receiverCell(row, receivers) {
  const type = intOr(row.receiver_type, RECEIVER_ALL);
  const label = RECEIVER_LABELS[type] || RECEIVER_LABELS[RECEIVER_ALL];
  const badge = `<span class="badge text-bg-${RECEIVER_BADGES[type] || 'secondary'}">${escapeHtml(label)}</span>`;
  if (type !== RECEIVER_PICKED) return badge;
  const id = intOr(row.target_user_id, 0);
  const name = (receivers || {})[String(id)] || ('用户#' + id + '（已删除）');
  return `${badge}<div class="small text-muted text-truncate">${escapeHtml(name)} #${id}</div>`;
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
  const content = listShell({
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
      version: ctx.version
    })
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

// 当前选中的收件人可能不在搜索结果里(比如是很早注册的账号): 单独查出来置顶,
// 否则用户列表里没有一个被选中, 界面上根本看不出"这条公告现在发给谁"
async function withPickedUser(env, users, pickedId) {
  const list = users || [];
  const id = intOr(pickedId, 0);
  if (!id || list.some((item) => intOr(item.id, 0) === id)) return list;
  const picked = await one(env, `SELECT ${PICKER_COLUMNS} FROM users WHERE id = ?`, id).catch(() => null);
  return picked ? [picked].concat(list) : list;
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
      start_at: '', end_at: '', sort_order: 0, status: 1, receiver_type: RECEIVER_ALL, target_user_id: null
    };
  } else {
    row = await one(ctx.env, 'SELECT * FROM app_notices WHERE id = ?', noticeId).catch(() => null);
    if (!row) return editView(ctx, { isNew: false, row: null, error: '找不到该公告', errorField: '' });
  }

  // 接收人只在超管可见可改(要求: 编辑与用户选择仅超管)
  const canPick = !!ctx.session.isSuper;
  let pickedId = intOr(row.target_user_id, 0);
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
    // 接收人: 非超管提交时**保留库里的原值** —— 否则普通管理员改一次正文就会把定向公告重置成"所有用户"
    const postedType = intOr(form.receiver_type, RECEIVER_ALL);
    const receiverType = canPick && RECEIVER_LABELS[postedType] !== undefined
      ? postedType
      : intOr(row.receiver_type, RECEIVER_ALL);
    const postedTarget = intOr(form.target_user_id, 0);
    // 类型不是"指定用户"时清掉收件人; 是指定时没勾任何人就沿用原值(在类型之间来回切不会丢掉已选的谁)
    const targetUserId = receiverType === RECEIVER_PICKED
      ? (postedTarget || pickedId || 0)
      : (canPick ? 0 : pickedId);
    pickedId = postedTarget || targetUserId;
    userQuery = strOf(form.user_q);
    row = {
      id: noticeId, title, content, level, link_type: linkType, link_value: linkValue,
      start_at: startAt, end_at: endAt, sort_order: sortOrder, status,
      receiver_type: receiverType, target_user_id: targetUserId || null
    };

    // 「搜索用户」是表单里的一个普通提交按钮(name=action value=search_user):
    // 拿着当前草稿重画一次页面, 不校验也不落库 —— 后台不引入弹窗/AJAX 那一套(素材库是唯一例外)
    if (strOf(form.action) === 'search_user') {
      const users = await withPickedUser(ctx.env, await pickUsers(ctx.env, userQuery), pickedId);
      return editView(ctx, { isNew, row, error: '', errorField: '', users, userQuery });
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
    } else if (receiverType === RECEIVER_PICKED && !targetUserId) {
      error = '接收人选择「指定用户」时必须选一位用户';
      errorField = 'receiver_type';
    }

    if (!error) {
      try {
        if (isNew) {
          await run(ctx.env,
            'INSERT INTO app_notices (title, content, level, link_type, link_value, start_at, end_at, sort_order, status, receiver_type, target_user_id, create_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            title, content, level, linkType, linkValue, startAt, endAt, sortOrder, status, receiverType, targetUserId || null, beijingNow());
        } else {
          await run(ctx.env,
            'UPDATE app_notices SET title=?, content=?, level=?, link_type=?, link_value=?, start_at=?, end_at=?, sort_order=?, status=?, receiver_type=?, target_user_id=? WHERE id=?',
            title, content, level, linkType, linkValue, startAt, endAt, sortOrder, status, receiverType, targetUserId || null, noticeId);
        }
        invalidateEntityCache('notice');
        auditLog(`admin.app_notice.${isNew ? 'create' : 'update'}`, { user: ctx.session.username, notice_id: noticeId, title, receiver_type: receiverType });
        return redirect(buildListUrl(MANAGE_URL, { message: isNew ? '公告已添加' : '公告已更新' }));
      } catch (err) {
        console.error(`保存公告失败 id=${noticeId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  const users = canPick ? await withPickedUser(ctx.env, await pickUsers(ctx.env, userQuery), pickedId) : [];
  return editView(ctx, { isNew, row, error, errorField, users, userQuery });
}

// 「接收人」控件(2.5.9, 仅超管): 类型下拉 + 搜人/选人列表。
// 为什么不用弹窗 + AJAX(素材库那一套): 后台其余页面都是"整页重渲染"风格,
// 这里只要在同一个 form 里放一个 name=action value=search_user 的提交按钮就够了 —— 不加 JS、不加接口、不加静态资源。
function receiverCard(env, { receiverType, pickedId, users, userQuery }) {
  const current = intOr(pickedId, 0);
  const rows = (users || []).map((user) => {
    const id = intOr(user.id, 0);
    const avatar = strOf(user.avatar);
    const avatarHtml = avatar
      ? `<img src="${escapeHtml(assetUrl(env, avatar, ''))}" class="rounded-circle flex-shrink-0" style="width:32px;height:32px;object-fit:cover" alt="" onerror="this.style.visibility='hidden'">`
      : '<span class="rounded-circle bg-secondary-subtle flex-shrink-0" style="width:32px;height:32px;display:inline-block"></span>';
    const name = strOf(user.nickname) || strOf(user.username) || '（无昵称）';
    const tag = intOr(user.is_trusted, 0) === 1 ? '<span class="badge text-bg-danger ms-1">内部测试</span>' : '';
    return `<label class="d-flex align-items-center gap-2 border rounded p-2 mb-1" style="cursor:pointer">
  <input class="form-check-input mt-0" type="radio" name="target_user_id" value="${id}"${id === current ? ' checked' : ''}>
  ${avatarHtml}
  <span class="text-truncate">${escapeHtml(name)}${tag}<span class="text-muted small"> #${id}</span></span>
</label>`;
  }).join('');
  return `<div class="card mb-3"><div class="card-body">
    <div class="form-label">接收人 <span class="text-muted small">（仅超级管理员可改）</span></div>
    ${selectField({
      name: 'receiver_type', label: '发送给', value: String(intOr(receiverType, RECEIVER_ALL)), errorField: 'receiver_type',
      options: RECEIVERS.map(([value, label]) => [String(value), label])
    })}
    <div class="small text-muted mb-2">选择「指定用户」时，勾选下面的一位用户即可；点「搜索用户」只会重新加载本页，已填的标题与正文不会丢。</div>
    <div class="input-group input-group-sm mb-2">
      ${searchInput({ name: 'user_q', value: userQuery || '', placeholder: '按昵称 / 用户名 / ID 搜人' })}
      <button class="btn btn-sm btn-outline-secondary" type="submit" name="action" value="search_user">搜索用户</button>
    </div>
    <div class="border rounded p-2" style="max-height:34vh;overflow:auto">
      ${rows || '<div class="text-muted small">没有匹配的用户，换个关键词试试。</div>'}
    </div>
    <div class="form-text">最多列出 ${PICKER_LIMIT} 位（默认按 ID 倒序）。用户只以 ID 记录，不会把 openid 写进公告或下发到小程序。</div>
  </div></div>`;
}

function editView(ctx, { isNew, row, error, errorField, users, userQuery }) {
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
      pickedId: intOr(row.target_user_id, 0),
      users, userQuery
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

async function deleteSubmit(ctx) {
  const rawId = ctx.form.id;
  if (!positiveId(rawId)) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误' }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT title FROM app_notices WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该公告' }));
    await run(ctx.env, 'DELETE FROM app_notices WHERE id = ?', intOr(rawId, 0));
    auditLog('admin.app_notice.delete', { user: ctx.session.username, notice_id: intOr(rawId, 0), title: row.title || '' });
    invalidateEntityCache('notice');
    message = '公告已删除';
  } catch (err) {
    console.error(`删除公告失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试' }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'HEAD'], path: '/admin/notice_rows', handler: rowsFragment },
  { methods: ['GET', 'POST'], path: '/admin/notice_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/notice_delete', handler: deleteSubmit }
];
