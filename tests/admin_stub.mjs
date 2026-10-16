// 后台页面测试共用桩: 一个能登录的环境 + 按表名回数据的 D1 桩 + 便捷请求帮手
// 单表桩的默认口径: COUNT(*) 走 counts[表名], SELECT 走 rows[表名](列表)或 rows[表名][0](单行)
import { handleAdmin } from '../app/admin/index.js';
import { API_VERSION } from '../main.js';
import { hashPassword } from '../app/admin/lib/password.js';

export const HOST = 'https://admin.test';
export const ADMIN_PASSWORD = 'password-12345';
export const ADMIN_HASH = await hashPassword(ADMIN_PASSWORD);

function tableOf(sql) {
  const matched = /(?:FROM|UPDATE|INTO)\s+"?(\w+)"?/i.exec(String(sql));
  return matched ? matched[1] : '';
}

export function makeAdminEnv(options = {}) {
  const rows = options.rows || {};
  const counts = options.counts || {};
  const state = { role: options.role || 'super', calls: [], puts: [], deletes: [], deleteCalls: 0, objects: new Map() };
  const adminRow = { id: 1, username: 'admin', nickname: '管理员', password: ADMIN_HASH, role: state.role };
  const env = {
    ADMIN_SESSION_SECRET: 'test-secret',
    ADMIN_ACCESS_MODE: 'access',
    MEDIA_BASE: 'https://media.test',
    // R2 桩(绑定名与 wrangler.toml 一致): list 按 prefix 过滤 options.mediaObjects, put 记录 key, head 由 options.mediaHead 决定。
    // 2.3.9 起 put/delete 还维护一份内存对象表(state.objects), 这样"改名 = 读→写→删"能被测到;
    // head 的优先级仍是 options.mediaHead(老用例靠它模拟"有/没有缩略图")。
    // 2.4.6: list 支持 **真 R2 的 prefix + delimiter 语义**(带 delimiter 时把含分隔符的键折叠成 delimitedPrefixes) ——
    //   桶浏览器页正是靠 delimiter 只列"当前这一层", 桩若不实现它, 用例会把子目录里的对象也当成当前层, 给出假通过。
    STORAGE: {
      list: async (opts) => {
        const prefix = String((opts && opts.prefix) || '');
        const delimiter = String((opts && opts.delimiter) || '');
        const limit = Number((opts && opts.limit) || 1000);
        const all = (options.mediaObjects || []).filter((object) => String(object.key || '').startsWith(prefix));
        if (!delimiter) {
          // 整桶列举按 cursor 分页: 选择器的"全盘"搜索就是一页页扫过去的
          const start = Number((opts && opts.cursor) || 0);
          const page = all.slice(start, start + limit);
          const truncated = start + limit < all.length;
          return { objects: page, truncated: truncated, cursor: truncated ? String(start + limit) : undefined };
        }
        // delimiter 分支按真 R2 的三点语义来: ① 结果按 key 字典序; ② limit 是"对象 + 目录"的合计配额
        // (根下对象多时目录排在后面会被整批截掉 —— 桩不实现这一条, 就测不出"文件夹显示不全"); ③ 截断时给 cursor 续取。
        // 按码元序排(与 R2/浏览器一致); 不能用 localeCompare —— 中文会被排到 ASCII 前面, 与线上顺序不符
        const sorted = all.slice().sort((one, two) => {
          const left = String(one.key); const right = String(two.key);
          return left < right ? -1 : (left > right ? 1 : 0);
        });
        const entries = [];
        for (const object of sorted) {
          const key = String(object.key || '');
          if (key === prefix) continue;
          const rest = key.slice(prefix.length);
          const at = rest.indexOf(delimiter);
          if (at < 0) { entries.push({ object: object }); continue; }
          const folder = prefix + rest.slice(0, at + delimiter.length);
          if (!entries.some((one) => one.folder === folder)) entries.push({ folder: folder });
        }
        const start = Number((opts && opts.cursor) || 0);
        const page = entries.slice(start, start + limit);
        const truncated = start + limit < entries.length;
        return {
          objects: page.filter((one) => one.object).map((one) => one.object),
          delimitedPrefixes: page.filter((one) => one.folder).map((one) => one.folder),
          truncated: truncated,
          cursor: truncated ? String(start + limit) : undefined
        };
      },
      head: async (key) => {
        if (options.mediaHead) return options.mediaHead(key);
        const found = state.objects.get(String(key));
        return found ? { key: String(key), size: found.size, httpMetadata: found.httpMetadata || {}, uploaded: new Date() } : null;
      },
      get: async (key) => {
        const found = state.objects.get(String(key));
        if (!found) return null;
        return { body: { size: found.size }, size: found.size, httpMetadata: found.httpMetadata || {} };
      },
      put: async (key, body, opts) => {
        state.puts.push(key);
        state.objects.set(String(key), {
          size: Number((body && body.size) || 0),
          httpMetadata: (opts && opts.httpMetadata) || {}
        });
        return {};
      },
      delete: async (keys) => {
        state.deleteCalls += 1;
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          state.deletes.push(key);
          state.objects.delete(String(key));
        }
        return {};
      }
    },
    DB: {
      prepare(sql) {
        const entry = { sql, args: [] };
        state.calls.push(entry);
        const api = {
          sql,
          args: entry.args,
          bind(...args) { entry.args = args; return api; },
          async first() {
            if (options.db) {
              const custom = options.db(sql, entry.args, 'first');
              if (custom !== undefined) return custom;
            }
            if (/FROM admin_users WHERE username=/i.test(sql)) return adminRow;
            // 控制面板/版本页那条 aggregrate 查询: 直接回一份完整数字, 便于断言卡片内容
            if (/AS total_users/i.test(sql)) {
              const base = Object.assign({
                total_users: 4, today_users: 1, week_users: 2, prev_week_users: 1, yesterday_users: 0,
                total_news: 69, approved_news: 66, pending_news: 3, total_comments: 12, pending_comments: 2,
                total_likes: 30, total_favorites: 18, total_banners: 18, motorcycle_total: 10, outdoor_total: 8
              }, options.dashboardCounts || {});
              return base;
            }
            // 唯一性检查(WHERE xxx=? AND id<>?): 默认"没被占用" —— 否则桩会拿表里第一行当重复
            if (/AND id\s*<>\s*\?/i.test(sql)) return null;
            // 设置页/详情页/**会话回查**都会按 id 取管理员: 命中 rows.admin_users 里同 id 的那行,
            // 缺的列(password/role —— 会话回查要用)按内置管理员补齐, 真实库里这两列一定有值
            if (/FROM admin_users WHERE id\s*=\s*\?/i.test(sql)) {
              const hit = (rows.admin_users || []).find((item) => Number(item.id) === Number(entry.args[0]));
              return Object.assign({
                id: 1, username: 'admin', nickname: '管理员', email: '',
                password: ADMIN_HASH, role: state.role,
                create_time: '2026-09-01 10:00:00', last_login_time: '2026-10-01 08:00:00'
              }, hit || {});
            }
            const table = tableOf(sql);
            if (/COUNT\(\*\)/i.test(sql)) {
              const value = counts[table];
              if (value !== undefined) return { total: value, c: value };
            }
            const list = rows[table] || [];
            return list.length ? list[0] : null;
          },
          async all() {
            if (options.db) {
              const custom = options.db(sql, entry.args, 'all');
              if (custom !== undefined) return { results: custom };
            }
            return { results: rows[tableOf(sql)] || [] };
          },
          async run() {
            if (options.db) {
              const custom = options.db(sql, entry.args, 'run');
              if (custom !== undefined) return custom;
            }
            return { meta: { changes: 1, last_row_id: 42 } };
          }
        };
        return api;
      },
      // batch 按 D1 的真实形状回: 每条语句一项 { results, meta }。
      // COUNT 语句用 counts[表名] 喂数(与 first() 同一口径), 这样统计页的用例可以直接写期望值。
      async batch(list) {
        if (options.batch) return options.batch(list);
        return list.map((statement) => {
          const sql = String((statement && statement.sql) || '');
          if (/COUNT\(\*\)/i.test(sql)) {
            const value = counts[tableOf(sql)] || 0;
            return { results: [{ c: value }], meta: { changes: 0 } };
          }
          return { results: [], meta: { changes: 1 } };
        });
      }
    }
  };
  return { env, state, adminRow };
}

