// 管理员管理: 列表 / 新增 / 删除 / 重置口令(仅超管)
// 逐条对齐旧站 fastapi/app/admin/users_admin.py 的 admin_users 那部分
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { adminLayout } from '../lib/layout.js';
import { emptyRow, listShell, pagerScript } from '../lib/partials.js';
import { json, redirect } from '../lib/http.js';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../lib/password.js';
import { listController } from '../lib/listPage.js';
import {
  PER_PAGE, auditLog, buildListUrl, clampPage, fmtDatetime, intOr, onceOrError, strOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/admin_users';
const COLUMNS = ['ID', '管理员', '角色', '昵称', '邮箱', '最近登录', '操作'];
//: 角色展示口径(唯一维护点): 库里的 role 值 → 徽章文案与配色
const ROLE_LABELS = { super: ['超管', 'danger'], normal: ['普通', 'secondary'] };
const BUILTIN_USERNAME = 'admin';

function renderRows(ctx, admins) {
  if (!admins || !admins.length) return emptyRow(COLUMNS, '暂无管理员');
  // 回显"首屏实际渲染到第几页": 用 URL 里的 page 会把操作后的回跳带到一页空白上
  const page = intOr(ctx.listPage, 1) || 1;
  return admins.map((row) => {
    const builtin = strOf(row.username) === BUILTIN_USERNAME;
    // 内置那个账号一定是超管(哪怕库里的 role 是空的), 与"能不能删它"同一套判定
    const isSuperRow = builtin || strOf(row.role) === 'super';
    const [roleText, roleClass] = ROLE_LABELS[isSuperRow ? 'super' : 'normal'];
    const actions = builtin
      ? '<span class="text-muted small">内置账户</span>'
      // 动作字段一律走隐藏域(与上面的 add_admin 同一写法): 按钮的 name/value 会被"提交时禁用按钮"的脚本丢掉
      : `<div class="action-cell justify-content-center">
        <form method="post" class="d-inline">
          <input type="hidden" name="admin_id" value="${row.id}">
          <input type="hidden" name="page" value="${page}">
          <input type="hidden" name="reset_admin_password" value="1">
          <button class="btn btn-sm btn-outline-secondary" type="submit"
                  onclick="return confirm('重置该管理员的登录口令？新口令仅本次显示。')"><i class="bi bi-key" aria-hidden="true"></i> 重置口令</button>
        </form>
        <form method="post" class="d-inline">
          <input type="hidden" name="admin_id" value="${row.id}">
          <input type="hidden" name="page" value="${page}">
          <input type="hidden" name="delete_admin" value="1">
          <button class="btn btn-sm btn-outline-danger" type="submit"
                  onclick="return confirm('确定删除该管理员？')"><i class="bi bi-trash" aria-hidden="true"></i> 删除</button>
        </form>
      </div>`;
    return `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td class="text-nowrap">${escapeHtml(strOf(row.username))}</td>
  <td class="text-nowrap"><span class="badge text-bg-${roleClass}">${roleText}</span></td>
  <td class="text-nowrap">${escapeHtml(strOf(row.nickname) || '-')}</td>
  <td class="text-nowrap">${escapeHtml(strOf(row.email) || '-')}</td>
  <td class="text-nowrap small">${escapeHtml(fmtDatetime(row.last_login_time) || '从未登录')}</td>
  <td class="text-nowrap">${actions}</td>
</tr>`;
  }).join('');
}

// 新增表单: 与旧站字段一致(username/password/confirm_password/nickname/email)
function addForm() {
  return `<form method="post" class="row g-2 align-items-end">
  <input type="hidden" name="add_admin" value="1">
  <div class="col-md-3"><label class="form-label" for="newAdminUsername">用户名</label>
    <input class="form-control" id="newAdminUsername" name="username" required></div>
  <div class="col-md-3"><label class="form-label" for="newAdminPassword">口令</label>
    <input class="form-control" id="newAdminPassword" name="password" type="password" required></div>
  <div class="col-md-3"><label class="form-label" for="newAdminConfirm">确认口令</label>
    <input class="form-control" id="newAdminConfirm" name="confirm_password" type="password" required></div>
  <div class="col-md-2"><label class="form-label" for="newAdminNickname">昵称</label>
    <input class="form-control" id="newAdminNickname" name="nickname"></div>
  <div class="col-md-2"><label class="form-label" for="newAdminEmail">邮箱</label>
    <input class="form-control" id="newAdminEmail" name="email" type="email"></div>
  <div class="col-md-2"><label class="form-label" for="newAdminRole">角色</label>
    <select class="form-select" id="newAdminRole" name="role">
      <option value="normal" selected>普通管理员</option>
      <option value="super">超级管理员</option>
    </select></div>
  <div class="col-12"><button class="btn btn-primary" type="submit"><i class="bi bi-plus-lg" aria-hidden="true"></i> 新增管理员</button>
    <span class="text-muted small ms-2">口令至少 ${MIN_PASSWORD_LENGTH} 位。角色决定能否进"数据库管理 / 素材库 / 管理员账号"这些超管页面。</span></div>
</form>`;
}

function randomPassword(length = 10) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += charset[byte % charset.length];
  return out;
}

