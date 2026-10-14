// 公告接收人四档的真实库自检(2.5.9): 桩只能证明"SQL 长什么样", 证明不了口径对不对 ——
// 这里用真实 SQLite 顶掉 D1, 建 0001 的表、插真数据、走真接口, 回答四个问题:
// 谁能收到哪条 / 未读数(红点来源)对不对 / 已读是否互不影响 / 游客看得到什么。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getJson, makeEnv } from './stub.mjs';

const SCHEMA = readFileSync(new URL('../app/sql/0001_schema.sql', import.meta.url), 'utf8');

async function sqliteOf() {
  try {
    return (await import('node:sqlite')).default || await import('node:sqlite');
  } catch (error) {
    return null;
  }
}

/** D1 的最小替身: prepare/bind/first/all/run 形状一致, 底下跑真 SQLite。 */
function d1Of(db) {
  return {
    prepare(sql) {
      let args = [];
      const api = {
        bind(...list) {
          args = list.map((item) => (item === undefined ? null : item));
          return api;
        },
        async first() {
          const rows = db.prepare(sql).all(...args);
          return rows.length ? rows[0] : null;
        },
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
        async run() {
          db.prepare(sql).run(...args);
          return { meta: { changes: 1 } };
        }
      };
      return api;
    },
    batch: async (list) => Promise.all(list.map((item) => item.run()))
  };
}

/** 建库 + 造数据: 3 个用户(普通/内部测试/另一个普通) × 6 条公告(四档 + 一条已下架)。 */
function buildEnv(sqlite) {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(SCHEMA);
  // 7=普通甲 / 8=内测乙 / 9=普通丙(用来证明"定向给甲"不会串到丙)
  db.exec(`INSERT INTO users (id, username, nickname, token, status, is_trusted, openid) VALUES
    (7, 'wx_u7', '普通甲', 'tok-7', 0, 0, 'openid-7'),
    (8, 'wx_u8', '内测乙', 'tok-8', 0, 1, 'openid-8'),
    (9, 'wx_u9', '普通丙', 'tok-9', 0, 0, 'openid-9');`);
  db.exec(`INSERT INTO app_notices (id, title, content, level, status, receiver_type, target_user_id, create_time) VALUES
    (1, '全员公告', 'x', 'info', 1, 0, NULL, '2026-10-15 09:00:00'),
    (2, '内测公告', 'x', 'info', 1, 1, NULL, '2026-10-15 09:01:00'),
    (3, '普通公告', 'x', 'info', 1, 2, NULL, '2026-10-15 09:02:00'),
    (4, '定向给甲', 'x', 'info', 1, 3, 7, '2026-10-15 09:03:00'),
    (5, '定向给丙', 'x', 'info', 1, 3, 9, '2026-10-15 09:04:00'),
    (6, '已下架公告', 'x', 'info', 0, 0, NULL, '2026-10-15 09:05:00');`);
  const { env } = makeEnv({ db: () => null });
  env.DB = d1Of(db);
  return env;
}

const titlesOf = async (env, token) => {
  const body = await getJson(`/content/get_notices?page=1&page_size=20${token ? `&token=${token}` : ''}`, env);
  assert.equal(body.code, 200, JSON.stringify(body).slice(0, 200));
  return body.data.list.map((item) => item.title);
};

/** 只比"看得到哪些", 不比顺序(列表排序规则另有守卫)。 */
const sameTitles = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());

const unreadOf = async (env, token) => {
  const body = await getJson(`/content/get_notice_unread?token=${token}`, env);
  assert.equal(body.code, 200, JSON.stringify(body).slice(0, 200));
  return body.data.unread_count;
};

test('接收人四档(2.5.9): 真实库里谁能看到哪条 + 未读数(红点)对得上', async (t) => {
  const sqlite = await sqliteOf();
  if (!sqlite) {
    t.skip('本机没有 node:sqlite');
    return;
  }
  const env = buildEnv(sqlite);

  // 游客: 只看得到"所有用户"的公告, 且看不到已下架的
  sameTitles(await titlesOf(env, ''), ['全员公告']);
  const guest = await getJson('/content/get_notice_unread', env);
  assert.equal(guest.data.unread_count, 0);
  assert.equal(guest.msg, '未登录');

  // 0=所有用户 / 2=普通用户 / 3=定向给我 —— 普通用户这三样都收得到, 收不到内测(1)与别人的定向(5)
  sameTitles(await titlesOf(env, 'tok-7'), ['定向给甲', '全员公告', '普通公告']);
  // 内部测试用户拿的是 0 + 1, 拿不到 2(普通用户)
  sameTitles(await titlesOf(env, 'tok-8'), ['内测公告', '全员公告']);
  // 另一个普通用户: 定向给丙的能看到, 定向给甲的看不到 —— 定向不串号
  sameTitles(await titlesOf(env, 'tok-9'), ['定向给丙', '全员公告', '普通公告']);

  // 红点来源: 未读数 = 看得到的 − 自己读过的
  assert.equal(await unreadOf(env, 'tok-7'), 3);
  assert.equal(await unreadOf(env, 'tok-8'), 2);
  assert.equal(await unreadOf(env, 'tok-9'), 3);

  // 发布时间到秒(2.5.9): 端上直接显示这个字符串, 不再自己格式化
  const list = (await getJson('/content/get_notices?page=1&page_size=20&token=tok-7', env)).data.list;
  assert.equal(list.find((item) => item.id === 4).published_at, '2026-10-15 09:03:00');
  assert.equal(list.find((item) => item.id === 1).is_read, false, '没读过就是未读(端上条目红点看它)');
});

test('已读互不影响(2.5.9): 甲读了不改变乙丙的未读数', async (t) => {
  const sqlite = await sqliteOf();
  if (!sqlite) {
    t.skip('本机没有 node:sqlite');
    return;
  }
  const env = buildEnv(sqlite);

  const read = await getJson('/content/notice_read?token=tok-7&notice_id=1', env);
  assert.equal(read.msg, '已标记为已读');
  assert.equal(read.data.unread_count, 2, '回包里的未读数与未读接口同口径');

  assert.equal(await unreadOf(env, 'tok-7'), 2);
  assert.equal(await unreadOf(env, 'tok-9'), 3, '别人没读, 未读数不该被牵连');
  assert.equal(await unreadOf(env, 'tok-8'), 2);

  const list = (await getJson('/content/get_notices?page=1&page_size=20&token=tok-7', env)).data.list;
  assert.equal(list.find((item) => item.id === 1).is_read, true);
  assert.equal(list.find((item) => item.id === 4).is_read, false, '只标了这一条, 其它仍是未读');
  // 甲的已读不影响丙看到的同一条(丙的列表里它还是未读)
  const other = (await getJson('/content/get_notices?page=1&page_size=20&token=tok-9', env)).data.list;
  assert.equal(other.find((item) => item.id === 1).is_read, false);
});
