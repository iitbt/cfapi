// 数据库工具的安全内核与元信息 —— 对照旧站 app/admin/maint.py(唯一安全内核) + app/admin/dbadmin.py(元信息/分页)
//
// 旧站头注释点名的三条纪律, 这里原样继承(它们不是"额外加的约束", 是既有口径):
//   ① **只读浏览**范围 = 本库全部表: 表结构 + 数据分页, 表名必须是安全标识符且确实存在于本库;
//   ② **执行 SQL**范围 = 白名单业务表 —— 与浏览范围是两件事, 不随浏览放开
//      (防误删, 也防绕过公告标题/分类标识这些业务校验直接写表);
//   ③ 危险语句一律拒绝(DDL / 多语句 / 事务与 PRAGMA), 错误详情只进日志, 回给用户统一文案。
//
// 2.2.7 增强(**不改上面三条纪律**): 结构给全默认值/索引列、数据可排序/按字段筛选/关键字搜索、
// 单行可复制成 JSON/INSERT/UPDATE、SQL 控制台有快捷语句与本机历史 —— 都是"更好用", 不是"更放权"。
// 唯一的口径调整: 执行失败时**额外**回一句被截断的数据库原文(旧站只进日志) —— 超管本来就能浏览
// 全库结构, 而"语焉不详的报错"是这一页最大的时间黑洞; 该文案同时进 auditLog, 见 runStatement。
//
// 2.2.8/2.2.9 增强也**不改上面三条纪律**, 继续只做"更好用 + 更省额度":
//   · 元数据(表清单/列/索引/建表语句/字段总览)在 isolate 内短期缓存 —— 结构与额度都要省着用;
//   · 字段总览一次 SQL 拿全库字段(pragma 表函数), 不支持才回退逐表 PRAGMA;
//   · 数据分页把 D1 的 meta(rows_read/rows_written/duration)一起回传, 页面显示成本;
//   · **没有新增写入口**: 单行编辑/删除/批量删除都是"前端生成单条 SQL → 走既有的 /admin/db_manage/exec",
//     权限(超管 + ENABLE_SQL_TOOL + 白名单业务表 + confirm=1 + 审计)与旧站完全一致。
import { all, one } from '../../core/db.js';
import { countTables, tableNames } from '../../core/overview.js';
import { logWarn } from '../../core/logging.js';

//: 允许执行的业务表(旧站 maint._SAFE_TOOL_TABLES 同口径: 只放业务表, 不放 admin_users / token 表)
export const SAFE_TABLES = [
  'users', 'news', 'news_likes', 'news_favorites', 'news_view_history', 'news_shares',
  'news_comments', 'banner_images', 'motorcycle_trips', 'outdoor_activities', 'app_notices'
];

//: 数据浏览单页上限(与前台 MAX_PAGE_SIZE 口径一致)
export const MAX_PAGE_SIZE = 50;
//: 分页下拉的档位(默认 20, 与旧站一致)
export const PAGE_SIZES = [20, 50];
//: 执行 SQL 时单次最多回传的行数: D1 会把结果全部读进内存, 页面也不该一次渲染几万行
export const MAX_EXEC_ROWS = 500;
//: 关键字搜索最多覆盖多少列(宽表时避免一条 SQL 拼上千个 LIKE)
const MAX_SEARCH_COLUMNS = 24;

//: 表名只允许安全标识符(不接受任意输入)
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

//: 敏感列脱敏(旧站 _mask_rows_sensitive 同口径): 值一律变成 ***
const SENSITIVE_COLUMNS = new Set([
  'token', 'password', 'passwd', 'pwd', 'secret', 'access_token', 'session_key',
  'openid', 'appid', 'appsecret', 'authorization', 'cookie'
]);

//: 给页面用的敏感列名清单(客户端"生成 INSERT/UPDATE"时要跳过它们:
//  展示值已被打码成 ***, 照抄会覆盖真值)
export const SENSITIVE_COLUMN_NAMES = Array.from(SENSITIVE_COLUMNS);

