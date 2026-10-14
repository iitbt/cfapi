// SQL 迁移自检(2.4.9): 0005 冗余索引清理 + 0006 老库重建表。
// 这两个脚本只会在真库上手动执行一次, 所以更要在本地用真实 SQLite 先跑一遍 ——
// 桩测试看不出 DDL 写错, 而这种错一旦在线上发生就是"表被删了数据没了"。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (name) => readFileSync(new URL(`../app/sql/${name}`, import.meta.url), 'utf8');

//: 2.4.9 之前的老库形态: 允许 NULL / 空串默认值, 且带着当年那批重复索引与短索引
const LEGACY_DDL = `
CREATE TABLE "news" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT, "user_id" INTEGER, "title" TEXT NOT NULL DEFAULT '',
  "desc" TEXT, "content" TEXT, "category" TEXT NOT NULL DEFAULT '', "image" TEXT, "video_url" TEXT,
  "publish_time" TEXT DEFAULT (datetime('now','+8 hours')), "activity_time" TEXT,
  "view_count" INTEGER NOT NULL DEFAULT 0, "shares" INTEGER DEFAULT 0, "likes" INTEGER DEFAULT 0,
  "favorites" INTEGER DEFAULT 0, "type" TEXT DEFAULT 'admin_users',
  "status" TEXT DEFAULT 'approved', deleted_at TEXT);
CREATE INDEX idx_news_category ON news (category);
CREATE INDEX idx_news_category_deleted ON news (category, deleted_at);
CREATE INDEX idx_news_status ON news (status);
CREATE INDEX idx_news_status_deleted_publish ON news (status, deleted_at, publish_time);
CREATE INDEX idx_news_publish ON news (publish_time);
CREATE INDEX idx_news_user ON news (user_id);
CREATE INDEX "user_id" ON "news" ("user_id");
CREATE TABLE "news_likes" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT, "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0, "created_at" TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX news_likes_uniq ON news_likes (news_id, user_id);
CREATE UNIQUE INDEX "unique_like" ON "news_likes" ("news_id", "user_id");
CREATE INDEX idx_news_likes_user ON news_likes (user_id, created_at);
CREATE TABLE "news_favorites" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT, "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0, "created_at" TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX news_favorites_uniq ON news_favorites (news_id, user_id);
CREATE UNIQUE INDEX "unique_favorite" ON news_favorites (news_id, user_id);
CREATE INDEX idx_news_favorites_user ON news_favorites (user_id, created_at);
CREATE TABLE "news_view_history" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT, "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0, "created_at" TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX "news_view_history_uniq" ON "news_view_history" ("news_id", "user_id");
CREATE INDEX "idx_nvh_user_time" ON "news_view_history" ("user_id", "created_at", "id");
`;

async function sqliteOf() {
  try {
    return (await import('node:sqlite')).default || await import('node:sqlite');
  } catch (error) {
    return null;
  }
}

test('迁移 0005/0006: 老库收紧约束时数据不丢、索引齐、约束生效', async (t) => {
  const sqlite = await sqliteOf();
  if (!sqlite) {
    t.skip('本机没有 node:sqlite');
    return;
  }
  const db = new sqlite.DatabaseSync(':memory:');
  const run = (sql) => db.exec(sql);
  run(LEGACY_DDL);
  // 老库里真实存在过的脏数据: 计数/状态/type/时间为 NULL, 关联表时间为空串
  run(`INSERT INTO news (title, "desc", category, publish_time, status, likes, shares, favorites, type)
       VALUES ('老数据', '摘要', 'outdoor', NULL, NULL, NULL, NULL, NULL, NULL)`);
  run("INSERT INTO news_likes (news_id, user_id, created_at) VALUES (5, 7, '')");
  run("INSERT INTO news_favorites (news_id, user_id, created_at) VALUES (5, 7, '')");
  const before = db.prepare('SELECT COUNT(*) AS c FROM news').get().c;

  // 0005 幂等: 连跑两次都不能报错
  run(read('0005_drop_redundant_indexes.sql'));
  run(read('0005_drop_redundant_indexes.sql'));
  const newsIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='news'").all()
    .map((item) => item.name);
  for (const gone of ['idx_news_category', 'idx_news_status', 'user_id']) {
    assert.ok(!newsIndexes.includes(gone), `0005 应删掉冗余索引 ${gone}`);
  }

  run(read('0006_news_notnull_rebuild.sql'));

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM news').get().c, before, '行数不能变');
  const row = db.prepare("SELECT * FROM news WHERE title='老数据'").get();
  assert.equal(row.id, 1, 'id 要保留');
  assert.equal(row.likes, 0);
  assert.equal(row.shares, 0);
  assert.equal(row.favorites, 0);
  assert.equal(row.status, 'approved');
  assert.equal(row.type, 'admin_users');
  assert.ok(row.publish_time, 'publish_time 要补上默认值');
  assert.equal(row.activity_time, null, '可空列不该被改写');
  assert.equal(row.deleted_at, null);
  assert.notEqual(db.prepare('SELECT created_at FROM news_likes').get().created_at, '', '关联表空串时间要补上');

  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_new'").all(), [],
    '不能残留 *_new 临时表');
  const rebuilt = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('news','news_likes','news_favorites','news_view_history')").all()
    .map((item) => item.name);
  for (const wanted of ['idx_news_category_deleted', 'idx_news_publish', 'idx_news_status_deleted_publish',
    'idx_news_user', 'news_likes_uniq', 'idx_news_likes_user', 'news_favorites_uniq', 'idx_news_favorites_user',
    'news_view_history_uniq', 'idx_nvh_user_time']) {
    assert.ok(rebuilt.includes(wanted), `重建后要有索引 ${wanted}`);
  }
  assert.throws(() => run("INSERT INTO news_likes (news_id, user_id, created_at) VALUES (5, 7, '2026-10-12 00:00:00')"),
    /UNIQUE/i, '唯一索引要仍然生效(点赞去重靠它)');
  assert.throws(() => run("INSERT INTO news (title, status) VALUES ('x', NULL)"),
    /NOT NULL/i, 'NOT NULL 要仍然生效');
});

