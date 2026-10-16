// 数据库工具 + 素材库治理两页的行为(对照旧站 dbadmin.py / media_admin.py)
//
// 重点盯"闸门"与"判定"两类问题: 开关默认关、只允许白名单业务表、写语句必须二次确认、
// 敏感列脱敏、有引用一律拒绝删除(含回收站)。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handleAdmin } from '../app/admin/index.js';
import { API_VERSION } from '../main.js';
import { HOST, findCall, get, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

// 2.5.0: 两页的页尾/页内脚本从模板字符串搬到了 static/js/*.js —— 涉及脚本内容的断言统一读这两个文件
const DB_TOOLS_SCRIPT = new URL('../app/admin/static/js/db_tools.js', import.meta.url);
const MEDIA_GOVERN_SCRIPT = new URL('../app/admin/static/js/media_govern.js', import.meta.url);

// 数据库工具页要用到的 D1 桩: 表清单 / 行数 / PRAGMA / 分页
function dbStub(sql) {
  // 建表语句那一句也含 "FROM sqlite_master WHERE type='table'", 必须先判(否则会被当成表清单)
  if (/SELECT sql FROM sqlite_master/i.test(sql)) return { sql: 'CREATE TABLE news (\n id INTEGER PRIMARY KEY,\n title TEXT -- 标题\n)' };
  if (/FROM sqlite_master WHERE type='table'/i.test(sql)) return [{ name: 'news' }, { name: 'users' }];
  if (/PRAGMA table_info/i.test(sql)) {
    return [
      { name: 'id', type: 'INTEGER', notnull: 1, pk: 1, dflt_value: null },
      { name: 'title', type: 'TEXT', notnull: 0, pk: 0, dflt_value: "'未命名'" }
    ];
  }
  if (/PRAGMA index_list/i.test(sql)) return [{ name: 'idx_news_status', unique: 0 }];
  if (/PRAGMA index_info/i.test(sql)) return [{ name: 'title' }];
  // 2.2.8: 索引列改为一次读索引 DDL 后本地解析(不再一条索引一次 PRAGMA index_info)
  if (/FROM sqlite_master WHERE type='index'/i.test(sql)) {
    return [{ name: 'idx_news_status', sql: 'CREATE INDEX idx_news_status ON news (title)' }];
  }
  // 2.2.9: 字段总览走"一条 SQL 关联 pragma 表函数"(D1 若不支持会回退, 见 lib/dbTool.js 的 columnsMode)
  if (/JOIN pragma_table_info/i.test(sql)) {
    return [
      { table_name: 'news', column_name: 'id', column_type: 'INTEGER', column_notnull: 1, column_default: null, column_pk: 1 },
      { table_name: 'news', column_name: 'title', column_type: 'TEXT', column_notnull: 0, column_default: "'未命名'", column_pk: 0 },
      { table_name: 'users', column_name: 'id', column_type: 'INTEGER', column_notnull: 1, column_default: null, column_pk: 1 },
      { table_name: 'users', column_name: 'token', column_type: 'TEXT', column_notnull: 0, column_default: null, column_pk: 0 }
    ];
  }
  if (/COUNT\(\*\) AS c FROM "news"/i.test(sql)) return { c: 69 };
  // 数据页第一句是 `SELECT rowid AS __rowid, * FROM "news" ...`(2.2.7 给单行定位加的行号列)
  if (/SELECT rowid AS __rowid, \* FROM "news"/i.test(sql)) return [{ __rowid: 1, id: 1, title: '标题' }];
  if (/SELECT \* FROM "news"/i.test(sql)) return [{ id: 1, title: '标题' }];
  if (/SELECT sql FROM sqlite_master/i.test(sql)) return { sql: 'CREATE TABLE news (\n id INTEGER PRIMARY KEY,\n title TEXT -- 标题\n)' };
  if (/SELECT token FROM users/i.test(sql)) return [{ token: 'plain-token' }];
  return undefined;
}

async function toolsEnv(extra = {}) {
  // 页面里的"数据表状态"要走 countTables(逐表 batch COUNT), 桩按 counts 喂数
  const made = makeAdminEnv(Object.assign({ role: 'super', db: dbStub, counts: { news: 69, users: 4 } }, extra));
  made.env.ENABLE_SQL_TOOL = '1';
  return made;
}

test('数据库管理: 默认关闭(ENABLE_SQL_TOOL=0 时不暴露表与控制台)', async () => {
  const { env } = makeAdminEnv({ role: 'super', db: dbStub });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage', env, cookie)).text();
  assert.match(html, /数据库管理未开启/);
  // 关闭时不渲染 SQL 控制台(用表单 id 判定, 别用"执行 SQL"这种会出现在说明文案里的词)
  assert.ok(!html.includes('id="sqlForm"'));

  const res = await post('/admin/db_manage/exec', { sql: 'SELECT id FROM news' }, env, cookie);
  assert.equal((await res.json()).code, 403);
});

test('数据库工具: 开启后出表清单与结构(含行数), 表详情走 JSON', async () => {
  const { env } = await toolsEnv();
  const cookie = await loginCookie(env);

  const html = await (await get('/admin/db_manage', env, cookie)).text();
  assert.match(html, /数据表状态/);
  assert.match(html, /执行 SQL/);
  assert.ok(html.includes('news'));
  assert.ok(html.includes('69'));

  const detail = await (await get('/admin/db_manage?table=news', env, cookie)).text();
  assert.match(detail, /结构/);
  assert.match(detail, /标题/);

  const json = await (await get('/admin/db_manage/table?name=news', env, cookie)).json();
  assert.equal(json.code, 200);
  assert.equal(json.data.total, 69);
  // 第一列是隐式 rowid(单行"生成 UPDATE"靠它定位), 后面才是业务列
  assert.deepEqual(json.data.row_keys, ['__rowid', 'id', 'title']);
  assert.equal(json.data.columns.length, 2);
  assert.equal(json.data.has_rowid, true);
});

test('数据库工具: 结构给全(默认值/主键/索引列)并可一键复制', async () => {
  const { env } = await toolsEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage?table=news&view=structure', env, cookie)).text();
  assert.ok(html.includes('默认值'), '结构表要有默认值列');
  assert.ok(html.includes('未命名'), '默认值要显示出来(引号会被 HTML 转义)');
  assert.ok(html.includes('主键'), '主键要标出来');
  assert.ok(html.includes('idx_news_status'), '索引名单要列出来');
  assert.ok(html.includes('<code>title</code>'), '索引列要显示(PRAGMA index_info)');
  assert.ok(html.includes('data-copy="id, title"'), '可复制列名');
  assert.ok(html.includes('复制建表语句'), '可复制 CREATE 语句');
  // 结构页不查数据
  assert.ok(!html.includes('数据（第'), '结构视图不渲染数据表');
});

test('数据库工具: 数据页可排序/按字段筛选/跨列搜索, 参数进 URL 且列名先校验', async () => {
  const { env, state } = await toolsEnv();
  const cookie = await loginCookie(env);

  // 点列头排序: 链接带 sort/dir, 再点一次换方向(数据查询 = SELECT rowid AS __rowid, * ...)
  const sorted = await (await get('/admin/db_manage?table=news&sort=title&dir=asc', env, cookie)).text();
  assert.ok(/href="[^"]*sort=title&amp;dir=desc[^"]*"/.test(sorted), '同一列再点一次要换方向');
  const orderCall = findCall(state, /SELECT rowid AS __rowid, \* FROM "news"/i);
  assert.ok(/"title" ASC/i.test(orderCall.sql), `排序要进 SQL: ${orderCall.sql}`);

  // 按字段筛选 + 关键字搜索: 都进 SQL 且参数是子串
  state.calls.length = 0;
  await (await get('/admin/db_manage?table=news&col=title&val=户外&q=雨崩', env, cookie)).text();
  const filtered = findCall(state, /SELECT rowid AS __rowid, \* FROM "news"/i);
  assert.ok(/"title" LIKE \?/i.test(filtered.sql), '字段筛选要进 SQL');
  assert.ok(filtered.args.includes('%户外%'), '字段筛选是子串匹配');
  assert.ok(filtered.args.includes('%雨崩%'), '关键字搜索也是子串');
  // 关键字只搜"文本列"(桩里 news 只有 title 是 TEXT): 全表扫描下搜数字列纯属多花 rows_read
  assert.equal((filtered.sql.match(/LIKE \?/g) || []).length, 2, '字段筛选 1 个 + 文本列 title 的 1 个');
  assert.ok(!/"id" LIKE \?/i.test(filtered.sql), '整数列不参与关键字搜索');

  // 前缀匹配选项: 参数换成 `kw%`, 能用上索引(页面上的复选框就是它)
  state.calls.length = 0;
  const prefixed = await (await get('/admin/db_manage?table=news&q=雨崩&prefix=1', env, cookie)).text();
  const prefixCall = findCall(state, /SELECT rowid AS __rowid, \* FROM "news"/i);
  assert.ok(prefixCall.args.includes('雨崩%'), 'prefix=1 时按前缀匹配');
  assert.ok(!prefixCall.args.includes('%雨崩%'), '不能再退化成包含匹配');
  assert.ok(prefixed.includes('name="prefix"'), '页面上要有前缀匹配开关');

  // 2.3.4: 这一页的筛选/搜索条也走全站共用结构(searchBar), 不再 width:auto / max-width / 漏斗图标
  const page = await (await get('/admin/db_manage?table=news&col=title&val=户外&q=雨崩', env, cookie)).text();
  const bar = page.match(/<form class="search-bar[\s\S]*?<\/form>/)[0];
  assert.ok(bar.includes('class="form-select form-select-sm search-select-lg" name="col"'),
    '字段下拉走共用下拉(字段名长, 用 lg 宽度)');
  assert.equal((bar.match(/class="form-control form-control-sm search-input"/g) || []).length, 2,
    '两个输入框(字段值/全列关键字)都走共用输入框');
  assert.ok(bar.includes('<i class="bi bi-search" aria-hidden="true"></i> 搜索</button>'), '搜索按钮样式/图标/文案统一');
  assert.ok(bar.includes('name="table"') && bar.includes('name="view"') && bar.includes('name="size"'), '隐藏字段照旧带过去');
  assert.ok(!/max-width:|style="width:auto"/.test(bar), '不再用 max-width / width:auto 定宽');
  const listFilter = page.match(/<input[^>]*data-filter-tables[^>]*>/)[0];
  assert.ok(listFilter.includes('class="form-control form-control-sm search-input"'),
    '表名本地筛选框也用同一个输入框(宽度一致)');

  // 非法列名被忽略(不给注入留口子)
  state.calls.length = 0;
  await (await get('/admin/db_manage?table=news&sort=1;DROP&col=id;--&q=x', env, cookie)).text();
  const safe = findCall(state, /SELECT rowid AS __rowid, \* FROM "news"/i);
  assert.ok(!/DROP/i.test(safe.sql) && !/--/i.test(safe.sql), '非法列名不能拼进 SQL');
});

test('数据库工具: 表清单行数走 batch 一次往返, 可关掉统计, 表名可本地筛选', async () => {
  let batchCalls = 0;
  const { env } = makeAdminEnv({
    role: 'super',
    db: dbStub,
    counts: { news: 69, users: 4 },
    batch: (list) => {
      batchCalls += 1;
      return list.map(() => ({ results: [{ c: 1 }], meta: { changes: 0 } }));
    }
  });
  env.ENABLE_SQL_TOOL = '1';
  const cookie = await loginCookie(env);
  // 登录时那条"清理限流计数"走的也是 batch, 这里只数页面渲染发出的
  batchCalls = 0;

  const withCounts = await (await get('/admin/db_manage', env, cookie)).text();
  assert.equal(batchCalls, 1, '两张表也只发一次 batch(不是逐表串行 COUNT)');
  assert.ok(withCounts.includes('合计 2 行'));
  assert.ok(withCounts.includes('data-filter-tables'), '表名可本地筛选');
  assert.ok(withCounts.includes('复制表名'), '可一键复制表名');

  batchCalls = 0;
  const without = await (await get('/admin/db_manage?counts=0', env, cookie)).text();
  assert.equal(batchCalls, 0, '关掉统计后不再发 COUNT');
  assert.ok(without.includes('行数未统计'));
  assert.ok(without.includes('统计 2 张表的行数'), '可以再点回来');

  // 2.2.8: 看某张表的结构/数据时**不再顺带统计全库**(D1 单线程串行, 那 23 条 COUNT 纯属浪费)
  batchCalls = 0;
  const structure = await (await get('/admin/db_manage?table=news&view=structure', env, cookie)).text();
  assert.equal(batchCalls, 0, '结构视图不统计全库行数');
  assert.ok(structure.includes('69 行'), '结构页显示的是"这张表"的行数(1 条 COUNT)');

  batchCalls = 0;
  const data = await (await get('/admin/db_manage?table=news', env, cookie)).text();
  assert.equal(batchCalls, 0, '数据视图不统计全库行数');
  assert.ok(data.includes('行数未统计') && data.includes('省掉 2 条 COUNT'));

  // 显式 ?counts=1 时才统计(表清单视图以外也允许强开)
  batchCalls = 0;
  await (await get('/admin/db_manage?table=news&counts=1', env, cookie)).text();
  assert.equal(batchCalls, 1, 'counts=1 时按需统计');
});

test('数据库工具: 索引列一次读 DDL 本地解析(不再一条索引一次 PRAGMA)', async () => {
  const { env, state } = await toolsEnv();
  const cookie = await loginCookie(env);
  state.calls.length = 0;
  const html = await (await get('/admin/db_manage?table=news&view=structure', env, cookie)).text();

  assert.equal(state.calls.filter((call) => /PRAGMA index_info/i.test(call.sql)).length, 0,
    'news 的索引都有 DDL, 不该再逐条 PRAGMA index_info');
  assert.ok(state.calls.some((call) => /FROM sqlite_master WHERE type='index'/i.test(call.sql)),
    '索引列来自一次 sqlite_master 查询');
  // 表清单检查是轻量查询(没有全表扫描), 这里只要求"不重复读很多次"
  assert.ok(state.calls.filter((call) => /SELECT name FROM sqlite_master WHERE type='table'/i.test(call.sql)).length <= 2,
    '表清单最多读两次(页面渲染一次 + 元信息的存在性检查一次)');
  assert.ok(html.includes('idx_news_status'), '索引名照常显示');
  assert.ok(html.includes('<code>title</code>'), '索引列照常显示(本地解析 CREATE INDEX 得到)');
  // 语句总数: 表清单 1 + 本表 COUNT 1 + table_info 1 + index_list 1 + 索引 DDL 1 + 建表语句 1 ≈ 6
  assert.ok(state.calls.length <= 8, `结构视图语句数应压到个位数, 实际 ${state.calls.length}`);
});

test('数据库工具: indexColumnsFromSql 解析各种索引写法', async () => {
  const { indexColumnsFromSql } = await import('../app/admin/lib/dbTool.js');
  assert.deepEqual(indexColumnsFromSql('CREATE INDEX idx ON news (status, publish_time DESC)'),
    ['status', 'publish_time']);
  assert.deepEqual(indexColumnsFromSql('CREATE UNIQUE INDEX u ON users(email)'), ['email']);
  assert.deepEqual(indexColumnsFromSql('CREATE INDEX p ON news(status) WHERE deleted_at IS NULL'), ['status']);
  assert.deepEqual(indexColumnsFromSql('CREATE INDEX e ON news (lower(title))'), [], '表达式索引交给 PRAGMA');
  assert.deepEqual(indexColumnsFromSql(''), []);
});

test('数据库工具: 行数据按需取(列表不透传整行), 取完整行走 rowid 参数', async () => {
  const { env, state } = await toolsEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage?table=news', env, cookie)).text();
  // 列表页不再内嵌整行 JSON(2.2.7 的 news 50 行 = 269KB HTML 就是这么来的)
  assert.ok(!html.includes('data-row='), '列表页不该内嵌整行数据');
  assert.ok(/data-rowid="1"/.test(html), '行按钮带 rowid');
  assert.ok(html.includes('data-row-action="full"'), '有"取完整行"按钮');

  // 取单行: 走既有 JSON 接口的可选参数(不新增路由)
  const single = await (await get('/admin/db_manage/table?name=news&rowid=1', env, cookie)).json();
  assert.equal(single.code, 200);
  assert.equal(single.data.single, true);
  assert.equal(single.data.rowid, 1);
  assert.ok(single.data.row && single.data.row.id === 1, '取到这一行');
  const called = state.calls.some((call) => /WHERE rowid = \?/i.test(call.sql));
  assert.ok(called, '按 rowid 定位(单行查询)');

  // 非法 rowid 不炸: 明确回一句
  const bad = await (await get('/admin/db_manage/table?name=news&rowid=abc', env, cookie)).json();
  assert.equal(bad.code, 404);
  assert.match(bad.msg, /rowid/);
});

test('数据库管理: 字段总览用一条 SQL 取回全库字段(表与字段一屏可读)', async () => {
  const { env, state } = await toolsEnv();
  const cookie = await loginCookie(env);
  state.calls.length = 0;
  const html = await (await get('/admin/db_manage?view=columns', env, cookie)).text();

  const joinCalls = state.calls.filter((call) => /JOIN pragma_table_info/i.test(call.sql));
  assert.equal(joinCalls.length, 1, '全库字段只发一条语句(不是逐表 PRAGMA)');
  assert.equal(state.calls.filter((call) => /PRAGMA table_info/i.test(call.sql)).length, 0, '快路不该逐表 PRAGMA');
  assert.match(html, /字段总览/);
  assert.ok(html.includes('一次 SQL 取回'), '要如实说明取法');
  assert.ok(html.includes('news') && html.includes('users'), '两张表都要出现');
  assert.ok(html.includes('未命名'), '默认值要显示');
  assert.ok(/<span class="small text-muted">2 列<\/span>/.test(html), '每张表给出字段数');

  // ?table= 只看一张表(不额外查库)
  const one = await (await get('/admin/db_manage?view=columns&table=news', env, cookie)).text();
  assert.ok(one.includes('只看 news'));

  // 字段总览视图默认**不**统计全库行数(那会变成 20+ 条 COUNT)
  assert.ok(one.includes('行数未统计'), '字段总览不该顺带统计行数');
});

test('数据库管理: 字段总览快路失败时回退逐表 PRAGMA 并如实说明', async () => {
  const { env } = makeAdminEnv({
    role: 'super',
    counts: { news: 69 },
    db: (sql) => {
      if (/JOIN pragma_table_info/i.test(sql)) throw new Error('D1 不支持这个表函数(模拟)');
      return dbStub(sql);
    }
  });
  env.ENABLE_SQL_TOOL = '1';
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage?view=columns', env, cookie)).text();
  assert.ok(html.includes('逐表 PRAGMA（表函数不可用）'), '回退要写在页面上');
  assert.ok(html.includes('title'), '回退路径也要拿到字段');
});

test('数据库管理: 元数据缓存省掉重复读取(同一分钟内来回切视图不再读 sqlite_master)', async () => {
  const { env, state } = await toolsEnv();
  const cookie = await loginCookie(env);
  // 先热一遍(表清单 + news 的结构)
  await (await get('/admin/db_manage?table=news&view=structure', env, cookie)).text();

  state.calls.length = 0;
  await (await get('/admin/db_manage?table=news&view=structure', env, cookie)).text();
  const tableListReads = state.calls.filter((call) => /SELECT name FROM sqlite_master WHERE type='table'/i.test(call.sql));
  const pragmaReads = state.calls.filter((call) => /PRAGMA table_info/i.test(call.sql));
  assert.equal(tableListReads.length, 0, '表清单走缓存');
  assert.equal(pragmaReads.length, 0, '列结构走缓存');
  assert.ok(state.calls.length <= 2, `缓存命中后这一屏只该剩行数那条(实际 ${state.calls.length} 条)`);

  // 但**行数不进缓存**(数据在变, 缓存会显示过期数字)
  assert.ok(state.calls.some((call) => /COUNT\(\*\) AS c/i.test(call.sql)), '本表行数每次都重新数');
});

test('数据库管理: 批量取行走一条 rowid IN(…) 且最多 50 行', async () => {
  const { env, state } = await toolsEnv();
  const cookie = await loginCookie(env);
  state.calls.length = 0;
  const picked = await (await get('/admin/db_manage/table?name=news&rowids=1,2', env, cookie)).json();
  assert.equal(picked.code, 200);
  assert.equal(picked.data.multi, true);
  assert.ok(Array.isArray(picked.data.rows));
  const calls = state.calls.filter((call) => /rowid IN \(/i.test(call.sql));
  assert.equal(calls.length, 1, '两行也只发一条语句');
  assert.deepEqual(calls[0].args, [1, 2]);

  // 超过 50 个 rowid 只取前 50(与数据页单页一致)
  state.calls.length = 0;
  const many = Array.from({ length: 60 }, (item, index) => index + 1).join(',');
  await (await get(`/admin/db_manage/table?name=news&rowids=${many}`, env, cookie)).json();
  const args = state.calls.filter((call) => /rowid IN \(/i.test(call.sql))[0].args;
  assert.equal(args.length, 50, '批量上限 50 行');

  // 空参数: 明确回一句, 不炸
  const none = await (await get('/admin/db_manage/table?name=news&rowids=,', env, cookie)).json();
  assert.equal(none.code, 404);
  assert.match(none.msg, /没有选中/);
});

test('数据库管理: 单行编辑/批量删除只在页面里生成 SQL, 写入口仍然只有 exec 一个', async () => {
  const { env } = await toolsEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage?table=news', env, cookie)).text();
  assert.ok(html.includes('data-row-action="edit"'), '可写表要有"编辑"按钮');
  assert.ok(html.includes('data-batch-action="delete"'), '可写表要有批量删除');
  assert.ok(html.includes('data-row-pick') && html.includes('data-select-all'), '行首复选框与全选');
  // 编辑卡片与写语句都是页尾脚本里拼的(见 editorCard / editorSql), 所以下面几条读脚本文件;
  // 真文件里保留着 \" 这种转义(在单引号串里与 " 同义), 先还原成浏览器拿到的形态, 断言写法不变
  const rendered = (await readFile(DB_TOOLS_SCRIPT, 'utf8')).replace(/\\"/g, '"');
  assert.ok(rendered.includes('data-edit-save') && rendered.includes('data-edit-delete'), '编辑卡片里是保存/删除');
  // 页面里生成的写语句只有 UPDATE/DELETE 两种形状, 且都 POST 给 exec
  assert.ok(rendered.includes("'UPDATE \"' + editState.table"), '编辑保存 = 一条 UPDATE');
  assert.ok(rendered.includes("'DELETE FROM \"' + editState.table"), '删除 = 一条 DELETE');
  assert.ok(rendered.includes("fetch('/admin/db_manage/exec'"), '两类写操作都发给 exec(同一条安全内核)');

  // 路由没变: 页面 GET ×2 + 表详情 JSON ×2 + exec ×1, 没有第三个 POST
  const { PAGE_ROUTES } = await import('../app/admin/pages/index.js');
  const mine = PAGE_ROUTES.filter((route) => String(route.path).startsWith('/admin/db_'));
  const posts = mine.filter((route) => route.methods.includes('POST'));
  assert.equal(posts.length, 1, `只该有一个写路由, 实际 ${posts.map((route) => route.path).join(',')}`);
  assert.equal(posts[0].path, '/admin/db_manage/exec');
});

test('数据库管理: 非白名单表只读(不给编辑/批量), 并说明为什么', async () => {
  const { env } = makeAdminEnv({
    role: 'super',
    counts: { app_categories: 5 },
    db: (sql) => {
      if (/FROM sqlite_master WHERE type='table'/i.test(sql)) return [{ name: 'app_categories' }];
      if (/JOIN pragma_table_info/i.test(sql)) {
        return [{ table_name: 'app_categories', column_name: 'id', column_type: 'INTEGER', column_notnull: 1, column_default: null, column_pk: 1 }];
      }
      if (/PRAGMA table_info/i.test(sql)) {
        return [{ name: 'id', type: 'INTEGER', notnull: 1, pk: 1, dflt_value: null }];
      }
      if (/PRAGMA index_list/i.test(sql)) return [];
      if (/FROM sqlite_master WHERE type='index'/i.test(sql)) return [];
      if (/SELECT rowid AS __rowid, \* FROM "app_categories"/i.test(sql)) return [{ __rowid: 1, id: 1 }];
      if (/COUNT\(\*\) AS c FROM "app_categories"/i.test(sql)) return { c: 5 };
      return undefined;
    }
  });
  env.ENABLE_SQL_TOOL = '1';
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage?table=app_categories', env, cookie)).text();
  assert.ok(!html.includes('data-row-action="edit"'), '只读表不给编辑按钮');
  assert.ok(!html.includes('data-batch-action="delete"'), '只读表不给批量删除');
  assert.ok(html.includes('只读表（不在可写白名单里）'), '要说明为什么不能改');
  assert.ok(html.includes('data-row-action="json"'), '只读表仍可复制(浏览能力照旧)');
});

test('数据库管理: 页内脚本必须是可解析的 JS(模板里 \n 写错只有浏览器会炸)', async () => {
  // 这一条是冲着真实踩过的坑来的: 页尾脚本是 Node 侧的模板字符串, 里面写 `'\n\n'` 会被**展开成真换行**,
  // 到了浏览器就是 "Invalid or unexpected token" —— 服务端渲染一切正常、测试也没红, 只有点按钮没反应。
  const { env } = await toolsEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage?table=news', env, cookie)).text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 1, `外壳的内联脚本还在, 实际 ${scripts.length}`);
  scripts.forEach((code, index) => {
    assert.doesNotThrow(() => new Function(code), `第 ${index + 1} 段内联脚本要能解析`);
  });
  // 2.5.0: 页尾脚本搬成真文件后, 上面那个坑由文件本身避免 —— 这里改成"页面引到它 + 文件能解析 +
  // 确认框里的换行仍是转义写法"
  assert.ok(html.includes('static/js/db_tools.js'), '页面要引到搬出去的页尾脚本');
  const script = await readFile(DB_TOOLS_SCRIPT, 'utf8');
  assert.doesNotThrow(() => new Function(script), 'db_tools.js 要能解析');
  assert.ok(script.includes("\\n\\n' +"), '确认框里的换行要用转义写法(不能是真换行)');
});

test('数据库管理: 成本与额度卡 + 本屏用量留给页尾脚本累计', async () => {
  const { env } = await toolsEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage?table=news', env, cookie)).text();
  assert.ok(html.includes('成本与额度'), '成本卡要在页面上');
  // 2.4.9: 不再写死"某天记录"的用量数字(必然过期), 改成额度口径 + 去哪看实时值
  assert.ok(html.includes('实时用量只看 Cloudflare 控制台'), '要说清实时值去哪看');
  assert.ok(html.includes('500 万行'), '带上免费套餐的额度口径');
  assert.ok(!/\d+\.\d+k/.test(html), '不写死会过期的用量数字');
  assert.ok(html.includes('data-cost-session') && html.includes('data-cost-reset'), '本机会话累计与清零');
  assert.ok(html.includes('data-page-cost='), '这一屏的用量要交给页尾脚本累计');
  assert.ok(html.includes('省额度的做法'), '把省额度的做法写在页面上');
  assert.ok(!html.includes('实时查询 Cloudflare 用量'), '不假装能查到实时配额');
});

test('数据库工具: 单行操作按钮带齐数据(复制 JSON/INSERT/生成 UPDATE 靠前端, 不新增写接口)', async () => {
  const { env } = await toolsEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/db_manage?table=news', env, cookie)).text();
  assert.ok(html.includes('data-row-action="json"'), '复制整行 JSON');
  assert.ok(html.includes('data-row-action="insert"'), '复制 INSERT');
  assert.ok(html.includes('data-row-action="update"'), '生成 UPDATE');
  assert.ok(html.includes('data-pk="id"'), '生成 UPDATE 要知道主键列');
  assert.ok(html.includes('data-sensitive-columns='), '敏感列清单要下发(生成 SQL 时跳过, 免得把 *** 写回库)');
  assert.ok(html.includes('rowid'), '数据表第一列是隐式 rowid');
  // 单行"生成 UPDATE"只是把语句填进控制台, 真正的写仍走唯一的 exec 写路径
  assert.ok((await readFile(DB_TOOLS_SCRIPT, 'utf8')).includes("UPDATE ' + table + ' SET"), '生成 UPDATE 走前端拼语句');
});

test('数据库工具: 只允许白名单业务表的单条语句, 写语句必须 confirm=1', async () => {
  const { env } = await toolsEnv();
  const cookie = await loginCookie(env);

  // 结构变更一律拒绝
  const ddl = await (await post('/admin/db_manage/exec', { sql: 'DROP TABLE news' }, env, cookie)).json();
  assert.equal(ddl.code, 400);
  assert.match(ddl.msg, /只允许 SELECT/);

  // 多语句拒绝
  const multi = await (await post('/admin/db_manage/exec', { sql: 'SELECT 1; SELECT 2' }, env, cookie)).json();
  assert.equal(multi.code, 400);
  assert.match(multi.msg, /一次只能执行一条语句/);

  // 白名单外的表拒绝(admin_users 不在 SAFE_TABLES)
  const outside = await (await post('/admin/db_manage/exec', { sql: 'SELECT * FROM admin_users' }, env, cookie)).json();
  assert.equal(outside.code, 400);
  assert.match(outside.msg, /只允许操作这些业务表/);

  // 写语句没带 confirm → 403
  const unconfirmed = await (await post('/admin/db_manage/exec', { sql: 'UPDATE news SET title=? WHERE id=1' }, env, cookie)).json();
  assert.equal(unconfirmed.code, 403);
  assert.match(unconfirmed.msg, /二次确认/);

  // 带 confirm 的写语句 → 200 + 影响行数(桩固定 1)
  const written = await (await post('/admin/db_manage/exec', { sql: 'UPDATE news SET title=? WHERE id=1', confirm: '1' }, env, cookie)).json();
  assert.equal(written.code, 200);
  assert.match(written.msg, /影响 1 行/);
  assert.equal(written.data.warning, '', '带 WHERE 的写语句不额外告警');

  // 不带 WHERE 的写语句: 仍按原口径只要 confirm=1, 但**多回一句告警**(前端也会多问一次)
  const dangerous = await (await post('/admin/db_manage/exec', { sql: 'DELETE FROM news', confirm: '1' }, env, cookie)).json();
  assert.equal(dangerous.code, 200);
  assert.match(dangerous.data.warning, /没有 WHERE/);

  // 查询: 返回行 + 脱敏(token 列变 ***) + 耗时
  const read = await (await post('/admin/db_manage/exec', { sql: 'SELECT token FROM users' }, env, cookie)).json();
  assert.equal(read.code, 200);
  assert.equal(read.data.ran, true);
  assert.equal(read.data.rows[0].token, '***');
  assert.equal(typeof read.data.cost_ms, 'number');
});

test('数据库工具: 执行结果带 D1 用量(rows_read/rows_written/duration) 用于成本估算', async () => {
  const { runStatement } = await import('../app/admin/lib/dbTool.js');
  const mkEnv = (meta, rows) => ({
    DB: {
      prepare: () => ({
        all: async () => ({ results: rows, meta }),
        run: async () => ({ meta })
      })
    }
  });
  const read = await runStatement(mkEnv({ duration: 1.5, rows_read: 1234, rows_written: 0, changes: 0 }, [{ id: 1 }]),
    'SELECT id FROM news');
  assert.equal(read.stats.rowsRead, 1234);
  assert.equal(read.stats.durationMs, 1.5);
  assert.match(read.message, /读 1234 行/, '消息里直接给成本');

  const write = await runStatement(mkEnv({ duration: 3, rows_read: 5, rows_written: 2, changes: 2 }, []),
    'UPDATE news SET title=? WHERE id=1');
  assert.equal(write.stats.rowsWritten, 2);
  assert.equal(write.affected, 2);
  assert.match(write.message, /写 2 行/);
});

test('数据库工具: 执行失败给数据库原文(便于定位), 同时仍进日志与审计', async () => {
  const { env, state } = makeAdminEnv({
    role: 'super',
    counts: { news: 69 },
    db: (sql) => {
      if (/SELECT boom/i.test(sql)) throw new Error('no such column: boom');
      return undefined;
    }
  });
  env.ENABLE_SQL_TOOL = '1';
  const cookie = await loginCookie(env);
  const res = await post('/admin/db_manage/exec', { sql: 'SELECT boom FROM news' }, env, cookie);
  const body = await res.json();
  assert.equal(body.code, 400);
  assert.match(body.msg, /详情见服务端日志/, '统一文案仍在(旧站口径)');
  assert.match(body.detail, /no such column: boom/, '2.2.7 起额外回一句数据库原文');
  assert.ok(findCall(state, /SELECT boom/i), '语句本身进日志/审计链路');
});

test('数据库工具: 非超管既进不了页面, 也调不动 exec', async () => {
  const { env } = makeAdminEnv({ role: 'normal', db: dbStub });
  env.ENABLE_SQL_TOOL = '1';
  const cookie = await loginCookie(env);

  const page = await get('/admin/db_manage', env, cookie);
  assert.equal(page.status, 302);
  assert.match(String(page.headers.get('location')), /error=/);

  const res = await post('/admin/db_manage/exec', { sql: 'SELECT id FROM news' }, env, cookie);
  const text = await res.text();
  assert.ok(res.status === 403 || /超级管理员/.test(text));
});

// ---------------- 素材库治理 ----------------

const MEDIA_OBJECTS = [
  { key: 'news_uploads/a.png', size: 1024, uploaded: '2026-10-01T00:00:00Z' },
  { key: 'news_uploads/b.mp4', size: 4096, uploaded: '2026-10-02T00:00:00Z' },
  { key: 'image/new.png', size: 8192, uploaded: '2026-10-06T00:00:00Z' },
  // 2.3.9: 再放一个"没有任何引用"的新目录素材, 批量删除用例需要两个可删的目标
  { key: 'image/free.png', size: 512, uploaded: '2026-10-05T00:00:00Z' },
  // 2.4.0: 桶里**历史遗留**的派生缩略图(规则已移除, 但它们现在就是普通素材, 要能被看见与清理)
  { key: 'news_uploads/_thumb/480/a.webp', size: 128, uploaded: '2026-10-01T00:00:00Z' },
  { key: 'image/_thumb/480/new.webp', size: 256, uploaded: '2026-10-06T00:00:00Z' }
];

const mediaRows = {
  news: [
    { id: 1, title: '引用了 a 的笔记', image: 'news_uploads/a.png', video_url: '', content: '', deleted_at: null },
    // 新目录里的素材同样要能被引用扫描认出来, 否则治理页会把"在用"的图当无用文件
    { id: 2, title: '引用了新目录的笔记', image: '', video_url: '', content: '<p><img src="image/new.png"></p>', deleted_at: null }
  ]
};

test('素材库治理: 非超管进不去(页面自己判 GET, 中间件只拦写)', async () => {
  const { env } = makeAdminEnv({ role: 'normal', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  const res = await get('/admin/media_manage', env, cookie);
  assert.equal(res.status, 302);
  assert.match(String(res.headers.get('location')), /\/admin\/dashboard\?error=/);
});

test('素材库治理: 列出素材、标注被引用与未引用', async () => {
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);

  const root = await (await get('/admin/media_manage', env, cookie)).text();
  assert.match(root, /存储桶资源管理/);
  // 根目录那一层: 对象键里的顶层目录都变成"可进入的目录行"
  for (const folder of ['news_uploads/', 'image/']) {
    assert.ok(root.includes(`?prefix=${encodeURIComponent(folder)}`), `根层能看到目录 ${folder}`);
  }
  assert.ok(!root.includes('派生缩略图'), '不再有缩略图占用统计');
  // 进 news_uploads/: 本层两个对象 + 一个历史遗留的 _thumb/ 子目录
  const html = await (await get('/admin/media_manage?prefix=news_uploads%2F', env, cookie)).text();
  assert.ok(html.includes('news_uploads/a.png') && html.includes('news_uploads/b.mp4'), '本层对象列出来');
  assert.ok(html.includes(`?prefix=${encodeURIComponent('news_uploads/_thumb/')}`), '本层的子目录也能进去');
  // 2.4.0: 缩略图规则已移除 —— 桶里历史遗留的 _thumb 对象不再被跳过, 作为普通对象出现在它那一层
  const thumbLevel = await (await get('/admin/media_manage?prefix=news_uploads%2F_thumb%2F480%2F', env, cookie)).text();
  assert.ok(thumbLevel.includes('news_uploads/_thumb/480/a.webp'), '历史遗留的缩略图对象要能被看见(否则没法清理)');
  // a.png 被笔记引用 → 显示"1 处"; b.mp4 未引用
  assert.match(html, /1 处/);
  assert.match(html, /未引用/);

  const refs = await (await get('/admin/media_manage_refs?path=news_uploads/a.png', env, cookie)).json();
  assert.equal(refs.success, true);
  assert.equal(refs.total, 1);
  assert.equal(refs.items[0].source, '笔记 · 封面');

  // 新目录里的素材: 正文引用要能认出来(旧实现只认 news_uploads/ 前缀, 会误判成"未引用")
  const newRefs = await (await get('/admin/media_manage_refs?path=image/new.png', env, cookie)).json();
  assert.equal(newRefs.total, 1);
  assert.equal(newRefs.items[0].source, '笔记 · 正文');
});

/** 取页面上的筛选组(与留言管理页同一套 .btn-group) */
function filterBar(html) {
  return (html.match(/<div class="btn-group[\s\S]*?<\/div>/) || [''])[0];
}

test('存储桶浏览筛选: 走 URL 参数 ?kind=, 选中态与列表联动(与留言管理页同一套按钮组)', async () => {
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  const at = (query) => get(`/admin/media_manage?prefix=${encodeURIComponent('news_uploads/')}${query}`, env, cookie);

  const all = await (await at('')).text();
  assert.match(all, /<div class="btn-group btn-group-sm" role="group" aria-label="按类型筛选">/, '与留言管理页同款');
  assert.match(filterBar(all), /class="btn btn-outline-secondary active" href="\/admin\/media_manage\?kind=all[^"]*"[^>]*aria-current="page">全部类型</,
    '不传类型 = 全部(选中态), 且"全部"也带参数(与留言页 status=all 同口径)');
  assert.ok(filterBar(all).includes('kind=video'), '每个按钮都是可直链的地址');

  // 直接访问带参数的 URL(= 刷新/收藏夹)就能定位到对应筛选, 且本层的列表真的被筛过
  const video = await (await at('&kind=video')).text();
  assert.match(filterBar(video), /class="btn btn-outline-secondary active"[^>]*kind=video[^>]*aria-current="page">视频</);
  assert.ok(video.includes('b.mp4') && !video.includes('a.png'), '只剩视频');

  const image = await (await at('&kind=image&q=a')).text();
  assert.match(filterBar(image), /class="btn btn-outline-secondary active"[^>]*kind=image[^>]*>图片</);
  assert.ok(image.includes('a.png') && !image.includes('b.mp4'), '图片 + 关键词一起生效');
  assert.ok(filterBar(image).includes('q=a'), '切类型时搜索词跟着走');
});

test('引用判定: 列表列与「查看引用」同一来源、含回收站(数据库里的引用必须数得出来)', async () => {
  // 同一个素材被 4 类来源引用: 笔记封面(含回收站那条) / 笔记正文 / 轮播图 / 摩旅封面
  // 其它来源的查询是 `SELECT id, "<列>" AS value ...`, 桩按表名回数据不会替 AS 改名, 所以这里直接回 value
  const newsRows = [
    { id: 1, title: '封面用了它', image: 'news_uploads/a.png', video_url: '', content: '', deleted_at: null },
    { id: 2, title: '正文用了它', image: '', video_url: '', content: '<p><img src="news_uploads/a.png"></p>', deleted_at: null },
    { id: 3, title: '回收站里的也算', image: 'news_uploads/a.png', video_url: '', content: '', deleted_at: '2026-10-05 10:00:00' }
  ];
  const { env } = makeAdminEnv({
    role: 'super',
    mediaObjects: MEDIA_OBJECTS,
    db: (sql) => {
      if (/FROM "?news"?/i.test(sql)) return newsRows;
      if (/FROM "?banner_images"?/i.test(sql)) return [{ id: 9, value: 'news_uploads/a.png' }];
      if (/FROM "?motorcycle_trips"?/i.test(sql) && /"poster" AS value/i.test(sql)) return [{ id: 7, value: 'news_uploads/a.png' }];
      if (/FROM "?motorcycle_trips"?/i.test(sql)) return [];
      if (/FROM "?outdoor_activities"?/i.test(sql)) return [];
      return undefined;
    }
  });
  const cookie = await loginCookie(env);

  // 「查看引用」: 5 处(两条笔记封面 + 一条正文 + 轮播图 + 摩旅封面), 回收站那条要能看出来
  const refs = await (await get('/admin/media_manage_refs?path=news_uploads/a.png', env, cookie)).json();
  assert.equal(refs.success, true);
  assert.equal(refs.total, 5, '每个来源都要算上(含回收站那条笔记)');
  const bySource = {};
  for (const item of refs.items) bySource[item.source] = (bySource[item.source] || 0) + 1;
  assert.deepEqual(bySource, { '笔记 · 封面': 2, '笔记 · 正文': 1, '轮播图': 1, '摩旅精选封面': 1 });
  assert.equal(refs.items.filter((item) => item.recycle).length, 1, '回收站里的引用要标出来');

  // 列表列必须与它一致(同一份 scanReferences): 显示 "5 处" + 含回收站徽章
  const html = await (await get('/admin/media_manage?prefix=news_uploads%2F', env, cookie)).text();
  const rowOf = (path) => {
    const at = html.indexOf(`title="${path}"`);
    return at < 0 ? '' : html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at));
  };
  assert.ok(rowOf('news_uploads/a.png').includes('>5 处</a>'), '列表列的处数要与「查看引用」一致');
  assert.ok(rowOf('news_uploads/a.png').includes('含回收站'));
  // 未引用的素材仍然是"未引用"(别把判定改成一律有引用)
  assert.ok(rowOf('news_uploads/b.mp4').includes('未引用'));
});

test('引用扫描: 并发发出(每条查询各占一次 D1 往返, 顺序发就是 N × RTT)', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  // 给每条查询加 15ms 延迟, 记录"同时在飞"的峰值 —— 顺序实现峰值恒为 1
  let inFlight = 0;
  let peak = 0;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const original = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const stmt = original(sql);
    const wrap = (fn) => async (...args) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(15);
      try { return await fn(...args); } finally { inFlight -= 1; }
    };
    stmt.all = wrap(stmt.all.bind(stmt));
    stmt.first = wrap(stmt.first.bind(stmt));
    return stmt;
  };
  state.calls.length = 0;
  const started = Date.now();
  const html = await (await get('/admin/media_manage?prefix=news_uploads%2F', env, cookie)).text();
  const cost = Date.now() - started;
  const issued = state.calls.length;
  assert.ok(html.includes('存储桶资源管理'));
  assert.ok(issued >= 9, `素材库页要发 9 条查询, 实际 ${issued}`);
  assert.ok(peak >= 3, `查询要并发发出, 实际峰值 ${peak}`);
  assert.ok(cost < issued * 15, `并发后耗时 ${cost}ms 应远低于顺序下限 ${issued * 15}ms`);
});

test('SQL 形状: 管理页发出的每条 SQL 都要能被真正的 SQLite 解析(桩测试看不出语法错)', async () => {
  // 2026-10-07 事故: 引用扫描把 SQL 拼成 "... image LIKE ? OR LIKE ? OR LIKE ?"
  // (后两个没有列名) → SQLite 语法错 → 被 catch 吞成"零引用" → 引用列整列显示"未引用"。
  // 桩只按正则回数据, 所以那种坏 SQL 也能"通过"; 这里用真实解析器兜住这类问题。
  let sqlite = null;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    return;   // 运行时没有 node:sqlite 就跳过(不引入依赖)
  }
  const db = new sqlite.DatabaseSync(':memory:');
  // 把"引用扫描会扫到的表/列"照真库建出来, 这样 prepare 既能验语法也能验列名
  db.exec('CREATE TABLE news (id INTEGER, title TEXT, image TEXT, video_url TEXT, content TEXT, deleted_at TEXT)');
  for (const [table, column] of [
    ['banner_images', 'image_url'], ['motorcycle_trips', 'poster'], ['outdoor_activities', 'poster'],
    ['app_home_sections', 'image_url'], ['app_featured_items', 'image_url']
  ]) db.exec(`CREATE TABLE ${table} (id INTEGER, "${column}" TEXT)`);
  db.exec('CREATE TABLE motorcycle_trips_video (id INTEGER)');
  db.exec('ALTER TABLE motorcycle_trips ADD COLUMN videoUrl TEXT');
  db.exec('ALTER TABLE outdoor_activities ADD COLUMN videoUrl TEXT');

  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  state.calls.length = 0;
  await (await get('/admin/media_manage?prefix=news_uploads%2F', env, cookie)).text();

  const scans = state.calls.filter((call) => /LIKE \?/i.test(call.sql));
  // 条数跟着 OTHER_REF_SOURCES 走(2.6.2 删掉「我的页菜单图标」那一条后由 9 变 8)
  assert.ok(scans.length >= 8, `引用扫描应发出 8 条粗筛, 实际 ${scans.length}`);
  for (const call of scans) {
    assert.doesNotThrow(() => db.prepare(call.sql), `语法错误的 SQL: ${call.sql}`);
  }
  // 自检: 事发时那种"OR LIKE ?"(没有列名)必须能被上述机制抓住
  assert.throws(() => db.prepare('SELECT id FROM news WHERE image LIKE ? OR LIKE ?'), /syntax error|near/i);
});

test('存储桶列表(2.4.1/2.4.6): 不用上一页/下一页, 滚动加载(带前缀与筛选翻页不丢条件)', async () => {
  // 12 张图放在 image/ 下 → 进这一层后每页 10, 第 2 页存在
  const many = Array.from({ length: 12 }, (item, index) => ({
    key: `image/p${index}.png`, size: 100 + index, uploaded: '2026-10-06T00:00:00Z'
  }));
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: many, rows: mediaRows });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/media_manage?prefix=image%2F&kind=image', env, cookie)).text();
  // 分页交互整块换掉: 不再有上一页/下一页链接, 改成哨兵 + 共用的 AdminListLoader
  assert.ok(!html.includes('上一页') && !html.includes('下一页'), '不该再有上一页/下一页按钮');
  assert.ok(html.includes('id="mediaLoadMore"') && html.includes('id="mediaLoadMoreText"'), '触底哨兵(与其它列表页同一套)');
  assert.ok(html.includes('id="mediaBackTopBtn"') && html.includes('回到顶部'), '回到顶部按钮');
  assert.ok(!html.includes('id="mediaJumpBtn"'), '跳页控件不给这个页面(滚动加载下跳页只会看到那一页)');
  assert.ok(html.includes('AdminListLoader.init('), '用共用的加载器(不另写一套)');
  // rowsUrl 必须是纯路径: 带 ? 的话 AdminListLoader 再拼一次 ? 会把参数吞掉(2026-10-08 线上 bug)
  const rowsUrl = (html.match(/"rowsUrl":"([^"]*)"/) || [])[1] || '';
  assert.equal(rowsUrl, '/admin/media_manage_rows', '行片段只给端点路径, 参数按 location.search 拼');
  // 切筛选不带页码 → 回到第 1 页(筛选条里没有 page=)
  assert.ok(!filterBar(html).includes('page='), '筛选组不该带页码');
});