export function isSafeIdentifier(name) {
  return IDENTIFIER_RE.test(String(name || ''));
}

export async function tableExists(env, name) {
  if (!isSafeIdentifier(name)) return false;
  try {
    return (await tableNamesCached(env)).includes(name);
  } catch (error) {
    // 读不到表清单时按"不存在"处理(调用方会回一句"表不存在或表名不合法"并进日志), 不把异常抛到页面
    return false;
  }
}

// ---------------------------------------------------------------------------
// 元数据缓存(2.2.9): 表清单 / 列 / 索引 / 建表语句 / 字段总览都是"结构不变就永远一样"的东西,
// 但每读一次都要计进 D1 的 rows_read(账号额度 5M, 2026-10-07 已用 28.98k)。这里在**同一个
// isolate** 内短期复用:
//   · 键用 `env.DB`(D1 绑定对象在 isolate 内稳定; 测试里每个 env 都是新的 → 天然互不干扰);
//   · **只缓存结构, 绝不缓存行数与数据** —— 那会显示过期数字(见 countRows 的注释);
//   · TTL 60 秒: 结构变更只能走 wrangler(重新部署会换 isolate), 60 秒足够挡住连点与来回切视图;
//   · 绑定对象身份若在某个运行时里不稳定, 也只是"缓存不命中", 不影响正确性;
//   · clearMetaCache(env) 供测试与"刚改过结构"时手动失效。
// ---------------------------------------------------------------------------
const META_TTL_MS = 60 * 1000;
const metaStores = new WeakMap();

function storeOf(env) {
  const binding = env && env.DB;
  if (!binding || (typeof binding !== 'object' && typeof binding !== 'function')) return null;
  let store = metaStores.get(binding);
  if (!store) {
    store = { tables: null, tablesAt: 0, byTable: new Map(), columns: null, columnsAt: 0 };
    metaStores.set(binding, store);
  }
  return store;
}

function isFresh(at) {
  return Boolean(at) && Date.now() - at < META_TTL_MS;
}

/** 手动失效某个 env 的元数据缓存(测试用; 线上结构变更只能靠重新部署)。 */
export function clearMetaCache(env) {
  const binding = env && env.DB;
  if (binding) metaStores.delete(binding);
}

async function tableNamesCached(env) {
  const store = storeOf(env);
  if (store && isFresh(store.tablesAt)) return store.tables;
  const names = await tableNames(env);
  if (store) {
    store.tables = names;
    store.tablesAt = Date.now();
  }
  return names;
}

/** 与 core/db.js 的 all 同形, 额外把 D1 的 meta(用量)一起带回来 —— 页面要显示"这次读了多少行"。 */
async function allWithMeta(env, sql, ...args) {
  const result = await env.DB.prepare(sql).bind(...args).all();
  const raw = result && result.results;
  // D1 正常回数组; 兼容"单个对象"的松散返回(测试桩按单行喂数时就是这样), 免得把一行当成零行
  const rows = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  return { rows, stats: statsOf(result) };
}

/** 敏感列脱敏: 只处理结果集(不改库), 列名命中即打码。 */
export function maskRows(rows) {
  return (rows || []).map((row) => {
    const out = {};
    Object.keys(row || {}).forEach((key) => {
      out[key] = SENSITIVE_COLUMNS.has(String(key).toLowerCase()) ? '***' : row[key];
    });
    return out;
  });
}

/**
 * 语句分类 —— 唯一判定入口(前端"需要二次确认"的提示与后端拦截共用同一套规则)。
 *
 * 返回 { kind: 'read' | 'write' | 'reject', reason, tables: [], danger }
 * danger: 写语句里**没有 WHERE** 的 UPDATE / DELETE(整表改动) —— 前端据此多问一句,
 * 不影响 kind(后端仍按原口径只要求 confirm=1, 保持既有功能不变)。
 */
