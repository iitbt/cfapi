// 管理后台入口: /admin 前缀的所有请求都在这里分发
// 为什么独立成目录: 后台与对外 API 的职责、鉴权方式、改动节奏都不同, 放一起会让 src/ 变成杂物间
import staticAssets from './assets/static-assets.js';
import { adminLayout } from './lib/layout.js';
import { WRITE_METHODS, classifyWritePath } from './lib/entities.js';
import { applyStatus, statusKind } from './lib/status.js';
import { BOOTSTRAP_PATH, DASHBOARD_PATH, LOGIN_PATH, LOGOUT_PATH, currentAdmin, writeOriginAllowed } from './lib/guard.js';
import { auditLog } from '../core/logging.js';
import { settings } from '../core/config.js';
import { mediaContentType } from '../core/storage.js';
import { json, redirect } from './lib/http.js';
import { PAGE_ROUTES } from './pages/index.js';
import { bootstrapPage, bootstrapSubmit, loginPage, loginSubmit, logoutSubmit } from './routes/auth.js';
import { pendingPage } from './routes.js';
import { NAV_GROUPS } from './lib/nav.js';

const PREFIX = '/admin';
const STATIC_PREFIX = `${PREFIX}/static/`;

//: 后台静态资源的 Content-Type(按扩展名; 与 core/storage.js 的媒体类型表分工:
// 那张表管图片/视频, 这张管 css/js/字体这类"站点资源")
const CONTENT_TYPES = {
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  png: 'image/png',
  svg: 'image/svg+xml'
};

function staticContentType(key) {
  const ext = String(key).slice(String(key).lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] || mediaContentType(ext) || 'application/octet-stream';
}

//: data:URL 资源(图标字体)的解码缓存 —— isolate 内存里只有一份(字体内容不随请求变)
const decodedBinary = new Map();

function htmlResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// routes/auth.js 里有的分支回字符串、有的回 Response(跳转), 这里统一成全成 Response
function asResponse(value, status = 200) {
  return value instanceof Response ? value : htmlResponse(value, status);
}

//: 从 R2 取静态资源的键前缀(与 DEPLOY.md 的上传口径一致): /admin/static/X → R2 里的 admin/X
const STATIC_R2_PREFIX = 'admin/';

/**
 * 生成物里没有的资源改从 R2 取(2.4.9): wangeditor 与图标字体太大, 不适合内联进 Worker 模块(见 tools/embed_admin_assets.mjs)。
 * 地址仍是 /admin/static/<路径>?v=<版本号>, 所以浏览器缓存与版本号口径都不用改。
 * 没上传时的表现: 编辑器退回普通文本域(自带提示)、图标字体缺字形 —— 不影响后台能不能用。
 */
async function serveStaticFromR2(env, key) {
  const bucket = settings(env).storage;
  if (!bucket) return null;
  try {
    const object = await bucket.get(`${STATIC_R2_PREFIX}${key}`);
    if (!object) return null;
    return new Response(object.body, {
      headers: {
        'content-type': staticContentType(key),
        // 地址带 ?v=<API_VERSION>: 换版本号就是换 URL, 所以这里可以长缓存
        'cache-control': 'public, max-age=86400'
      }
    });
  } catch (error) {
    console.error(`静态资源从 R2 读取失败: ${key}`, error && error.message);
    return null;
  }
}