test('存储桶行片段(2.4.1/2.4.6): 与首屏同一套(前缀)取数, 越界回空串', async () => {
  const many = Array.from({ length: 12 }, (item, index) => ({
    key: `image/p${index}.png`, size: 100 + index, uploaded: `2026-10-0${index < 9 ? 1 : 6}T00:00:00Z`
  }));
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: many, rows: mediaRows });
  const cookie = await loginCookie(env);
  const prefix = encodeURIComponent('image/');

  // 进 image/ 这一层: 12 个对象 / 每页 10 → 第 2 页 2 行
  const page2 = await (await get(`/admin/media_manage_rows?prefix=${prefix}&page=2`, env, cookie)).json();
  assert.equal(page2.success, true);
  assert.equal((page2.rows.match(/data-media-pick/g) || []).length, 2, '第二页只回 2 行');
  assert.equal(page2.has_more, false);
  // 越界页被夹到最后一页(与首屏 min(wantsPage, totalPages) 同口径), 且明确 has_more=false
  const over = await (await get(`/admin/media_manage_rows?prefix=${prefix}&page=9`, env, cookie)).json();
  assert.equal(over.success, true);
  assert.equal((over.rows.match(/data-media-pick/g) || []).length, 2, '越界请求拿到最后一页');
  assert.equal(over.has_more, false);
  // 没有命中时回空串(前端据此判"到底了"); 不能回一行"暂无数据"——那会被当成数据继续翻页
  const none = await (await get(`/admin/media_manage_rows?prefix=${prefix}&q=不存在的东西&page=1`, env, cookie)).json();
  assert.equal(none.rows, '');
  // 换一层(根目录)就没有这些文件了 —— 行片段必须跟着 ?prefix= 走
  const other = await (await get('/admin/media_manage_rows?page=1', env, cookie)).json();
  assert.equal(other.rows, '', '根目录那层只有目录行, 没有文件行');
});

