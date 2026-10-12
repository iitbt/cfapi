// 管理员口令的哈希与校验: PBKDF2-SHA256(crypto.subtle 原生实现, 零依赖)
// 为什么不用旧站的 bcrypt: Workers 免费套餐 CPU 只有 10ms/请求, 纯 JS bcrypt 要 100~300ms, 必然报 Error 1102。
// 迭代数为什么停在一万: 本机实测每万轮约 9.6ms 中位, 已经很接近 10ms 的 CPU 预算 —— 再往上提会让登录直接
// 触发 1102(等于把后台锁死)。所以这里改为两条不花 CPU 的路子提升强度:
//   ① ADMIN_PASSWORD_PEPPER(服务端密文, 不进库): 拿到库但没拿到密钥就爆不动;
//   ② 登录成功后按当前参数顺手重哈希(needsRehash), 将来换迭代数/加 pepper 时旧哈希会自动升级。
// 哈希串自描述: pbkdf2_sha256$<迭代数>$<salt>$<hash>; 带 pepper 时前缀是 pbkdf2_sha256p。
import { bytesToBase64Url, base64UrlToBytes, encodeText } from './base64url.js';
import { settings } from '../../core/config.js';

const PREFIX = 'pbkdf2_sha256';
const PEPPER_PREFIX = 'pbkdf2_sha256p';
const DEFAULT_ITERATIONS = 10000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

// 与旧站一致: MIN_ADMIN_PASSWORD_LEN=10
export const MIN_PASSWORD_LENGTH = 10;

/** 当前环境配置的 pepper(没配就是空串, 一切照旧走不带 pepper 的老哈希)。 */
function pepperOf(env) {
  return settings(env).adminPasswordPepper;
}

/** 口令与 pepper 拼在一起再派生: pepper 与库里的盐/哈希分开保管, 单拿库爆不出来。 */
function withPepper(password, pepper) {
  const text = String(password === undefined || password === null ? '' : password);
  return pepper ? `${text}\u0000${pepper}` : text;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encodeText(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password, env) {
  const pepper = pepperOf(env);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(withPepper(password, pepper), salt, DEFAULT_ITERATIONS);
  return `${pepper ? PEPPER_PREFIX : PREFIX}$${DEFAULT_ITERATIONS}`
    + `$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

// 定长比较: 逐字节异或累加且不提前返回 —— 否则可以从比较耗时反推口令
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export async function verifyPassword(password, stored, env) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4) return false;
  const peppered = parts[0] === PEPPER_PREFIX;
  if (!peppered && parts[0] !== PREFIX) return false;
  const pepper = pepperOf(env);
  // 带 pepper 的哈希在没配密钥时不能退回"不带 pepper 去验": 那样只会得出"口令错误", 让人以为口令被改了
  if (peppered && !pepper) {
    console.error('口令哈希带 pepper, 但当前环境没配 ADMIN_PASSWORD_PEPPER, 无法校验');
    return false;
  }
  const iterations = Number(parts[1]) || 0;
  if (iterations < 1) return false;
  let salt;
  let expected;
  try {
    salt = base64UrlToBytes(parts[2]);
    expected = base64UrlToBytes(parts[3]);
  } catch (error) {
    return false;
  }
  const actual = await derive(withPepper(password, peppered ? pepper : ''), salt, iterations);
  return safeEqual(actual, expected);
}

/** 这条哈希是否该按当前参数重写(旧迭代数 / 没加 pepper / 形态认不出), 登录成功后据此顺手升级。 */
export function needsRehash(stored, env) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4) return true;
  const wanted = pepperOf(env) ? PEPPER_PREFIX : PREFIX;
  return parts[0] !== wanted || Number(parts[1]) !== DEFAULT_ITERATIONS;
}

// 账号不存在时也要跑一次等价开销的校验: 否则响应耗时能区分"账号存不存在", 等于给人枚举管理员用户名
let dummyHash = null;

/** 固定假哈希校验: 只为消耗与真校验同等的 CPU, 永远返回 false。 */
export async function verifyDummy(password, env) {
  if (!dummyHash) {
    const pepper = pepperOf(env);
    const salt = new Uint8Array(SALT_BYTES);
    const hash = await derive(withPepper('dummy', pepper), salt, DEFAULT_ITERATIONS);
    dummyHash = `${pepper ? PEPPER_PREFIX : PREFIX}$${DEFAULT_ITERATIONS}`
      + `$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
  }
  return verifyPassword(password, dummyHash, env);
}

// 会话里带的"口令指纹": 改了口令就让已发出的会话立即失效(与旧站 pwd_head 同思路)
export function passwordHead(stored) {
  return String(stored || '').slice(-8);
}