async function serveStatic(env, path) {
  const key = path.slice(STATIC_PREFIX.length);
  if (!Object.prototype.hasOwnProperty.call(staticAssets, key)) {
    const fromR2 = await serveStaticFromR2(env, key);
    if (fromR2) return fromR2;
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const value = staticAssets[key];
  // 图标字体是二进制资源: 生成阶段包成了 data:URL, 这里解码回二进制原样返回
  // (字体内容不随代码变, 所以缓存一年; css/js 仍走 ?v= 版本号, 缓存一天)
  if (typeof value === 'string' && value.startsWith('data:')) {
    let hit = decodedBinary.get(key);
    if (!hit) {
      const marker = value.indexOf(';base64,');
      const mime = value.slice(5, marker) || 'application/octet-stream';
      const binary = atob(value.slice(marker + 8));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      hit = { mime, bytes };
      decodedBinary.set(key, hit);
    }
    return new Response(hit.bytes, {
      headers: { 'content-type': hit.mime, 'cache-control': 'public, max-age=31536000' }
    });
  }
  return new Response(value, {
    headers: {
      'content-type': staticContentType(key),
      // 资源地址带 ?v=<API_VERSION>, 改了样式/脚本要升版本号(见 admin/README.md)
      'cache-control': 'public, max-age=86400'
    }
  });
}

// 表单解析: urlencoded(页面表单)与 JSON(数据库工具的 SQL 控制台)都认;
// multipart 由具体处理器自己读(formData 只能读一次)
async function readForm(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/json')) {
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const body = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (['string', 'number', 'boolean'].includes(typeof value)) body[key] = String(value);
      }
      return body;
    } catch (error) {
      return {};
    }
  }
  if (!type.includes('application/x-www-form-urlencoded')) return {};
  try {
    const form = await request.formData();
    const body = {};
    for (const [key, value] of form.entries()) {
      if (typeof value !== 'string') continue;
      // 同名多值按提交顺序拼成逗号串(2.6.0): 公告编辑页的"收件人"是**一组同名** target_user_id 复选框,
      // 只留最后一个的话"勾了 5 位只记住最后 1 位", 而哪一位算"最后"由 DOM 顺序决定, 完全不可靠。
      // 拼成逗号串而不是数组: 后台所有字段的消费方都是 strOf/intOr 的字符串语义, 数组会静默变成 "a,b" 或 NaN。
      // 全站只有公告收件人这一处用多值字段(唯一 name 的页面拿到的东西一字不变)。
      body[key] = body[key] === undefined ? value : `${body[key]},${value}`;
    }
    return body;
  } catch (error) {
    return {};
  }
}

function findNavItem(path) {
  const key = path.slice(PREFIX.length + 1);
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.key === key) return item;
    }
  }
  return null;
}