test('素材库(2.4.1)行片段: 非超管拿不到(与页面同一条闸)', async () => {
  const { env } = makeAdminEnv({ role: 'normal', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  const res = await (await get('/admin/media_manage_rows?page=1', env, cookie)).json();
  assert.equal(res.success, false);
});

test('素材库治理: 有引用时拒绝删除(确认页说明 + POST 复查)', async () => {
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);

  const confirm = await (await get('/admin/media_manage_delete?path=news_uploads/a.png', env, cookie)).text();
  assert.match(confirm, /不能删除/);

  const res = await post('/admin/media_manage_delete',
    { path: 'news_uploads/a.png', back: '/admin/media_manage', confirm: '1' }, env, cookie);
  assert.equal(res.status, 302);
  assert.match(String(res.headers.get('location')), /error=/);
});

test('素材库治理: 缺少服务端确认标记时直接拒绝(只靠页面按钮拦不住构造的 POST)', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  // 确认页会带 confirm=1; 这里故意不带(等价于直接构造 POST)
  const res = await post('/admin/media_manage_delete', { path: 'news_uploads/b.mp4', back: '/admin/media_manage' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(decodeURIComponent(String(res.headers.get('location')).replace(/\+/g, ' ')).includes('缺少确认标记'));
  assert.deepEqual(state.deletes, [], '没带确认标记时不能动 R2');
});

test('素材库治理: 无引用时删除并回列表带 message', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);

  const confirm = await (await get('/admin/media_manage_delete?path=news_uploads/b.mp4', env, cookie)).text();
  assert.match(confirm, /删除对象/);
  assert.ok(!confirm.includes('不能删除'));

  const res = await post('/admin/media_manage_delete',
    { path: 'news_uploads/b.mp4', back: '/admin/media_manage', confirm: '1' }, env, cookie);
  assert.equal(res.status, 302);
  assert.match(String(res.headers.get('location')), /message=/);
  assert.deepEqual(state.deletes, ['news_uploads/b.mp4']);
  // 删除前一定扫过引用(含回收站: WHERE 里没有 deleted_at 过滤)
  const scan = findCall(state, /FROM news\s+WHERE\s*\(?image LIKE/i);
  assert.ok(scan, '删除前必须复查引用');
});

test('素材库治理: 引用扫描没扫全时一律拒绝(fail-closed, 不能当成"没被引用")', async () => {
  const { env, state } = makeAdminEnv({
    role: 'super',
    mediaObjects: MEDIA_OBJECTS,
    rows: mediaRows,
    // 让引用扫描里那条笔记粗筛查询直接失败: 以前它被 catch 成"零引用", 于是素材照删(2026-10-07 线上事故的成因)
    db: (sql, args, kind) => {
      if (kind === 'all' && /FROM news\s+WHERE/i.test(sql)) throw new Error('d1 down');
      return undefined;
    }
  });
  const cookie = await loginCookie(env);

  const confirm = await get('/admin/media_manage_delete?path=news_uploads/b.mp4', env, cookie);
  assert.equal(confirm.status, 302, '拿不到引用结果时连确认页都不给');

  const res = await post('/admin/media_manage_delete',
    { path: 'news_uploads/b.mp4', back: '/admin/media_manage', confirm: '1' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(
    decodeURIComponent(String(res.headers.get('location')).replace(/\+/g, ' ')).includes('引用扫描未完成'),
    '要明确说"没扫全", 而不是照常删'
  );
  assert.deepEqual(state.deletes, [], '扫描没扫全时一个对象都不能动');
});

test('素材库治理: 对象键里带逗号也删得对(批量参数是 JSON 数组, 不是逗号分隔)', async () => {
  const commaKey = 'image/a,b.png';
  const { env, state } = makeAdminEnv({
    role: 'super',
    mediaObjects: [{ key: commaKey, size: 10, uploaded: '2026-10-09T00:00:00Z' }, { key: 'image/a', size: 1, uploaded: '2026-10-09T00:00:00Z' }],
    rows: { news: [] }
  });
  const cookie = await loginCookie(env);
  const paths = JSON.stringify([commaKey]);
  const confirm = await (await get(`/admin/media_manage_delete?paths=${encodeURIComponent(paths)}`, env, cookie)).text();
  assert.ok(confirm.includes('image/a,b.png'), '确认页要原样列出带逗号的键');

  const res = await post('/admin/media_manage_delete', { paths, back: '/admin/media_manage', confirm: '1' }, env, cookie);
  assert.equal(res.status, 302);
  assert.deepEqual(state.deletes, [commaKey], '只删这一个键, 不能拆成 image/a 与 b.png');
});

test('素材库治理: 返回地址收敛, 不接受站外跳转', async () => {
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  const res = await post(
    '/admin/media_manage_delete',
    { path: 'news_uploads/b.mp4', back: '//evil.example/x', confirm: '1' },
    env,
    cookie
  );
  assert.equal(res.status, 302);
  const location = String(res.headers.get('location'));
  assert.ok(!location.includes('evil.example'), '开放重定向必须被挡住');
});

// ---------------- 素材库治理 2.3.9: 上传 / 详情 / 改名 / 批量 / 新筛选 ----------------

test('素材库(2.4.1): 图片与视频两个独立入口(各带文件/文件夹), 命名策略与进度条照旧', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);

  const html = await (await get('/admin/media_manage', env, cookie)).text();
  // 2.5.0: 上传脚本搬到 static/js/media_govern.js —— 脚本内容的断言读文件
  const script = await readFile(MEDIA_GOVERN_SCRIPT, 'utf8');
  // 拆分后的四个入口: 类型由入口决定, 每个入口都能选文件或整个文件夹
  assert.ok(html.includes('id="mediaUploadImageFiles"') && html.includes('id="mediaUploadImageFolder"'),
    '图片入口: 文件 + 文件夹');
  assert.ok(html.includes('id="mediaUploadVideoFiles"') && html.includes('id="mediaUploadVideoFolder"'),
    '视频入口: 文件 + 文件夹');
  assert.equal((html.match(/webkitdirectory/g) || []).length, 2, '两个文件夹入口(各带子目录)');
  assert.ok(html.includes('data-purpose="cover"') && html.includes('data-purpose="video"'),
    '入口即类型: 图片→purpose=cover(image/)、视频→purpose=video(video/)');
  assert.ok(!html.includes('id="mediaUploadFiles"'), '旧的"混合类型"单入口已撤掉');
  assert.ok(html.includes('name="mediaNameMode"') && html.includes('value="keep" checked') && html.includes('value="auto"'),
    '命名策略: 保留原名(2.6.8 起默认) / 自动生成');
  assert.ok(html.includes('id="mediaUploadBar"') && html.includes('id="mediaUploadOverall"'),
    '整体进度条与统计行(进度来自 XHR upload.onprogress, 不是 fetch)');
  assert.ok(script.includes("data.set('purpose', item.purpose)"), '每个文件按自己入口的 purpose 上传');
  // 2.4.2 文案: 每个入口两个按钮, 文案不重复(原生 file 控件的按钮文字改不了, 用 label 按钮显示)
  assert.equal((html.match(/for="mediaUploadImageFiles">选择文件</g) || []).length, 1, '图片入口: 选择文件');
  assert.equal((html.match(/for="mediaUploadImageFolder">选择文件夹</g) || []).length, 1, '图片入口: 选择文件夹');
  assert.equal((html.match(/for="mediaUploadVideoFiles">选择文件</g) || []).length, 1, '视频入口: 选择文件');
  assert.equal((html.match(/for="mediaUploadVideoFolder">选择文件夹</g) || []).length, 1, '视频入口: 选择文件夹');
  assert.equal((html.match(/class="visually-hidden" type="file"/g) || []).length, 4, '四个 input 隐藏(label 按钮代劳)');
  assert.ok((html.match(/>选择文件夹</g) || []).length === 2 && !html.includes('>选择文件</label>\n          <label class="btn btn-sm btn-outline-secondary mb-0" for="mediaUploadImageFolder">选择文件<'),
    '两个入口的文案不重复(不再出现两个"选择文件")');
  assert.ok(html.includes('整棵目录树'), '目录保留规则写在页面上(避免用户猜)');
  assert.ok(html.includes('两种命名模式都保留目录'), '说明自动生成模式下目录仍保留');
  assert.ok(html.includes('空文件夹不会被保留'), '说明空文件夹的处理');
  assert.ok(html.includes('单张 ≤ 8 MB'), '上限文案来自 mediaUpload 的常量');

  // 真上传一次(图片入口的 purpose=cover, 保留原名): 落到 image/ 并写入统一 Cache-Control
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'probe.png', { type: 'image/png' }));
  form.set('purpose', 'cover');
  const res = await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
    method: 'POST', headers: { origin: HOST, cookie }, body: form
  }), env, { version: API_VERSION });
  const body = await res.json();
  assert.equal(body.success, true, JSON.stringify(body));
  assert.match(body.url, /^image\/cover_\d+\.png$/, '图片入口: 落 image/(沿用 purpose=cover 规则)');
  const stored = state.objects.get(body.url);
  assert.equal(stored.httpMetadata.cacheControl, 'public, max-age=604800, immutable', '新对象要带 Cache-Control');

  // 保留原名 + 子目录 + 路径穿越清洗: 端点要透传 name_mode / rel_path 给 saveUpload
  const keep = new FormData();
  keep.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'photo.png', { type: 'image/png' }));
  keep.set('purpose', 'cover');
  keep.set('name_mode', 'keep');
  keep.set('rel_path', '../../我的一批素材/子目录/photo.png');
  const kept = await (await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
    method: 'POST', headers: { origin: HOST, cookie }, body: keep
  }), env, { version: API_VERSION })).json();
  assert.equal(kept.success, true, JSON.stringify(kept));
  assert.equal(kept.url, 'image/我的一批素材/子目录/photo.png', '保留原名与子目录, 且 .. 被清洗掉');
  assert.equal(kept.kind, 'image');
});