export function classifyStatement(sql) {
  const text = String(sql || '').trim();
  if (!text) return { kind: 'reject', reason: '请输入要执行的 SQL', tables: [], danger: false };

  // 多语句: 去掉结尾分号后还有分号 → 拒绝(旧站也只在单条语句上做保护)
  const body = text.replace(/;+\s*$/, '');
  if (body.includes(';')) {
    return { kind: 'reject', reason: '一次只能执行一条语句（请去掉中间的分号）', tables: [], danger: false };
  }

  const upper = body.toUpperCase().replace(/\s+/g, ' ');
  const first = upper.split(' ')[0];
  const write = /^(INSERT|UPDATE|DELETE)$/.test(first);
  const read = first === 'SELECT' || upper.startsWith('EXPLAIN ');
  if (!write && !read) {
    return {
      kind: 'reject',
      reason: '只允许 SELECT / INSERT / UPDATE / DELETE（不接受建表、改表、删表等结构变更）',
      tables: [],
      danger: false
    };
  }

  // 抽取被引用的表名: 三处写法覆盖 INSERT/UPDATE/DELETE 与 FROM/JOIN
  const tables = new Set();
  const patterns = [
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi,
    /\b(?:FROM|JOIN)\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) tables.add(match[1]);
  }
  const list = Array.from(tables);
  const outside = list.filter((name) => !SAFE_TABLES.includes(name));
  if (outside.length) {
    return {
      kind: 'reject',
      reason: `只允许操作这些业务表：${SAFE_TABLES.join('、')}`,
      tables: list,
      danger: false
    };
  }
  const danger = /^(UPDATE|DELETE)/.test(first) && !/\bWHERE\b/.test(upper);
  return { kind: write ? 'write' : 'read', reason: '', tables: list, danger };
}

/**
 * 读一张表的"结构核心"(列 / 索引及索引列 / 建表语句): 优先 PRAGMA, 失败则解析 sqlite_master.sql(旧站同路数)。
 * 调用方是 tableMeta, 结果会进元数据缓存 —— 这里不做行数统计(行数会变, 不进缓存)。
 */