function request(path, options = {}) {
  const method = options.method || 'GET';
  const headers = Object.assign({ origin: HOST }, options.headers || {});
  if (options.cookie) headers.cookie = options.cookie;
  const init = { method, headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    // 值是数组时逐个 append(2.6.0): 公告「收件人」是**同名多值**字段(勾几位就发几个 target_user_id),
    // 直接 URLSearchParams(body) 会把数组 String() 成 "7,9" 一个值 —— 那测到的就不是浏览器真实发的形状,
    // 而是"服务端恰好也能解析逗号串"的假通过。
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.body || {})) {
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
    }
    init.body = params.toString();
  }
  return new Request(`${HOST}${path}`, init);
}

// 与 main.js 一致: 后台入口的版本号由调用方注入(唯一来源是 main.js 的 API_VERSION)
const ADMIN_OPTIONS = { version: API_VERSION };
export const get = (path, env, cookie) => handleAdmin(request(path, { env, cookie }), env, ADMIN_OPTIONS);

export const post = (path, body, env, cookie) => handleAdmin(request(path, { method: 'POST', body, env, cookie }), env, ADMIN_OPTIONS);

export async function loginCookie(env) {
  const res = await post('/admin/login', { username: 'admin', password: ADMIN_PASSWORD }, env);
  return String(res.headers.get('set-cookie') || '').split(';')[0];
}

// 找出桩里收到过的某类 SQL(断言"到底发没发/参数对不对")
export function findCall(state, pattern) {
  return state.calls.find((item) => pattern.test(item.sql)) || null;
}
