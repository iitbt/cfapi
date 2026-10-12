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
});