async function managePage(ctx) {
  // 取数 + 分页骨架走公共实现(lib/listPage.js); 管理员表没有筛选条件
  const { total, totalPages, page, rows: admins, error } = await listController(ctx, {
    table: 'admin_users',
    columns: 'id, username, nickname, email, avatar, last_login_time, create_time',
    orderBy: 'id', label: '获取管理员列表', failure: '获取管理员列表失败，请稍后重试'
  });
  // 行里的回跳页码要用"实际渲染到的那一页"(见 renderRows), 所以摊进 ctx 传下去
  ctx.listPage = page;
  const content = `<div class="card"><div class="card-body">
  ${addForm()}
  <hr>
  ${listShell({
    title: '管理员', columns: COLUMNS, rows: renderRows(ctx, admins), actions: '',
    tbodyId: 'adminTbody', sentinelId: 'adminLoadMore', textId: 'adminLoadMoreText',
    hintId: 'adminLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '位', backTopId: 'adminBackTopBtn', jumpBtnId: 'adminJumpBtn', jumpInputId: 'adminJumpInput'
  })}
</div></div>`;
  return adminLayout({
    title: '管理员用户管理', currentPage: 'admin_users', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'adminTbody', sentinelId: 'adminLoadMore', textId: 'adminLoadMoreText',
      rowsUrl: '/admin/admin_users_rows', currentPage: page, totalPages, total, perPage: PER_PAGE,
      unit: '位', hintId: 'adminLoadedHint', announceLabel: '管理员', baseUrl: MANAGE_URL,
      backTopId: 'adminBackTopBtn', jumpBtnId: 'adminJumpBtn', jumpInputId: 'adminJumpInput',
      version: ctx.version
    })
  });
}

async function rowsFragment(ctx) {
  const page = clampPage(ctx.query.page, null);
  ctx.listPage = page;
  let admins = [];
  try {
    admins = await all(ctx.env,
      'SELECT id, username, nickname, email, avatar, last_login_time, create_time FROM admin_users ORDER BY id LIMIT ? OFFSET ?',
      PER_PAGE + 1, (page - 1) * PER_PAGE);
  } catch (err) {
    console.error('获取管理员分页数据失败', err && err.message);
    return json({ success: false, message: '加载失败，请稍后重试' });
  }
  const hasMore = admins.length > PER_PAGE;
  admins = admins.slice(0, PER_PAGE);
  if (!admins.length) return json({ success: true, rows: '', has_more: false });
  return json({ success: true, rows: renderRows(ctx, admins), has_more: hasMore });
}