export async function handleAdmin(request, env, options = {}) {
  const url = new URL(request.url);
  // 去掉末尾斜杠, 只留一个规范形式(/admin/ 与 /admin 等价)
  const path = url.pathname.replace(/\/+$/, '') || PREFIX;
  const method = request.method.toUpperCase();

  // 样式与脚本: 生成物里精确匹配(不从磁盘拼路径, 无穿越面), 生成物里没有的再从 R2 取固定前缀下的对象; 不要求登录
  if (path.startsWith(STATIC_PREFIX)) return await serveStatic(env, path);

  const session = await currentAdmin(request, env);

  // 登录页要的入参与旧站 login.html 的模板变量一一对应: 版本号(与后台侧栏同源)、
  // 提示条(message=成功 / error=失败)、redirect=登录后回跳的原地址。
  const authView = {
    env,
    version: String(options.version || ''),
    message: url.searchParams.get('message') || '',
    error: url.searchParams.get('error') || '',
    // 旧站用 ?redirect=, 首版 CF 用 ?next=: 两个都认(只接受站内 /admin 路径, auth.js 里兜底校验)
    redirect: url.searchParams.get('redirect') || url.searchParams.get('next') || ''
  };

  // 未登录也要能打开的页面: 登录页与首次初始化
  if (path === LOGIN_PATH) {
    if (session.ok) return redirect(DASHBOARD_PATH);
    if (method === 'POST') return asResponse(await loginSubmit(request, env, await readForm(request), authView));
    return asResponse(await loginPage(authView));
  }
  if (path === BOOTSTRAP_PATH) {
    if (method === 'POST') return asResponse(await bootstrapSubmit(request, env, await readForm(request), authView));
    return asResponse(await bootstrapPage(authView));
  }
  if (path === LOGOUT_PATH) {
    // 只收 POST: 否则第三方页面用 <img src="/admin/logout"> 就能把人踢下线
    if (method === 'POST') return logoutSubmit(request);
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }

  // 其余一律要求登录(未登录回登录页, 带上原地址方便登录后跳回)
  if (!session.ok) {
    const next = encodeURIComponent(path === PREFIX ? DASHBOARD_PATH : path);
    return redirect(`${LOGIN_PATH}?next=${next}`);
  }

  const ctx = {
    request,
    env,
    method,
    path,
    url,
    query: Object.fromEntries(url.searchParams.entries()),
    form: method === 'POST' ? await readForm(request) : {},
    session: { id: session.id, username: session.username, role: session.role, isSuper: session.isSuper },
    // 版本号由入口注入(main.js 的 API_VERSION 是唯一来源, 也是静态资源 ?v= 的缓存键)
    version: String(options.version || ''),
    message: url.searchParams.get('message') || '',
    error: url.searchParams.get('error') || ''
  };

  // 每一笔后台写请求都留一条"谁 / 从哪来 / 写了哪条路径 / 结果"的审计。
  // IP 与 UA 在这里统一补: 各页自己的审计行只记业务细节 —— 挨个调用点补 request 要改几十处,
  // 还会漏掉被 403/404 拦下、根本进不到页面里的那些(那些恰恰是安全审计最关心的)。
  const auditWrite = (status, extra = {}) => auditLog('admin.write', Object.assign({
    username: ctx.session.username, request, method, path, status
  }, extra));

  // 写请求的权限口径: 分发前统一拦截(清单见 lib/entities.js)
  // route_super 也在这里拦: 只靠页面自查时, 漏一页就是一个越权口子(管理员增删/重置口令就漏过)
  if (WRITE_METHODS.has(method)) {
    // 来源校验: 跨站提交一定带 Origin, 必须与本站同源; 不带 Origin 的脚本调用放行(见 guard.writeOriginAllowed)
    if (!writeOriginAllowed(request)) {
      console.error(`[admin] 写请求来源校验失败: ${method} ${path}`);
      auditWrite(403, { reason: 'cross_origin' });
      return htmlResponse(adminLayout(Object.assign({}, ctx, {
        title: '没有权限', currentPage: '', error: '来源校验失败，已拒绝本次提交',
        content: '<div class="card-stat">这个提交不是从本站页面发出的，已被拒绝。请回到后台页面重新操作。</div>'
      })), 403);
    }
    const kind = classifyWritePath(path);
    if ((kind === 'super' || kind === 'route_super') && !session.isSuper) {
      auditWrite(403, { reason: 'super_only' });
      return htmlResponse(adminLayout(Object.assign({}, ctx, {
        title: '没有权限', currentPage: '', error: '该操作仅超级管理员可执行',
        content: '<div class="card-stat">你的账号不是超级管理员，这个操作被拒绝了。</div>'
      })), 403);
    }
    // 没登记口径的写入口一律拒绝并记日志 —— 宁可拒绝, 也不静默放行(自检会点名)
    if (kind === 'unregistered') {
      console.error(`[admin] 未登记权限口径的写入口: ${method} ${path}`);
      auditWrite(403, { reason: 'unregistered' });
      return htmlResponse(adminLayout(Object.assign({}, ctx, {
        title: '未登记的写入口', currentPage: '', error: '这个写入口没有登记权限口径，已拒绝执行',
        content: '<div class="card-stat">请在 <code>admin/lib/entities.js</code> 的三份写路径清单里登记它。</div>'
      })), 403);
    }
  }

  if (path === PREFIX) {
    if (WRITE_METHODS.has(method)) auditWrite(302, { note: 'admin_root' });
    return redirect(DASHBOARD_PATH);
  }

  // 统一状态切换(全后台唯一的写接口, 前端 status-toggle.js 调用)
  if (path === `${PREFIX}/status_update`) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    const kind = statusKind(ctx.form.kind);
    if (!kind) {
      auditWrite(400, { reason: 'bad_kind' });
      return json({ success: false, message: '参数错误' });
    }
    const payload = await applyStatus(env, ctx.session, kind, ctx.form.id, ctx.form.status);
    auditWrite(payload.forbidden ? 403 : 200, { kind: kind.key, id: ctx.form.id, ok: payload.success === true });
    return json(payload, payload.forbidden ? 403 : 200);
  }

  // 页面路由表(精确匹配; 后台路径没有参数, 够用)
  const route = PAGE_ROUTES.find((item) => item.path === path && item.methods.includes(method));
  if (route) {
    const response = asResponse(await route.handler(ctx));
    if (WRITE_METHODS.has(method)) auditWrite(response.status);
    return response;
  }

  // 还没迁的菜单入口: 给"待迁"占位页, 不是 404
  // (这一条不能进 PAGE_ROUTES —— 它按侧栏菜单项动态判断, 不是固定路径)
  const item = findNavItem(path);
  if (item && (method === 'GET' || method === 'HEAD')) return htmlResponse(pendingPage(ctx, item));

  // 写请求落到这里说明路径不存在(或方法不对): 也要留痕, 免得被当成"没发生过"
  if (WRITE_METHODS.has(method)) auditWrite(404);
  return htmlResponse(adminLayout(Object.assign({}, ctx, {
    title: '页面不存在',
    currentPage: '',
    error: '没有这个页面',
    content: '<div class="card-stat">后台里没有这个地址，请从左侧菜单进入。</div>'
  })), 404);
}
