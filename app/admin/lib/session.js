// 会话: HMAC-SHA256 签名的 Cookie(无服务端状态, 与旧站"签名 Cookie 会话"同一思路)
// 载荷只放 id/用户名/角色/过期时间/口令指纹 —— 可读不可改, 防篡改靠签名;
// **角色与口令状态以库为准**(见 readSession): 改密/降权/删号后旧 Cookie 立刻失效
import { bytesToBase64Url, base64UrlToBytes, encodeText, decodeText } from './base64url.js';
import { passwordHead } from './password.js';
import { findAdminById, isSuperRole } from './auth-store.js';
import { settings } from '../../core/config.js';

const COOKIE_NAME = 'admin_session';
export const SESSION_MAX_AGE = 86400;

export function sessionSecret(env) {
  return settings(env).adminSessionSecret;
}

function parseCookies(header) {
  const jar = {};
  String(header || '').split(';').forEach((part) => {
    const at = part.indexOf('=');
    if (at < 0) return;
    jar[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  });
  return jar;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encodeText(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSessionCookie(env, admin, secureFlag = '; Secure') {
  const secret = sessionSecret(env);
  if (!secret) throw new Error('缺少 ADMIN_SESSION_SECRET');
  const payload = {
    id: Number(admin.id) || 0,
    username: String(admin.username || ''),
    role: String(admin.role || 'normal'),
    head: passwordHead(admin.password),
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE
  };
  const body = bytesToBase64Url(encodeText(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encodeText(body)));
  // HttpOnly 防脚本读, SameSite=Strict 挡跨站提交(写接口另有一道来源校验, 见 admin/index.js)
  return `${COOKIE_NAME}=${body}.${bytesToBase64Url(signature)}`
    + `; Path=/; HttpOnly; SameSite=Strict${secureFlag}; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie(secureFlag = '; Secure') {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${secureFlag}; Max-Age=0`;
}

// Secure 属性只在 https 下发: 浏览器规范规定 http 页面下的 Secure cookie 会被**直接丢弃**,
// 于是本地用 http 预览时"登录成功却立刻回到登录页"。生产是 Cloudflare 边缘, request.url 恒为 https,
// 所以这里不会削弱线上安全(解析不出协议时按 https 处理)。
export function secureFlagOf(request) {
  try {
    return new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  } catch (error) {
    return '; Secure';
  }
}

// 返回会话载荷或 null(签名不对 / 过期 / 没配密钥 / 账号已变都算未登录)
// 为什么还要回查库: 只有签名与过期时间时, 改密/降权/删号都踢不掉已经发出去的 Cookie(最长能用到 24 小时)。
// 代价是每次后台请求多一次 D1 主键查询(后台量级很小), 换来"库里的状态就是唯一真相"。
export async function readSession(request, env) {
  const secret = sessionSecret(env);
  if (!secret) return null;
  const raw = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
  if (!raw || raw.indexOf('.') < 0) return null;
  const [body, signature] = raw.split('.');
  let verified = false;
  try {
    const key = await hmacKey(secret);
    verified = await crypto.subtle.verify('HMAC', key, base64UrlToBytes(signature), encodeText(body));
  } catch (error) {
    return null;
  }
  if (!verified) return null;
  let payload = null;
  try {
    payload = JSON.parse(decodeText(base64UrlToBytes(body)));
  } catch (error) {
    return null;
  }
  if (!payload || !payload.username) return null;
  if (Number(payload.exp) * 1000 < Date.now()) return null;
  let row = null;
  let dbDown = false;
  try {
    row = await findAdminById(env, payload.id);
  } catch (error) {
    dbDown = true;
  }
  if (dbDown) {
    // D1 不可用时退回"只信签名"(与改动前一致): 否则库一抖就把所有人踢回登录页, 而登录同样要查库, 等于死循环。
    // 代价是这段时间里旧 Cookie 仍能看页面 —— 但也仅止于此: 写操作要么写库(必然失败), 要么先跑引用扫描(同样读库, 会拒绝)。
    return {
      id: Number(payload.id) || 0,
      username: String(payload.username),
      role: String(payload.role || ''),
      isSuper: isSuperRole(payload.role),
      exp: payload.exp,
      degraded: true
    };
  }
  if (!row) return null;
  // 口令指纹不一致 = 口令已被改过(或换了 pepper), 旧会话立即作废
  if (passwordHead(row.password) !== String(payload.head || '')) return null;
  return {
    id: Number(row.id) || 0,
    username: String(row.username || ''),
    role: String(row.role || ''),
    isSuper: isSuperRole(row.role),
    exp: payload.exp
  };
}