// 写操作: 新增 / 删除 / 重置口令。重置口令成功**不能 302**(新口令会进 URL 与访问日志), 就地渲染
async function writeSubmit(ctx) {
  const form = ctx.form;
  const page = strOf(form.page) || '1';
  const isAdd = Boolean(form.add_admin) || (form.username !== undefined && form.password !== undefined && !form.admin_id);
  let message = '';
  let error = '';

  if (isAdd) {
    const username = strOf(form.username);
    const password = strOf(form.password);
    const confirm = strOf(form.confirm_password);
    const nickname = strOf(form.nickname);
    const email = strOf(form.email);
    if (!username || !password || !confirm) {
      error = '用户名和密码不能为空';
    } else if (password !== confirm) {
      error = '两次输入的密码不一致';
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      error = `密码长度不能少于 ${MIN_PASSWORD_LENGTH} 个字符`;
    } else if (await one(ctx.env, 'SELECT id FROM admin_users WHERE username = ?', username).catch(() => null)) {
      error = '用户名已存在，请选择其他用户名';
    } else {
      try {
        // 角色只认 super/normal 两个值(其它一律当普通管理员), 与 isSuperRole 的判定对齐
        const role = strOf(form.role) === 'super' ? 'super' : 'normal';
        await run(ctx.env,
          "INSERT INTO admin_users (username, password, nickname, email, login_type, role) VALUES (?,?,?,?,'account',?)",
          username, await hashPassword(password, ctx.env), nickname, email, role);
        auditLog('admin.account.create', { user: ctx.session.username, target: username, role });
        message = '管理员账户创建成功';
      } catch (err) {
        console.error('创建管理员失败', err && err.message);
        error = '创建失败，请稍后重试';
      }
    }
    if (!message && error) {
      auditLog('admin.account.create.rejected', { user: ctx.session.username, target: username, reason: error });
    }
  } else if (form.delete_admin && form.admin_id) {
    const adminId = form.admin_id;
    try {
      const target = await one(ctx.env, 'SELECT id, username FROM admin_users WHERE id = ?', intOr(adminId, 0));
      if (!target) error = '找不到该管理员';
      else if (strOf(target.username) === BUILTIN_USERNAME) error = '不能删除内置超级管理员账户';
      else if (String(ctx.session.id) === String(target.id)) error = '不能删除自己的账号';
      else {
        await run(ctx.env, 'DELETE FROM admin_users WHERE id = ?', intOr(adminId, 0));
        auditLog('admin.account.delete', { user: ctx.session.username, target: target.username, admin_id: intOr(adminId, 0) });
        message = '管理员账户已成功删除';
      }
    } catch (err) {
      console.error('删除管理员失败', err && err.message);
      error = '删除失败，请稍后重试';
    }
  } else if (form.reset_admin_password && form.admin_id) {
    const adminId = form.admin_id;
    // 幂等: 双击/刷新不会重复改密(第二次的新口令会让人以为没生效)
    const duplicated = await onceOrError(ctx, 'admin_reset_password', [adminId]);
    if (duplicated) {
      error = duplicated;
    } else {
      try {
        const target = await one(ctx.env, 'SELECT id, username FROM admin_users WHERE id = ?', intOr(adminId, 0));
        if (!target) error = '找不到该管理员';
        else if (strOf(target.username) === BUILTIN_USERNAME) error = '内置超级管理员的密码请在「系统设置」中修改';
        else if (String(ctx.session.id) === String(target.id)) error = '请勿在列表中重置自己的密码, 可在「系统设置」中修改';
        else {
          const newPassword = randomPassword();
          await run(ctx.env, 'UPDATE admin_users SET password = ? WHERE id = ?',
            await hashPassword(newPassword, ctx.env), intOr(adminId, 0));
          auditLog('admin.account.reset_password', { user: ctx.session.username, target: target.username, admin_id: intOr(adminId, 0) });
          message = `管理员 '${strOf(target.username)}' 的密码已重置, 新密码仅本次显示: ${newPassword}。`
            + '请尽快使用新密码登录并在「系统设置」中修改';
        }
      } catch (err) {
        console.error('重置管理员口令失败', err && err.message);
        error = '重置失败，请稍后重试';
      }
    }
  } else {
    console.warn('管理员管理页收到无法识别的提交', Object.keys(form).sort().join(','));
    auditLog('admin.account.unknown_submit', { user: ctx.session.username, form_fields: Object.keys(form).sort().join(',') });
    error = '未识别到提交类型（可能是页面缓存版本过旧），请刷新页面后重试';
  }

  // 成功且消息里不带"仅本次显示"的口令时走 PRG; 带口令的那条就地渲染, 绝不把口令放进 URL
  if (message && !error && !message.includes('新密码仅本次显示')) {
    return redirect(buildListUrl(MANAGE_URL, { message, page }));
  }
  return managePage({ request: ctx.request, env: ctx.env, method: 'GET', path: ctx.path, url: ctx.url, query: ctx.query, form: {}, session: ctx.session, version: ctx.version, message, error });
}

// 这一页整页只给超管: 写操作由分发层按 route_super 拦(见 entities.js), 列表本身也不该给普通管理员看
function guard(ctx) {
  if (ctx.session.isSuper) return null;
  return new Response(adminLayout(Object.assign({}, ctx, {
    title: '没有权限', currentPage: '', error: '该页面仅超级管理员可访问',
    content: '<div class="card-stat">你的账号不是超级管理员，看不到这个页面。</div>'
  })), { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export const routes = [
  { methods: ['GET', 'POST'], path: MANAGE_URL, handler: (ctx) => guard(ctx) || (ctx.method === 'POST' ? writeSubmit(ctx) : managePage(ctx)) },
  { methods: ['GET', 'HEAD'], path: '/admin/admin_users_rows', handler: (ctx) => guard(ctx) || rowsFragment(ctx) }
];