test('素材库(2.4.3/2.4.4/2.6.7): 目标路径可选项 = 根目录 + 桶根下的一级子目录(与桶页那排按钮逐字一致) + 手动兜底', async () => {
  const { env, state } = makeAdminEnv({
    role: 'super',
    mediaObjects: [
      { key: 'image/素材/相册/图.png', size: 100, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'video/活动/子/片.mp4', size: 100, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'news_uploads/2026-10/图.png', size: 100, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'avatar/u.png', size: 10, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'images/icon.png', size: 10, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'logo.png', size: 10, uploaded: '2026-10-09T00:00:00Z' }
    ],
    rows: mediaRows
  });
  const cookie = await loginCookie(env);
  const script = await readFile(MEDIA_GOVERN_SCRIPT, 'utf8');
  const optionValues = (block) => [...block.matchAll(/<option value="([^"]+)"/g)]
    .map((one) => one[1]).filter((one) => one !== '/' && one !== '__manual').sort();
  const selectOf = (html, id) => (html.match(new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`)) || [])[0] || '';

  // ① 桶页(根层)自己列出的目录 = 上传下拉的目录集合(2.6.7 的硬口径: 两处必须逐字一致, 否则就是"显示不全")
  const rootHtml = await (await get('/admin/media_manage', env, cookie)).text();
  const buttonDirs = [...new Set([...rootHtml.matchAll(/href="\/admin\/media_manage\?prefix=([^"]+)"/g)]
    .map((one) => decodeURIComponent(one[1])))].sort();
  const rootImageDirs = optionValues(selectOf(rootHtml, 'mediaUploadImageDir'));
  const rootVideoDirs = optionValues(selectOf(rootHtml, 'mediaUploadVideoDir'));
  assert.deepEqual(rootImageDirs, buttonDirs, '图片下拉的目录 = 桶页「存储桶根目录」后面那排按钮的目录');
  assert.deepEqual(rootVideoDirs, buttonDirs, '视频下拉同理(两条下拉只有默认项不同)');
  assert.ok(buttonDirs.includes('avatar/') && buttonDirs.includes('images/') && buttonDirs.includes('news_uploads/'),
    '桩里根层有 5 个目录(image/、video/、news_uploads/、avatar/、images/), 站内自有目录也照列');

  // ② 站在子目录里也一样(下拉与当前浏览位置无关), 且只给一级 —— 更深的 image/素材/ 不出现
  const innerHtml = await (await get('/admin/media_manage?prefix=image%2F', env, cookie)).text();
  const innerOptions = selectOf(innerHtml, 'mediaUploadImageDir');
  assert.deepEqual(optionValues(innerOptions), buttonDirs, '进了 image/ 之后下拉仍是桶根那一层');
  assert.ok(!innerOptions.includes('image/素材/') && !innerHtml.includes('value="image/素材/"'),
    '更深层级不列出来(2.6.5 会列, 2.6.6 起只给一级, 更深的走「其它」手填)');
  assert.ok(innerOptions.includes('value="/">根目录（存储桶最外层）'), '有根目录选项');
  assert.ok(innerOptions.includes('value="image/" selected'), '默认仍是 image/(不操作时行为不变)');
  assert.ok(!innerOptions.includes('&nbsp;'), '一层目录不需要缩进');
  assert.ok(innerOptions.includes('value="__manual">其它（手动填写）'), '另有手动填写兜底');
  assert.ok(innerHtml.includes('id="mediaUploadImageDirManual"') && innerHtml.includes('id="mediaUploadVideoDirManual"'),
    '各带一个手动填写的兜底输入框');
  assert.ok(innerHtml.includes('data-root="image/"') && innerHtml.includes('data-root="video/"'), '根目录随控件一起下发');

  // ③ 下拉里任选一个目录都能真写进去(选项与桶页一致, 也就都可用)
  for (const dir of rootImageDirs) {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], '检查.png', { type: 'image/png' }));
    form.set('purpose', 'cover');
    form.set('name_mode', 'keep');
    form.set('target_dir', dir);
    const result = await (await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
      method: 'POST', headers: { origin: HOST, cookie }, body: form
    }), env, { version: API_VERSION })).json();
    assert.equal(result.success, true, `${dir} 应能上传`);
    assert.equal(result.url, `${dir}检查.png`, `落在 ${dir} 下`);
  }
  assert.equal(state.objects.has('images/检查.png'), true, '站内自有目录也能选、能写(2.6.6 前被过滤掉)');

  // 提交与校验
  assert.ok(script.includes("data.set('target_dir', target)"), '提交时带上目标路径');
  assert.ok(script.includes('function dirProblem()') && script.includes('if (problem)'),
    '前端开跑前也校验一遍(前后端双校验)');
  assert.ok(script.includes("value === '/'"), '前端认根目录这个提交值');
  assert.ok(script.includes('目标路径不能包含两个点') && script.includes('不能是绝对路径'),
    '前端仍拦穿越与绝对路径(2.6.5 起不再拦"必须以 image/ 开头")');
  assert.ok(!script.includes('必须以 '), '那句"必须以 image/ 开头"的拦截已按 2.6.5 去掉');
});

test('上传接口(2.4.4): target_dir=/ 落存储桶根目录(不带任何前缀)', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects: [], rows: mediaRows });
  const cookie = await loginCookie(env);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const upload = (extra) => {
    const form = new FormData();
    form.set('file', new File([png], 'logo.png', { type: 'image/png' }));
    Object.entries(extra).forEach(([key, value]) => form.set(key, value));
    return handleAdmin(new Request(`${HOST}/admin/image_upload`, {
      method: 'POST', headers: { origin: HOST, cookie }, body: form
    }), env, { version: API_VERSION }).then((res) => res.json());
  };
  // 保留原名 → key 就是文件名本身
  const kept = await upload({ purpose: 'cover', target_dir: '/', name_mode: 'keep' });
  assert.equal(kept.url, 'logo.png', '根目录: key 不带任何前缀');
  assert.equal(state.objects.has('logo.png'), true, '真写进了桶根');
  // 选了文件夹 → 目录结构直接铺在根目录下
  const nested = await upload({ purpose: 'cover', target_dir: '/', name_mode: 'keep', rel_path: '素材/图.png' });
  assert.equal(nested.url, '素材/图.png', '根目录 + 文件夹结构: 不带前缀、层级照留');
  // 自动生成也给个不带前缀的名字
  const auto = await upload({ purpose: 'cover', target_dir: '/', name_mode: 'auto', rel_path: '素材/图.png' });
  assert.match(auto.url, /^素材\/cover_\d+\.png$/, '根目录下自动生成只换文件名');
  // 无 rel_path / 不传 target_dir 的调用方行为不变(仍落 image/ 根; 与根目录的 logo.png 是两个不同的 key)
  const plain = await upload({ purpose: 'cover', name_mode: 'keep' });
  assert.equal(plain.url, 'image/logo.png', '不传 target_dir: 仍落 image/');
});

test('存储桶(2.4.6): 逐层浏览整个桶(根层目录/深层对象/引用列/筛选), 站内自有目录也能看', async () => {
  const { env, state } = makeAdminEnv({
    role: 'super',
    mediaObjects: [
      { key: 'logo.png', size: 2048, uploaded: '2026-10-09T00:00:00Z' },
      { key: '素材/顶图.png', size: 1024, uploaded: '2026-10-08T00:00:00Z' },
      { key: '素材/子/深图.png', size: 512, uploaded: '2026-10-07T00:00:00Z' },
      { key: '素材/子/片段.mp4', size: 4096, uploaded: '2026-10-06T00:00:00Z' },
      { key: 'image/a.png', size: 256, uploaded: '2026-10-05T00:00:00Z' },
      { key: 'avatar/u.png', size: 128, uploaded: '2026-10-04T00:00:00Z' },
      { key: 'images/icon.png', size: 64, uploaded: '2026-10-03T00:00:00Z' }
    ],
    rows: { news: [{ id: 8, title: '引用了根目录树里的图', image: '素材/子/深图.png', video_url: '', content: '', deleted_at: null }] }
  });
  const cookie = await loginCookie(env);
  const at = (prefix) => get(`/admin/media_manage?prefix=${encodeURIComponent(prefix)}`, env, cookie);

  // ① 根目录那一层: 根下文件 + 所有顶层目录(2.4.6 起整个桶都能看, 站内自有的 avatar/、images/ 也列出来)
  const root = await (await get('/admin/media_manage', env, cookie)).text();
  assert.ok(root.includes('value="logo.png"'), '根下对象列出来');
  for (const folder of ['素材/', 'image/', 'avatar/', 'images/']) {
    assert.ok(root.includes(`?prefix=${encodeURIComponent(folder)}`), `根层能看到目录 ${folder}`);
  }
  assert.ok(!root.includes('value="素材/子/深图.png"'), '只列当前这一层, 深层内容进目录才看得到');
  assert.ok(!root.includes('上一级</a>'), '根层没有"上一级"按钮(面包屑只到"存储桶")');

  // ② 进 素材/子/: 深层对象可见(2.4.5 修的"根目录树"在这里体现) + 面包屑 + 引用判定
  const deep = await (await at('素材/子/')).text();
  assert.ok(deep.includes('素材/子/深图.png') && deep.includes('素材/子/片段.mp4'), '深层对象进目录后可见');
  assert.ok(deep.includes('上一级') && deep.includes('素材'), '面包屑与上一级可用');
  assert.match(deep, /1 处/, '被引用的那个算出引用数');
  const blocked = await (await get(`/admin/media_manage_delete?path=${encodeURIComponent('素材/子/深图.png')}`, env, cookie)).text();
  assert.match(blocked, /不能删除/, '被引用的根目录树素材拒绝删除');
  const unused = await (await get(`/admin/media_manage?prefix=${encodeURIComponent('素材/子/')}&ref=unused`, env, cookie)).text();
  assert.ok(unused.includes('片段.mp4') && !unused.includes('深图.png'), '未引用筛选在本层生效');
  const searched = await (await get(`/admin/media_manage?prefix=${encodeURIComponent('素材/子/')}&q=%E6%B7%B1%E5%9B%BE`, env, cookie)).text();
  assert.ok(searched.includes('深图.png') && !searched.includes('片段.mp4'), '关键词筛选在本层生效');

  // ③ 站内自有目录: 能浏览(全量), 但**不做引用扫描** → 引用列显示 —
  const avatarLevel = await (await at('avatar/')).text();
  assert.ok(avatarLevel.includes('value="avatar/u.png"'), '站内自有目录也能浏览(2.4.6)');
  assert.ok(avatarLevel.includes('>—</span>'), '非素材路径不做引用扫描(引用列 —)');
  // 素材选择器仍然只给素材(image/+news_uploads/+根目录树): 站点图标与头像不进选择器
  const library = await (await get('/admin/media_library?kind=image', env, cookie)).json();
  const paths = (library.items || []).map((one) => one.path);
  assert.ok(paths.includes('logo.png') && paths.includes('素材/子/深图.png'), '选择器含根目录整块');
  assert.ok(!paths.includes('avatar/u.png') && !paths.includes('images/icon.png'), '站点图标与头像不进素材选择器');

  // ④ 真上传一个"根目录 + 选文件夹"的对象, 再走详情 / 改名(桩的 head 只认 put 过的对象)
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], '新图.png', { type: 'image/png' }));
  form.set('purpose', 'cover');
  form.set('target_dir', '/');
  form.set('name_mode', 'keep');
  form.set('rel_path', '素材/子/新图.png');
  const uploaded = await (await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
    method: 'POST', headers: { origin: HOST, cookie }, body: form
  }), env, { version: API_VERSION })).json();
  assert.equal(uploaded.url, '素材/子/新图.png', '根目录 + 文件夹: 键带结构');
  assert.equal(state.objects.has('素材/子/新图.png'), true);

  const detail = await get(`/admin/media_manage_detail?path=${encodeURIComponent('素材/子/新图.png')}`, env, cookie);
  assert.equal(detail.status, 200, '根目录树的素材能打开详情页');
  assert.ok((await detail.text()).includes('素材/子/'), '详情页给出所在层');

  // ⑤ 改名/移动: 目标目录是**文本前缀**(任意目录), 预填当前目录, 文件名只填文件名
  const rename = await (await get(`/admin/media_manage_rename?path=${encodeURIComponent('素材/子/新图.png')}`, env, cookie)).text();
  assert.ok(rename.includes('name="dir"') && rename.includes('value="素材/子/"'), '目标目录预填当前前缀');
  assert.ok(rename.includes('value="新图.png"'), '文件名预填文件名(不含目录)');
  assert.ok(rename.includes('name="copy"'), '有「复制」开关');
  const moved = await post('/admin/media_manage_rename',
    { path: '素材/子/新图.png', dir: 'image/2026-10/', name: '新图.png', back: '/admin/media_manage' }, env, cookie);
  assert.equal(moved.status, 302);
  assert.equal(state.objects.has('image/2026-10/新图.png'), true, '能移动到期任意前缀下');
  assert.equal(state.objects.has('素材/子/新图.png'), false, '旧对象已删');

  // ⑥ 复制: 原对象保留, 新键出现(且目标已存在时拒绝覆盖)
  const copied = await post('/admin/media_manage_rename',
    { path: 'image/2026-10/新图.png', dir: 'image/2026-10/', name: '副本.png', copy: '1', back: '/admin/media_manage' }, env, cookie);
  assert.equal(copied.status, 302);
  assert.equal(state.objects.has('image/2026-10/副本.png'), true, '复制出新键');
  assert.equal(state.objects.has('image/2026-10/新图.png'), true, '原对象保留(复制不动它)');
  const again = await post('/admin/media_manage_rename',
    { path: 'image/2026-10/新图.png', dir: 'image/2026-10/', name: '副本.png', copy: '1', back: '/admin/media_manage' }, env, cookie);
  assert.ok(String(again.headers.get('location')).includes(encodeURIComponent('目标路径已存在')), '绝不覆盖已有对象');
});

test('存储桶(2.4.6)目录级操作: 移动(≤10)/删除(≤20)都先确认, 被引用整批拒绝, 非超管 403', async () => {
  const keys = Array.from({ length: 12 }, (item, index) => `素材/批${index}.png`);
  const mediaObjects = keys.map((key, index) => ({ key, size: 100 + index, uploaded: '2026-10-09T00:00:00Z' }));
  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects, rows: { news: [] } });
  const cookie = await loginCookie(env);
  // 移动要读原对象 → 桩的 get/head 只看 state.objects(put 过的), 这里直接铺上
  keys.forEach((key) => state.objects.set(key, { size: 100, httpMetadata: {} }));

  // ① 移动确认页: 说明这一批与剩余量, 并带目标前缀输入
  const movePage = await (await get(`/admin/media_manage_dir?action=move&prefix=${encodeURIComponent('素材/')}`, env, cookie)).text();
  assert.ok(movePage.includes('即将移动') && movePage.includes('还有 2 个'), '确认页说明这一批(10 个)与剩余(2 个)');
  assert.ok(movePage.includes('name="dir"') && movePage.includes('name="confirm"'), '移动有目标前缀输入与二次确认');

  // ② 执行移动: 结构原样保留, 一次只动 10 个
  const moved = await post('/admin/media_manage_dir',
    { action: 'move', prefix: '素材/', dir: 'image/归档/', back: '/admin/media_manage', confirm: '1' }, env, cookie);
  assert.equal(moved.status, 302);
  assert.match(String(moved.headers.get('location')), /message=/);
  assert.equal(state.objects.has('image/归档/批0.png'), true, '目标键 = 目标前缀 + 原键去掉前缀');
  assert.equal(state.objects.has('素材/批0.png'), false, '原键已删');
  assert.equal(state.objects.has('素材/批10.png'), true, '只动 10 个(剩下的提示可再次提交)');

  // ③ 删除确认页 + 执行: 一批 1 次 R2 delete
  const delPage = await (await get(`/admin/media_manage_dir?action=delete&prefix=${encodeURIComponent('素材/')}`, env, cookie)).text();
  assert.ok(delPage.includes('即将删除') && delPage.includes('二次确认') === false, '删除确认页');
  state.deleteCalls = 0;   // 上面的移动每个对象各带一次 delete, 这里只统计"批量删除"这一次
  const deleted = await post('/admin/media_manage_dir',
    { action: 'delete', prefix: '素材/', back: '/admin/media_manage', confirm: '1' }, env, cookie);
  assert.equal(deleted.status, 302);
  assert.equal(state.objects.has('素材/批10.png'), false, '删除生效');
  assert.equal(state.deleteCalls, 1, '一批只花 1 次 R2 delete');

  // ④ 被引用 → 整批拒绝(与单条删除同一口径)
  const refEnv = makeAdminEnv({
    role: 'super',
    mediaObjects: [{ key: '素材/图.png', size: 1, uploaded: '2026-10-09T00:00:00Z' }],
    rows: { news: [{ id: 3, title: 'x', image: '素材/图.png', video_url: '', content: '', deleted_at: null }] }
  });
  const refCookie = await loginCookie(refEnv.env);
  const refPage = await (await get(`/admin/media_manage_dir?action=delete&prefix=${encodeURIComponent('素材/')}`, refEnv.env, refCookie)).text();
  assert.ok(refPage.includes('整批拒绝'), '确认页直接说明整批拒绝');
  const refused = await post('/admin/media_manage_dir',
    { action: 'delete', prefix: '素材/', back: '/admin/media_manage', confirm: '1' }, refEnv.env, refCookie);
  assert.ok(String(refused.headers.get('location')).includes(encodeURIComponent('已整批拒绝')));
  assert.deepEqual(refEnv.state.deletes, [], '整批拒绝时一个都不动');

  // ⑤ 非超管: 目录操作同样被拦(与其它写入口同一道闸)
  const normal = makeAdminEnv({ role: 'normal', mediaObjects, rows: { news: [] } });
  const normalCookie = await loginCookie(normal.env);
  const denied = await post('/admin/media_manage_dir',
    { action: 'delete', prefix: '素材/', back: '/admin/media_manage' }, normal.env, normalCookie);
  assert.equal(denied.status, 403);
});

test('上传接口(2.4.1): 文件夹上传靠入口带类型, 类型对不上会被拒', async () => {
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: [], rows: mediaRows });
  const cookie = await loginCookie(env);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const upload = (file, extra) => {
    const form = new FormData();
    form.set('file', file);
    Object.entries(extra).forEach(([key, value]) => form.set(key, value));
    return handleAdmin(new Request(`${HOST}/admin/image_upload`, {
      method: 'POST', headers: { origin: HOST, cookie }, body: form
    }), env, { version: API_VERSION }).then((res) => res.json());
  };
  // 图片入口收到视频 / 视频入口收到图片 → 拒(入口即类型, 与"只认内容不看扩展名"配套)
  const imageEntryGotVideo = await upload(new File([mp4], 'clip.mp4', { type: '' }), { purpose: 'cover' });
  assert.equal(imageEntryGotVideo.success, false, '图片入口不该收视频');
  const videoEntryGotImage = await upload(new File([png], 'p.png', { type: 'image/png' }), { purpose: 'video' });
  assert.equal(videoEntryGotImage.success, false, '视频入口不该收图片');
  // 视频入口 + 保留原名 + 子目录 → 落 video/ 并保留子目录(文件夹上传的核心行为)
  const folderVideo = await upload(new File([mp4], 'c.mp4', { type: 'video/mp4' }),
    { purpose: 'video', name_mode: 'keep', rel_path: '素材/子目录/c.mp4' });
  assert.equal(folderVideo.url, 'video/素材/子目录/c.mp4', '视频入口的文件落 video/, 子目录照带');
  // 2.4.2: 自动生成模式下目录也保留(前端两种模式都发 rel_path); 顶层文件夹名一起保留
  const autoFolder = await upload(new File([mp4], 'c.mp4', { type: 'video/mp4' }),
    { purpose: 'video', name_mode: 'auto', rel_path: '素材/子目录/c.mp4' });
  assert.match(autoFolder.url, /^video\/素材\/子目录\/video_\d+\.mp4$/, '自动生成: 目录保留, 只换文件名');
  // 端点就是把 rel_path 原样透传: 前端发什么样的相对路径, 桶里就有什么样的层级
  const rootLevel = await upload(new File([mp4], 'root.mp4', { type: 'video/mp4' }),
    { purpose: 'video', name_mode: 'keep', rel_path: '素材/root.mp4' });
  assert.equal(rootLevel.url, 'video/素材/root.mp4', '所选文件夹下的文件落 video/<文件夹>/');
});

test('上传接口(2.4.3/2.6.5): 目标路径可以是任意干净相对目录, 只有非法路径被拒', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects: [], rows: mediaRows });
  const cookie = await loginCookie(env);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const upload = (extra) => {
    const form = new FormData();
    form.set('file', new File([png], '图.png', { type: 'image/png' }));
    Object.entries(extra).forEach(([key, value]) => form.set(key, value));
    return handleAdmin(new Request(`${HOST}/admin/image_upload`, {
      method: 'POST', headers: { origin: HOST, cookie }, body: form
    }), env, { version: API_VERSION }).then((res) => res.json());
  };
  // 目标路径 + 文件夹结构叠加(2.4.2 的规则在选定路径下面继续生效)
  const nested = await upload({ purpose: 'cover', target_dir: 'image/2026-10/', name_mode: 'keep', rel_path: '素材/图.png' });
  assert.equal(nested.url, 'image/2026-10/素材/图.png', 'target_dir 当根, 子目录结构照带');
  assert.equal(state.objects.has('image/2026-10/素材/图.png'), true, '真写进了桶');
  // 2.6.6: 下拉里能选的"桶根一级子目录"(如 news_uploads/) 照旧能写进去
  const topDir = await upload({ purpose: 'cover', target_dir: 'news_uploads/', name_mode: 'keep' });
  assert.equal(topDir.url, 'news_uploads/图.png', '选一级子目录: 文件直接落在它下面');

  // 2.6.5: 「其它（手动填写）」不再被"必须以 image/ 开头"挡住 —— 干净的相对目录写哪落哪
  const manual = await upload({ purpose: 'cover', target_dir: 'news_uploads/2026-10/', name_mode: 'keep' });
  assert.equal(manual.success, true, '手填历史素材目录要能传');
  assert.equal(manual.url, 'news_uploads/2026-10/图.png', '落在手填的目录下');
  const cross = await upload({ purpose: 'cover', target_dir: 'video/x/', name_mode: 'keep' });
  assert.equal(cross.success, true, '跨入口也不再由后端拦(代价: 素材库按 kind 列举, 该对象会列不出来)');

  const before = state.objects.size;
  const rejected = [
    { purpose: 'cover', target_dir: 'image/../video/' },   // 路径穿越
    { purpose: 'cover', target_dir: '/image/x/' },         // 绝对路径
    { purpose: 'cover', target_dir: '//' },                // 只剩斜杠(根目录的唯一提交值是单个斜杠)
    { purpose: 'cover', target_dir: 'image//x/' },         // 空段
    { purpose: 'cover', target_dir: 'image/./x/' }         // 单个点
  ];
  for (const one of rejected) {
    const result = await upload(one);
    assert.equal(result.success, false, `${one.target_dir} 应被拒`);
    assert.ok(result.message.includes('目标路径'), '给出可读原因');
  }
  assert.equal(state.objects.size, before, '被拒的请求不写任何对象');
});

test('存储桶目录按钮(2.6.5): 跟着当前位置换一层(根 = 存储桶根目录 + 根下子目录, 进了子目录就换成它的子目录)', async () => {
  const { env } = makeAdminEnv({
    role: 'super',
    mediaObjects: [
      { key: 'image/a.png', size: 10, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'image/food/f.png', size: 10, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'video/v.mp4', size: 10, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'news_uploads/n.png', size: 10, uploaded: '2026-10-09T00:00:00Z' }
    ],
    rows: mediaRows
  });
  const cookie = await loginCookie(env);
  // 只取"目录按钮"那一条(面包屑与筛选组都在别的容器里)
  const buttons = (html) => (html.match(/<div class="d-flex flex-wrap gap-2 mb-2">([\s\S]*?)<\/div>/) || ['', ''])[1];

  // 常态(桶根): 「存储桶根目录」高亮 + 根下的子目录
  const rootButtons = buttons(await (await get('/admin/media_manage', env, cookie)).text());
  assert.ok(rootButtons.includes('btn-primary') && rootButtons.includes('存储桶根目录'), '根时选中「存储桶根目录」');
  for (const dir of ['image/', 'video/', 'news_uploads/']) {
    assert.ok(rootButtons.includes(`?prefix=${encodeURIComponent(dir)}`), `根层按钮要有 ${dir}`);
  }

  // 进 image/: 按钮换成 image/ 下的子目录; 写死的 video/、news_uploads/ 按钮不再出现(它们不在这一层)
  const imageButtons = buttons(await (await get(`/admin/media_manage?prefix=${encodeURIComponent('image/')}`, env, cookie)).text());
  assert.ok(imageButtons.includes(`?prefix=${encodeURIComponent('image/food/')}`), '按钮换成当前目录的子目录');
  assert.ok(imageButtons.includes('存储桶根目录') && !imageButtons.includes('btn-primary'),
    '「存储桶根目录」常驻可一键回根, 但这时不高亮');
  assert.ok(!imageButtons.includes(encodeURIComponent('news_uploads/')) && !imageButtons.includes(encodeURIComponent('video/')),
    '固定的 image//video//news_uploads/ 按钮已并入动态层级');

  // 没有子目录的那一层: 只剩「存储桶根目录」(返回上一层仍靠面包屑/上一级)
  const videoButtons = buttons(await (await get(`/admin/media_manage?prefix=${encodeURIComponent('video/')}`, env, cookie)).text());
  assert.ok(videoButtons.includes('存储桶根目录') && !videoButtons.includes('?prefix='),
    '本层没有子目录时就只有「存储桶根目录」');
});

test('引用判定(2.6.5): 子目录里"同后缀"的文件不再把根目录的同名文件标成被引用', async () => {
  // 线上反馈的原始例子: 素材实际引用的是 image/food/2017-2018.jpg, 根目录的 2018.jpg 却显示"被引用"
  const { env } = makeAdminEnv({
    role: 'super',
    mediaObjects: [
      { key: '2018.jpg', size: 2048, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'image/food/2017-2018.jpg', size: 4096, uploaded: '2026-10-09T00:00:00Z' }
    ],
    // 详情页先 head 再看引用: 桩的 head 只认 put 过的对象, 这里显式给一个
    mediaHead: (key) => (key === '2018.jpg' ? { key, size: 2048, httpMetadata: {} } : null),
    rows: {
      news: [{
        id: 3, title: '正文用了子目录那张', image: '', video_url: '',
        content: '<p><img src="image/food/2017-2018.jpg"></p>', deleted_at: null
      }]
    }
  });
  const cookie = await loginCookie(env);
  const rootLevel = await (await get('/admin/media_manage', env, cookie)).text();
  const rowOf = (path) => {
    const at = rootLevel.indexOf(`title="${path}"`);
    return at < 0 ? '' : rootLevel.slice(rootLevel.lastIndexOf('<tr', at), rootLevel.indexOf('</tr>', at));
  };
  assert.ok(rowOf('2018.jpg').includes('未引用'), '根目录的 2018.jpg 没有被引用');

  // 真正被引用的那张在子目录里, 引用数照旧算得出来(别为了修误判把判定改成一律"未引用")
  const deep = await (await get(`/admin/media_manage?prefix=${encodeURIComponent('image/food/')}`, env, cookie)).text();
  assert.match(deep, /1 处/, '子目录那张仍算出 1 处引用');
  // 三处判定同源: 列表列 / 「查看引用」/ 详情
  const refs = await (await get('/admin/media_manage_refs?path=2018.jpg', env, cookie)).json();
  assert.equal(refs.total, 0, '「查看引用」与列表列同一结论');
  const detail = await (await get(`/admin/media_manage_detail?path=${encodeURIComponent('2018.jpg')}`, env, cookie)).text();
  assert.ok(detail.includes('没有任何引用'), '详情页也一致');
});

test('素材库(2.4.0): 详情页给出体积/类型/时间/引用, 预览直接用原图(不再探测缩略图)', async () => {
  const { env } = makeAdminEnv({
    role: 'super',
    mediaObjects: MEDIA_OBJECTS,
    rows: mediaRows,
    mediaHead: (key) => (key === 'image/new.png' ? { key } : null)
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/media_manage_detail?path=image/new.png', env, cookie)).text();
  assert.ok(html.includes('对象详情'));
  assert.ok(html.includes('<code>image/new.png</code>'));
  assert.ok(html.includes('所在层') && html.includes('image/'), '详情页给出所在层(可点回那一层)');
  assert.ok(html.includes('笔记 · 正文'), '引用来源列出来');
  assert.ok(html.includes('笔记 #2'), '笔记引用链到编辑页');
  assert.ok(html.includes('src="https://media.test/image/new.png"'), '预览用原图');
  assert.ok(!html.includes('_thumb'), '详情页不再出现任何缩略图地址');
  // head 拿不到就回列表并带错误(不 500)
  const missing = await get('/admin/media_manage_detail?path=image/none.png', env, cookie);
  assert.equal(missing.status, 302);
  assert.match(String(missing.headers.get('location')), /error=/);
});

test('素材库(2.3.9): 改名被引用就拒绝(不擅自改写笔记), 无引用时读→写→删', async () => {
  const { env, state } = makeAdminEnv({
    role: 'super',
    mediaObjects: MEDIA_OBJECTS,
    rows: mediaRows,
    // 有引用的那条(a.png)在 mediaObjects 里; 新写入的对象在 state.objects 里 —— 两者 head 都要能拿到
    mediaHead: (key) => (key === 'news_uploads/a.png' ? { key } : (state.objects.has(String(key)) ? { key } : null))
  });
  const cookie = await loginCookie(env);
  // 先"上传"一个待改名的对象(桩的 put 会把它记进内存对象表, head/get 才拿得到)
  state.objects.set('image/old_name.png', { size: 1024, httpMetadata: { contentType: 'image/png' } });

  // ① 有引用: 拒绝
  const blocked = await (await get('/admin/media_manage_rename?path=news_uploads/a.png', env, cookie)).text();
  assert.ok(blocked.includes('改名/移动会让这些引用指向不存在的文件'), '有引用时说明原因');
  assert.ok(!blocked.includes('name="dir"'), '有引用时不渲染表单');
  assert.ok(blocked.includes('改为复制'), '被引用而想留副本: 给出「改为复制」入口');
  const refused = await post('/admin/media_manage_rename',
    { path: 'news_uploads/a.png', dir: 'image', name: 'renamed.png', back: '/admin/media_manage' }, env, cookie);
  assert.match(String(refused.headers.get('location')), /error=/);
  assert.equal(state.puts.length, 0, '拒绝时不能写对象');
  assert.equal(state.deletes.length, 0, '拒绝时不能删对象');

  // ② 无引用: 表单 + 成功改名(新 key 写入、旧 key 删除)
  const form = await (await get('/admin/media_manage_rename?path=image/old_name.png', env, cookie)).text();
  assert.ok(form.includes('name="dir"') && form.includes('name="name"'), '无引用时给表单');
  assert.ok(form.includes('value="old_name.png"'), '文件名预填');
  const ok = await post('/admin/media_manage_rename',
    { path: 'image/old_name.png', dir: 'image', name: 'new_name.png', back: '/admin/media_manage' }, env, cookie);
  assert.equal(ok.status, 302);
  assert.match(String(ok.headers.get('location')), /message=/);
  assert.deepEqual(state.puts, ['image/new_name.png']);
  assert.deepEqual(state.deletes, ['image/old_name.png']);
  assert.ok(state.objects.has('image/new_name.png'));

  // ③ 目录与扩展名不匹配 / 目标已存在 / 名字带斜杠: 都拦住
  const mismatch = await post('/admin/media_manage_rename',
    { path: 'image/new_name.png', dir: 'video', name: 'new_name.png', back: '/admin/media_manage' }, env, cookie);
  assert.match(String(mismatch.headers.get('location')), /error=/, '图片不能塞进 video/');
  state.objects.set('image/taken.png', { size: 1, httpMetadata: {} });
  const taken = await post('/admin/media_manage_rename',
    { path: 'image/new_name.png', dir: 'image', name: 'taken.png', back: '/admin/media_manage' }, env, cookie);
  assert.ok(String(taken.headers.get('location')).includes(encodeURIComponent('目标路径已存在')));
  const slashed = await post('/admin/media_manage_rename',
    { path: 'image/new_name.png', dir: 'image', name: '../evil.png', back: '/admin/media_manage' }, env, cookie);
  assert.match(String(slashed.headers.get('location')), /error=/);
});

test('素材库(2.3.9): 批量删除一次 R2 调用, 超上限或被引用整批拒绝', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);

  // ① 两个未引用的素材: 确认页列出两条, 提交后一次 R2 delete 删掉两个
  const twoKeys = JSON.stringify(['news_uploads/b.mp4', 'image/free.png']);
  const confirm = await (await get(`/admin/media_manage_delete?paths=${encodeURIComponent(twoKeys)}`, env, cookie)).text();
  assert.ok(confirm.includes('即将删除 2 个对象'));
  assert.ok(confirm.includes('待删除对象'));
  const res = await post('/admin/media_manage_delete',
    { paths: twoKeys, back: '/admin/media_manage', confirm: '1' }, env, cookie);
  assert.equal(res.status, 302);
  assert.match(String(res.headers.get('location')), /message=/);
  assert.deepEqual(state.deletes.sort(), ['image/free.png', 'news_uploads/b.mp4']);
  assert.equal(state.deleteCalls, 1, '批量删除只花 1 次 R2 子请求(delete 收数组)');

  // ② 其中一个被引用 → 整批拒绝, 一个都不删
  state.deletes.length = 0;
  state.deleteCalls = 0;
  const mixedKeys = JSON.stringify(['news_uploads/b.mp4', 'news_uploads/a.png']);
  const mixed = await post('/admin/media_manage_delete',
    { paths: mixedKeys, back: '/admin/media_manage', confirm: '1' }, env, cookie);
  assert.ok(String(mixed.headers.get('location')).includes(encodeURIComponent('已整批拒绝')));
  assert.deepEqual(state.deletes, [], '整批拒绝时一个都不能删');
  const mixedConfirm = await (await get(`/admin/media_manage_delete?paths=${encodeURIComponent(mixedKeys)}`, env, cookie)).text();
  assert.ok(mixedConfirm.includes('整批拒绝'));

  // ③ 超过一次上限(21 个) → 直接拒绝
  const many = JSON.stringify(Array.from({ length: 21 }, (item, index) => `image/p${index}.png`));
  const tooMany = await post('/admin/media_manage_delete', { paths: many, back: '/admin/media_manage', confirm: '1' }, env, cookie);
  // URLSearchParams 把空格编成 `+`, 所以先解码再比文案
  assert.ok(decodeURIComponent(String(tooMany.headers.get('location')).replace(/\+/g, ' ')).includes('一次最多删除 20 个'));
});

test('存储桶(2.4.6): 前缀浏览 + 引用状态筛选(参数进 URL, 切筛选时跟着走)', async () => {
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: MEDIA_OBJECTS, rows: mediaRows });
  const cookie = await loginCookie(env);
  const news = encodeURIComponent('news_uploads/');

  // 2.3.9 的「目录」下拉换成"前缀浏览": 进哪一层就只列哪一层
  const byDir = await (await get(`/admin/media_manage?prefix=${news}`, env, cookie)).text();
  assert.ok(byDir.includes('news_uploads/a.png') && byDir.includes('news_uploads/b.mp4'));
  assert.ok(!byDir.includes('image/new.png'), '只列当前这一层');

  const unused = await (await get(`/admin/media_manage?prefix=${news}&ref=unused`, env, cookie)).text();
  assert.ok(unused.includes('news_uploads/b.mp4'), '未引用清单里有 b.mp4');
  assert.ok(!unused.includes('news_uploads/a.png'), '被引用的 a.png 不该出现在未引用清单');

  const used = await (await get(`/admin/media_manage?prefix=${news}&ref=used`, env, cookie)).text();
  assert.ok(used.includes('news_uploads/a.png'));
  assert.ok(!used.includes('news_uploads/b.mp4'));

  // 筛选条要带上新参数(与 filterButtons 的 extra 规则一致: 切类型时前缀/引用状态跟着走)
  assert.ok(filterBar(byDir).includes('prefix=news_uploads'), '切类型时前缀参数要带过去');
  const next = await (await get(`/admin/media_manage?prefix=${encodeURIComponent('image/')}&kind=image&ref=unused`, env, cookie)).text();
  assert.ok(next.includes('name="prefix"') && next.includes('name="ref"'), '搜索条里有前缀隐藏字段与引用状态下拉');
  assert.ok(next.includes('<option value="unused" selected>'), '引用状态选中态回填');
});
