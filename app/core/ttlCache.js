// 进程内短 TTL 缓存: 只给"几乎不变、却每个请求都要查一次"的配置数据用(分类/首页板块/文案/菜单/轮播图)。
//
// 为什么放内存: 缓存对象很小(D1 行数组), 内存里放一份最省事, 也不用多一次 Cache API 子请求。
// 为什么不长: 后台改文案/分类/菜单后, 最多等一个 TTL 才在小程序侧生效 —— 后台与接口通常不在同一个
// isolate 里, 写操作没法主动清掉别的 isolate 的缓存(见 admin/lib/utils.js 的 invalidateEntityCache 说明)。
// 为什么失败不缓存: loader 抛错时原样抛出, 下次请求重新查 —— 免得把一次抖动固化成一个 TTL。
// 注意: 拿到的值是同一个引用, 调用方只读不改(改了就污染了后续请求)。
const store = new Map();

/** 命中缓存直接返回同一个值; 未命中则 await loader() 并记住它。 */
export async function cacheOnce(key, ttlMs, loader) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  const value = await loader();
  store.set(key, { value, expires: now + ttlMs });
  return value;
}
