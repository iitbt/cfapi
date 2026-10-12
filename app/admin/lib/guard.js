// 后台访问控制: 登录态放在签名 Cookie 里(见 lib/session.js), 与旧站同一套做法
// 这里只管三件事: 哪些路径未登录也能打开、怎么从请求里取当前管理员、写请求的来源校验
import { readSession } from './session.js';

export const LOGIN_PATH = '/admin/login';
export const LOGOUT_PATH = '/admin/logout';
export const BOOTSTRAP_PATH = '/admin/bootstrap';
export const DASHBOARD_PATH = '/admin/dashboard';

// 取当前登录的管理员; 未登录返回 { ok:false }
// 角色/是否超管都直接取 readSession 的结果 —— 那是回查库后的值, 降权后下一步请求就生效
export async function currentAdmin(request, env) {
  const session = await readSession(request, env);
  if (!session) return { ok: false, id: 0, username: '', role: '', isSuper: false };
  return {
    ok: true,
    id: session.id,
    username: session.username,
    role: session.role,
    isSuper: session.isSuper === true
  };
}

// 写请求的来源校验: SameSite=Strict 之外再加一道(旧站也是 Origin/Referer 双保险)
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (error) {
    return false;
  }
}

/**
 * 分发层用的写请求来源判定: 浏览器跨站提交**一定带** Origin, 这种情况必须与本站同源;
 * 不带 Origin 的调用(脚本 / curl / 联动工具)一律放行 —— 它们没有会话 Cookie, 也就没有越权面,
 * 卡死它们只会让自动化测试与运维脚本用不了。
 */
export function writeOriginAllowed(request) {
  if (!request.headers.get('origin')) return true;
  return sameOrigin(request);
}