test('迁移 0005: 新建库(0001~0004) 跑一遍也不报错', async (t) => {
  const sqlite = await sqliteOf();
  if (!sqlite) {
    t.skip('本机没有 node:sqlite');
    return;
  }
  const db = new sqlite.DatabaseSync(':memory:');
  for (const file of ['0001_schema.sql', '0002_rate_limit.sql', '0003_wechat_token.sql', '0004_admin.sql']) {
    db.exec(read(file));
  }
  db.exec(read('0005_drop_redundant_indexes.sql'));
  const left = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='news_comments'").all()
    .map((item) => item.name);
  assert.ok(!left.includes('status'), '新建库里那条重复索引也应被清掉');
  // 新建库的 0001 就必须带这几列(定向公告 2.5.7 / 接收人 2.5.9 / 多选收件人 2.6.0), 老库才靠 0008、0009、0010 补
  const columns = db.prepare("SELECT name FROM pragma_table_info('app_notices')").all().map((item) => item.name);
  for (const wanted of ['target_user_id', 'receiver_type', 'target_user_ids']) {
    assert.ok(columns.includes(wanted), `新建库的 app_notices 应有 ${wanted} 列`);
  }
});

test('迁移 0008/0009: 老库补接收人列, 历史定向行必须回填成「指定用户」', async (t) => {
  const sqlite = await sqliteOf();
  if (!sqlite) {
    t.skip('本机没有 node:sqlite');
    return;
  }
  const db = new sqlite.DatabaseSync(':memory:');
  // 2.5.7 之前的 app_notices: 既没有 target_user_id, 也没有 receiver_type
  db.exec(`CREATE TABLE app_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', content TEXT,
    level TEXT NOT NULL DEFAULT 'info', start_at TEXT, end_at TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 1, create_time TEXT);`);
  db.exec("INSERT INTO app_notices (title) VALUES ('全体公告')");

  db.exec(read('0008_notice_target.sql'));
  // 2.5.7 起发的系统消息: target_user_id 非空
  db.exec("INSERT INTO app_notices (title, target_user_id) VALUES ('定向消息', 7)");

  db.exec(read('0009_notice_receiver.sql'));
  const rows = db.prepare('SELECT title, receiver_type, target_user_id FROM app_notices ORDER BY id').all();
  assert.deepEqual(rows.map((row) => [row.title, row.receiver_type]), [['全体公告', 0], ['定向消息', 3]],
    '全体公告保持默认 0(与历史数据同义); 定向消息必须回填 3 —— 不回填就成了「私信变广播」');
  assert.equal(rows[1].target_user_id, 7, '收件人 id 不该被动过');
});

test('迁移 0010: 老库的单值收件人折进逗号列表(2.6.0 一条公告可发给多位)', async (t) => {
  const sqlite = await sqliteOf();
  if (!sqlite) {
    t.skip('本机没有 node:sqlite');
    return;
  }
  const db = new sqlite.DatabaseSync(':memory:');
  // 2.5.9 时期的 app_notices: 只有单值列 target_user_id(没有 target_user_ids)
  db.exec(`CREATE TABLE app_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', content TEXT,
    level TEXT NOT NULL DEFAULT 'info', start_at TEXT, end_at TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 1,
    receiver_type INTEGER NOT NULL DEFAULT 0, target_user_id INTEGER, create_time TEXT);`);
  // 三行: 全体公告 / 2.5.7 起的定向系统消息 / 一条"类型=定向但没写收件人"的脏行
  db.exec(`INSERT INTO app_notices (title, receiver_type, target_user_id) VALUES
    ('全体公告', 0, NULL), ('定向消息', 3, 7), ('脏行', 3, 0);`);

  db.exec(read('0010_notice_targets.sql'));

  const rows = db.prepare('SELECT title, target_user_ids FROM app_notices ORDER BY id').all();
  assert.deepEqual(rows.map((row) => [row.title, row.target_user_ids]),
    [['全体公告', ''], ['定向消息', ',7,'], ['脏行', '']],
    '定向行折成两端带逗号的列表; 全体公告与脏行保持空串(不许写成 "7" 这种单值形状, LIKE 会匹配不上)');
  // 折过来之后, 新代码的可见性判定就是靠这一条 LIKE: 命中不了等于"这条定向消息谁都收不到"(静默丢消息)
  const hit = db.prepare('SELECT COUNT(*) AS c FROM app_notices WHERE target_user_ids LIKE ?').get('%,7,%').c;
  assert.equal(hit, 1, "LIKE '%,7,%' 要能命中折过来的收件人");
  // 新列必须带 NOT NULL DEFAULT '': 后台"接收人类型不是指定用户时清空列表"直接写空串, 给 NULL 会让 LIKE 判定变成 UNKNOWN
  const column = db.prepare("SELECT \"notnull\", dflt_value FROM pragma_table_info('app_notices') WHERE name='target_user_ids'").get();
  assert.equal(column.notnull, 1, 'target_user_ids 要 NOT NULL');
  assert.equal(column.dflt_value, "''", "默认值要是空串");
});
