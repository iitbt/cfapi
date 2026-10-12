// D1 访问薄封装: 只三件事 —— 多行、单行、写入; 不做 ORM, 不做连接管理
export async function all(env, sql, ...args) {
  const result = await env.DB.prepare(sql).bind(...args).all();
  return result.results || [];
}

export async function one(env, sql, ...args) {
  return await env.DB.prepare(sql).bind(...args).first();
}

export function run(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).run();
}

// 与旧站 helpers.intval 同语义: int(float(v)), 非法值回退, 结果夹在 ±2^31-1
// (不用 parseInt: 旧站能认 "3.7" 与 "1e3", parseInt 会把它们当成 3 / 1)
const INT32_MAX = 2147483647;

export function intOf(value, fallback = 0) {
  let num = NaN;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    num = Number(value.trim());
  }
  if (!Number.isFinite(num)) return fallback;
  const truncated = Math.trunc(num);
  if (truncated > INT32_MAX) return INT32_MAX;
  if (truncated < -INT32_MAX) return -INT32_MAX;
  return truncated;
}

// 逗号分隔的 id 串 → 正整数数组(批量接口用)
export function idList(value) {
  return String(value === undefined || value === null ? '' : value)
    .split(',')
    .map((item) => intOf(item.trim()))
    .filter((item) => item > 0);
}

//: D1 每条 SQL 语句的绑定参数上限是 100(官方限制, batch 内的每条同样受限), 留出余量给其它条件
export const IN_CHUNK_SIZE = 90;

/**
 * 把 id 列表切成 ≤IN_CHUNK_SIZE 的批次 —— 所有 `IN (?,?,…)` 都必须先过这里。
 * 为什么必须有: 参数超过 100 时 D1 是**整条语句报错**(不是返回 0 行), 表现为接口 500、
 * 或"批量清理一声不响地什么都不删"。去重与过滤非正整数在这里一次做完, 调用方不用再管。
 */
export function chunkIds(ids, size = IN_CHUNK_SIZE) {
  const list = [];
  for (const item of ids || []) {
    const value = intOf(item);
    if (value > 0 && !list.includes(value)) list.push(value);
  }
  const chunks = [];
  for (let start = 0; start < list.length; start += size) chunks.push(list.slice(start, start + size));
  return chunks;
}

/** 一份 id 列表对应的占位符串(与 chunkIds 配套: 每批一段 `?,?,…`)。 */
export function marksOf(chunk) {
  return chunk.map(() => '?').join(',');
}

export function str(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}