async function readTableCore(env, name) {
  let columns = [];
  let indexes = [];
  let viaPragma = true;
  let createSql = '';
  try {
    const info = await all(env, `PRAGMA table_info("${name}")`);
    columns = (info || []).map((row) => ({
      name: String(row.name || ''),
      type: String(row.type || ''),
      notnull: Number(row.notnull) || 0,
      pk: Number(row.pk) || 0,
      default: row.dflt_value === undefined || row.dflt_value === null ? '' : String(row.dflt_value),
      comment: ''
    }));
    const list = await all(env, `PRAGMA index_list("${name}")`).catch(() => []);
    // 索引列**不**再"一条索引一次 PRAGMA index_info": D1 是单线程串行执行, 并发发出只是同时排队,
    // 语句数一样多(2.2.7 在 news 上就是 9 条 PRAGMA = 9 次串行等待)。改为一次读全部索引的 DDL,
    // 在本地把 `CREATE INDEX ... ON t (a, b)` 的列名解析出来; 只有解析不出来(自动索引 sql 为 NULL,
    // 或表达式索引)才退回 PRAGMA —— 正常情况从 N+1 条降到 1 条。
    const defs = await all(env, "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?", name)
      .catch(() => []);
    const sqlByName = new Map((defs || []).map((row) => [String(row.name || ''), String(row.sql || '')]));
    for (const row of list || []) {
      const indexName = String(row.name || '');
      let columnsOfIndex = indexColumnsFromSql(sqlByName.get(indexName));
      if (!columnsOfIndex.length) {
        columnsOfIndex = await all(env, `PRAGMA index_info("${indexName}")`)
          .then((items) => (items || []).map((item) => String(item.name || '')).filter(Boolean))
          .catch(() => []);
      }
      indexes.push({ name: indexName, unique: Number(row.unique) || 0, columns: columnsOfIndex });
    }
  } catch (error) {
    viaPragma = false;
  }
  if (!columns.length) {
    const row = await one(env, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", name).catch(() => null);
    createSql = String((row && row.sql) || '');
    if (!createSql) return { columns: [], indexes, createSql: '', viaPragma: false, failed: true };
    columns = parseCreateSql(createSql);
    viaPragma = false;
  }
  return { columns, indexes, createSql, viaPragma, failed: false };
}

/** 表结构 + 索引(含索引列) + 主键列; 结果进元数据缓存(结构不进则不重复读, 省 rows_read)。 */
export async function tableMeta(env, name, options = {}) {
  if (!(await tableExists(env, name))) {
    return { ok: false, reason: '表不存在或表名不合法' };
  }
  // withCount: 顺带把"这张表多少行"一起查回来(结构页要用) —— 表名上面刚校验过, 不再重复读表清单。
  // 行数**不进缓存**: 数据在变, 缓存它会让页面显示过期数字
  const rowCount = options.withCount ? await countRowsUnchecked(env, name) : null;
  const store = storeOf(env);
  let core = store ? store.byTable.get(name) : null;
  if (!core || !isFresh(core.at)) {
    core = await readTableCore(env, name);
    core.at = Date.now();
    if (store) store.byTable.set(name, core);
  }
  if (options.withSql && !core.createSql) {
    const row = await one(env, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", name).catch(() => null);
    core.createSql = String((row && row.sql) || '');
  }
  if (core.failed || !core.columns.length) return { ok: false, reason: '读取表结构失败' };
  return {
    ok: true,
    name,
    columns: core.columns,
    columnNames: core.columns.map((column) => column.name),
    pkColumns: core.columns.filter((column) => column.pk).map((column) => column.name),
    indexes: core.indexes,
    createSql: core.createSql,
    rowCount,
    viaPragma: core.viaPragma
  };
}

/**
 * 从 `CREATE [UNIQUE] INDEX name ON table (col1, col2 DESC) [WHERE ...]` 里解析索引列。
 * 解析不出来(自动索引的 sql 为 NULL、表达式索引等)返回空数组, 调用方退回 PRAGMA index_info。
 */
export function indexColumnsFromSql(createSql) {
  const text = String(createSql || '');
  const match = text.match(/\bON\b[\s\S]*?\(([\s\S]*?)\)/i);
  if (!match) return [];
  const body = match[1];
  if (/[()]/.test(body)) return [];          // 表达式索引: 交给 PRAGMA
  return body.split(',').map((part) => {
    const item = part.trim();
    const name = item.split(/\s+/)[0].replace(/["'`[\]]/g, '');
    return /^(desc|asc|collate|where)$/i.test(name) ? '' : name;
  }).filter(Boolean);
}

/** 单表行数(1 条 COUNT, 不再检查表名是否存在): 只在调用方已经校验过表名时用, 省掉重复的表清单查询。 */
async function countRowsUnchecked(env, name) {
  const row = await one(env, `SELECT COUNT(*) AS c FROM "${name}"`).catch(() => null);
  return row === null ? null : Number(row.c || 0);
}

/** 单表行数(1 条 COUNT): 结构页/数据页用它显示"这张表有多少行", 不再顺带统计全库。 */
export async function countRows(env, name) {
  if (!(await tableExists(env, name))) return null;
  return countRowsUnchecked(env, name);
}

//: 字段总览的取法: 'query' = 一条 SQL 关联 pragma 表函数(1 条语句拿全库字段); 'pragma' = 回退逐表 PRAGMA。
//  注意: 本仓库记过一次"D1 上复合 SELECT 会失败"的先例(app/core/overview.js 的注释), 所以这条查询
//  一旦失败就**记住模式**改走 PRAGMA(不再每页重试那条无效查询), 并且失败原因进日志。
//  失败标记也带 TTL: 万一是"一次偶发错误", 一分钟后会再试一次快路, 不会永久退化成慢路。
let columnsMode = 'query';
let columnsModeSince = 0;

/**
 * 字段总览(2.2.9): 所有表的所有字段, 供"表与字段一屏可读"。
 * 快路 = 一条 `sqlite_master JOIN pragma_table_info(...)` —— 语句数与往返都只有 1 次;
 * 慢路 = 逐表 tableMeta(走元数据缓存, 第二次起几乎不花 rows_read)。
 * 返回 { ok, mode, tables: [{ name, columns: [...] }], columnCount, stats }。
 */
export async function allColumns(env) {
  const store = storeOf(env);
  if (store && isFresh(store.columnsAt)) return store.columns;

  const names = await tableNamesCached(env);
  const result = await buildAllColumns(env, names);
  if (store) {
    store.columns = result;
    store.columnsAt = Date.now();
  }
  return result;
}

async function buildAllColumns(env, names) {
  if (!names.length) return { ok: true, mode: columnsMode, tables: [], columnCount: 0, stats: null };
  // 回退到 PRAGMA 只是记住"上次失败", 超过 TTL 再试一次快路
  if (columnsMode === 'pragma' && Date.now() - columnsModeSince > META_TTL_MS) columnsMode = 'query';

  if (columnsMode === 'query') {
    try {
      const { rows, stats } = await allWithMeta(env,
        'SELECT m.name AS table_name, p.name AS column_name, p.type AS column_type,'
        + ' p."notnull" AS column_notnull, p.dflt_value AS column_default, p.pk AS column_pk'
        + ' FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS p'
        + " WHERE m.type = 'table' ORDER BY m.name, p.cid");
      const byTable = new Map();
      for (const row of rows) {
        const table = String(row.table_name || '');
        if (!byTable.has(table)) byTable.set(table, []);
        byTable.get(table).push({
          name: String(row.column_name || ''),
          type: String(row.column_type || ''),
          notnull: Number(row.column_notnull) || 0,
          pk: Number(row.column_pk) || 0,
          default: row.column_default === undefined || row.column_default === null ? '' : String(row.column_default)
        });
      }
      // 只保留业务表(tableNames 已滤掉 sqlite_/_cf_/d1_migrations, 这条查询会把它们也带回来)
      const tables = names.map((name) => ({ name, columns: byTable.get(name) || [] }));
      return {
        ok: true, mode: 'query', tables,
        columnCount: tables.reduce((sum, item) => sum + item.columns.length, 0),
        stats
      };
    } catch (error) {
      columnsMode = 'pragma';
      columnsModeSince = Date.now();
      logWarn('admin.db_columns_query_failed', { reason: error && error.message });
    }
  }

  const tables = [];
  let columnCount = 0;
  for (const name of names) {
    const meta = await tableMeta(env, name);
    const columns = meta.ok ? meta.columns : [];
    tables.push({ name, columns });
    columnCount += columns.length;
  }
  return { ok: true, mode: 'pragma', tables, columnCount, stats: null };
}

/**
 * 取单行的完整数据(按隐式 rowid): 数据页的"取完整行"按钮用它。
 * 页面默认只内嵌**截断过**的行数据(几十 KB → 几 KB), 需要完整值时再点一次取一行。
 * 返回 { ok, row, rowKeys, pkColumns } 或 { ok:false, reason }。
 */
export async function tableRow(env, name, rowid) {
  if (!(await tableExists(env, name))) return { ok: false, reason: '表不存在或表名不合法' };
  const target = Number(rowid);
  if (!Number.isFinite(target)) return { ok: false, reason: 'rowid 必须是数字' };
  let rows = await all(env, `SELECT * FROM "${name}" WHERE rowid = ? LIMIT 1`, target).catch(() => null);
  if (rows === null) return { ok: false, reason: '这张表没有 rowid（WITHOUT ROWID），请用主键在 SQL 控制台里查' };
  if (!rows.length) return { ok: false, reason: '找不到这一行（可能刚被改动）' };
  const masked = maskRows(rows)[0];
  const meta = await tableMeta(env, name);
  return {
    ok: true, name, row: masked, rowKeys: Object.keys(masked),
    pkColumns: meta.ok ? meta.pkColumns : []
  };
}

/** 从 CREATE TABLE 语句里解析列(PRAGMA 不可用时的回退): 取行内 `--` 注释当列说明。 */
export function parseCreateSql(createSql) {
  const lines = String(createSql || '').split('\n').slice(1);
  const columns = [];
  const skip = new Set(['primary', 'unique', 'key', 'index', 'constraint', 'foreign', 'check']);
  for (const raw of lines) {
    const [codePart, commentPart] = String(raw).split('--', 2);
    const code = codePart.trim().replace(/,$/, '');
    if (!code || code.startsWith(')')) continue;
    const head = code.split(/\s+/)[0].replace(/["'`[\]]/g, '');
    if (!head || skip.has(head.toLowerCase())) continue;
    const type = (code.split(/\s+/)[1] || '').replace(/,$/, '');
    columns.push({
      name: head,
      type,
      notnull: /not\s+null/i.test(code) ? 1 : 0,
      pk: /primary\s+key/i.test(code) ? 1 : 0,
      default: '',
      comment: commentPart ? commentPart.trim() : ''
    });
  }
  return columns;
}

/**
 * 表清单(可选带行数)。
 * 行数走 core/overview.js 的 countTables —— 那里用 D1 原生 **batch** 一次往返跑 N 条 COUNT。
 * ⚠️ 注意 D1 是**单线程串行处理**: batch 省的是 HTTP 往返, 库侧仍是逐条执行, 所以 N 张大表的
 * COUNT(*) 仍然很贵 —— 因此页面只在"表清单视图"默认统计, 其它视图一律不统计(withCounts=false),
 * 需要时再点"统计行数"。
 */
export async function tableList(env, options = {}) {
  if (options.withCounts === false) {
    try {
      // 走元数据缓存: 同一分钟内来回切视图不再重复读 sqlite_master(省 rows_read)
      const names = await tableNamesCached(env);
      return {
        ok: true, withCounts: false, total: 0,
        tables: names.map((name) => ({ name, count: null }))
      };
    } catch (error) {
      return { ok: false, withCounts: false, total: 0, tables: [], reason: '读取表清单失败' };
    }
  }
  const counted = await countTables(env);
  if (counted.failed) {
    return { ok: false, withCounts: true, total: 0, tables: [], reason: counted.reason || '读取表清单失败' };
  }
  return {
    ok: true, withCounts: true, total: counted.total,
    tables: counted.rows.map(([name, count]) => ({ name, count }))
  };
}

/**
 * 数据分页(只读): 单页上限 50, 敏感列脱敏。
 * view = { sort, dir, column, value, q }: 排序 / 按字段筛选(子串) / 关键字搜索(跨列 OR 子串)。
 * 列名一律先用 PRAGMA 读到的真实列名校验, 拼 SQL 时再整体加引号 —— 不接受任意输入。
 * 同时返回 rowid(第一列 __rowid): 单行"生成 UPDATE"靠它, 没有 rowid 的表(WITHOUT ROWID)自动退回不带。
 */
export async function tablePage(env, name, page = 1, pageSize = 20, view = {}) {
  if (!(await tableExists(env, name))) return { ok: false, reason: '表不存在或表名不合法' };
  const size = Math.min(Math.max(1, Number(pageSize) || 20), MAX_PAGE_SIZE);
  const current = Math.max(1, Number(page) || 1);
  const meta = await tableMeta(env, name);
  const columnNames = meta.ok ? meta.columnNames : [];
  const wanted = String(view.sort === undefined || view.sort === null ? '' : view.sort).trim();
  const sort = columnNames.includes(wanted) ? wanted : '';
  const dir = String(view.dir || '').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const wantedColumn = String(view.column === undefined || view.column === null ? '' : view.column).trim();
  const column = columnNames.includes(wantedColumn) ? wantedColumn : '';
  const value = String(view.value === undefined || view.value === null ? '' : view.value).trim();
  const keyword = String(view.q === undefined || view.q === null ? '' : view.q).trim();

  const clauses = [];
  const args = [];
  if (column && value) {
    clauses.push(`"${column}" LIKE ?`);
    args.push(`%${value}%`);
  }
  if (keyword) {
    const searchable = columnNames.slice(0, MAX_SEARCH_COLUMNS);
    if (searchable.length) {
      clauses.push(`(${searchable.map((item) => `"${item}" LIKE ?`).join(' OR ')})`);
      for (let index = 0; index < searchable.length; index += 1) args.push(`%${keyword}%`);
    }
  }
  const whereSql = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const orderSql = sort ? ` ORDER BY "${sort}" ${dir}` : '';

  // 这一屏只有两条语句: COUNT + 取数(2.2.9 起把两条的 D1 用量一起回传, 页面显示"这次读了多少行")
  const counted = await allWithMeta(env, `SELECT COUNT(*) AS c FROM "${name}"${whereSql}`, ...args);
  const total = Number((counted.rows[0] && counted.rows[0].c) || 0);
  const pages = Math.max(1, Math.ceil(total / size));
  const offset = (Math.min(current, pages) - 1) * size;

  // rowid 是普通表才有的隐式列: 取不到就退回不带(例如 WITHOUT ROWID 表)
  let picked = await allWithMeta(env,
    `SELECT rowid AS __rowid, * FROM "${name}"${whereSql}${orderSql} LIMIT ? OFFSET ?`, ...args, size, offset)
    .catch(() => null);
  let hasRowid = picked !== null;
  if (!hasRowid) {
    picked = await allWithMeta(env,
      `SELECT * FROM "${name}"${whereSql}${orderSql} LIMIT ? OFFSET ?`, ...args, size, offset);
  }
  const rows = maskRows(picked.rows);
  return {
    ok: true,
    name,
    rows,
    rowKeys: rows.length ? Object.keys(rows[0]) : [],
    total,
    page: Math.min(current, pages),
    pages,
    page_size: size,
    columns: columnNames,
    pkColumns: meta.ok ? meta.pkColumns : [],
    hasRowid,
    sort,
    dir: sort ? dir : '',
    column,
    value,
    q: keyword,
    filtered: Boolean(whereSql),
    stats: combineStats(counted.stats, picked.stats)
  };
}

/**
 * 按 rowid 批量取行(2.2.9): 批量"复制所选行"用 —— **一条** `rowid IN (...)` 就够,
 * 不要按行发 N 次请求(D1 单线程串行, N 行就是 N 次串行等待 + N 倍 rows_read)。
 * 上限 50 行(与数据页单页一致); 敏感列同样打码。
 */
export async function tableRows(env, name, rowids) {
  if (!(await tableExists(env, name))) return { ok: false, reason: '表不存在或表名不合法' };
  // 只认整数(rowid 可以是负数, 但不接受空串/"abc"/"1.5" 这类): 免得把 `rowids=,` 当成两行 rowid 0
  const targets = (Array.isArray(rowids) ? rowids : [])
    .map((item) => String(item === undefined || item === null ? '' : item).trim())
    .filter((item) => /^-?\d+$/.test(item))
    .map((item) => Number(item))
    .slice(0, MAX_PAGE_SIZE);
  if (!targets.length) return { ok: false, reason: '没有选中任何行' };
  const holes = targets.map(() => '?').join(', ');
  const picked = await allWithMeta(env, `SELECT rowid AS __rowid, * FROM "${name}" WHERE rowid IN (${holes})`, ...targets)
    .catch(() => null);
  if (picked === null) return { ok: false, reason: '这张表没有 rowid（WITHOUT ROWID），请用主键在 SQL 控制台里查' };
  const rows = maskRows(picked.rows);
  const meta = await tableMeta(env, name);
  return {
    ok: true, name, rows, rowKeys: rows.length ? Object.keys(rows[0]) : [],
    pkColumns: meta.ok ? meta.pkColumns : [], stats: picked.stats
  };
}

/** 把数据库的报错收成一行可展示的短句(过长截断; 换行压平, 免得撑破控制台)。 */
function shortDbError(error) {
  return String((error && error.message) || error || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** 从 D1 返回的 meta 里取出用量(duration 毫秒、rows_read/rows_written) —— 用于页面上做成本估算。 */
function statsOf(result) {
  const meta = (result && result.meta) || {};
  const read = Number(meta.rows_read || 0);
  const written = Number(meta.rows_written || 0);
  const duration = Number(meta.duration || 0);
  return {
    rowsRead: read,
    rowsWritten: written,
    durationMs: duration,
    // 一句话成本: D1 按"读了多少行"计费(全表扫描最贵), 所以把它显式摆到页面上
    costText: `读 ${read} 行 · 写 ${written} 行${duration ? ` · ${duration} ms` : ''}`
  };
}

/** 把一份渲染里几条语句的用量相加(例如数据页的 COUNT + 取数)。 */
function combineStats(...list) {
  const total = { rowsRead: 0, rowsWritten: 0, durationMs: 0 };
  let seen = false;
  for (const item of list) {
    if (!item) continue;
    seen = true;
    total.rowsRead += Number(item.rowsRead || 0);
    total.rowsWritten += Number(item.rowsWritten || 0);
    total.durationMs += Number(item.durationMs || 0);
  }
  if (!seen) return null;
  return Object.assign({}, total, {
    costText: `读 ${total.rowsRead} 行 · 写 ${total.rowsWritten} 行${total.durationMs ? ` · ${total.durationMs} ms` : ''}`
  });
}

/**
 * 执行一条 SQL —— 与浏览能力分开的第二道闸(classifyStatement 已保证单语句 + 白名单表)。
 * 返回 { ran, rows, rowKeys, affected, message, stats, detail?, warning?, truncated? } 或 { error, detail? }。
 * 读语句最多回传 MAX_EXEC_ROWS 行(超出置 truncated=true 并在消息里说明, 提示加 LIMIT)。
 * stats 来自 D1 的 meta(rows_read/rows_written/duration): 页面据此显示"这次查询花了多少"。
 */
export async function runStatement(env, sql) {
  const verdict = classifyStatement(sql);
  if (verdict.kind === 'reject') return { error: verdict.reason };
  const statement = String(sql).trim().replace(/;+\s*$/, '');
  const started = Date.now();
  const warning = verdict.danger ? '这条语句没有 WHERE：会改动/删除整表数据。' : '';
  try {
    if (verdict.kind === 'read') {
      const result = await env.DB.prepare(statement).all();
      const allRows = maskRows(result.results || []);
      const rows = allRows.slice(0, MAX_EXEC_ROWS);
      const truncated = allRows.length > rows.length;
      const stats = statsOf(result);
      return {
        ran: true,
        rows,
        rowKeys: rows.length ? Object.keys(rows[0]) : [],
        affected: 0,
        truncated,
        warning,
        stats,
        message: `查询成功，返回 ${allRows.length} 行`
          + (truncated ? `（只展示前 ${MAX_EXEC_ROWS} 行，请加 LIMIT 或分页查询）` : '')
          + `｜${stats.costText}`,
        costMs: Date.now() - started
      };
    }
    const result = await env.DB.prepare(statement).run();
    const affected = Number((result && result.meta && result.meta.changes) || 0);
    const stats = statsOf(result);
    return {
      ran: false,
      rows: [],
      rowKeys: [],
      affected,
      warning,
      stats,
      message: `执行成功，影响 ${affected} 行｜${stats.costText}`,
      costMs: Date.now() - started
    };
  } catch (error) {
    // 错误详情进日志(既有口径) + 额外回一句数据库原文(2.2.7 起, 仅超管页面可见, 便于定位语法/约束问题)
    logWarn('admin.db_manage_failed', { sql: statement.slice(0, 200), reason: error && error.message });
    return {
      error: '执行失败，请检查语句（详情见服务端日志）',
      detail: shortDbError(error)
    };
  }
}
