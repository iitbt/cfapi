// 内容管理端到端自检: 公告 / 分类(含迁移) / 首页板块 / 首页精选 / 通用删除确认页
import assert from 'node:assert/strict';
import test from 'node:test';

import { findCall, get, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

const NOTICE = {
  id: 8, title: '系统维护通知', content: '<p>今晚维护</p>', level: 'important',
  link_type: 'page', link_value: '/pages/notice/notice?id=1', start_at: '2026-10-01 00:00:00',
  end_at: '2026-10-31 00:00:00', sort_order: 3, status: 1
};
/**
 * from 到 to 之间有没有"跨层" —— 数 <div 与 </div> 的出现次数, 相等表示两者同级。
 * 为什么需要它: 公告编辑页「指定用户」那一段的显隐靠 `#noticeReceiver3:checked ~ .notice-picker`,
 * 而 `~` 只认**同一父元素下的后续兄弟**。只断言"CSS 规则文本存在"证明不了它命得中 ——
 * 2.6.0 把 radio 包进 .form-check 容器后就隔了一层, 规则在、控件却永远不显示。
 */
function sameLevel(html, from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  if (start < 0 || end < 0) return false;
  const slice = html.slice(start + from.length, end);
  return (slice.match(/<div\b/g) || []).length === (slice.match(/<\/div>/g) || []).length;
}

const CATEGORY_ROWS = [
  { id: 1, category_key: 'outdoor', name: '户外', sort_order: 10, status: 1, news_count: 12, home_ref_count: 1 },
  { id: 2, category_key: 'food', name: '聚餐', sort_order: 20, status: 0, news_count: 3, home_ref_count: 0 }
];
const HOME_ROWS = [
  { id: 5, section_key: 'main', item_id: 'outdoor', name: '户外', image_url: 'news_uploads/home/hw.jpg', sort_order: 1, status: 1 }
];
//: 原「首页精选管理」的数据(2.2.5 起在首页板块管理页的「精选项目」里展示)
const FEATURED_ROWS = [
  { id: 9, item_key: 'outdoor_sale', name: '户外精选', image_url: 'image/featured.png', page_path: '/pages/outdoor/outdoor', sort_order: 1, status: 1 }
];

test('公告列表: 关键词与状态筛选进 SQL, 行里给类型徽章与生效时间', async () => {
  const { env, state } = makeAdminEnv({
    rows: { app_notices: [NOTICE] }, counts: { app_notices: 1 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/notice_manage?keyword=维护&status=1', env, cookie)).text();
  assert.ok(html.includes('系统维护通知'));
  assert.ok(html.includes('重要'), '类型显示中文');
  assert.ok(html.includes('2026-10-01 00:00 ~ 2026-10-31 00:00'), '生效时间区间');
  const count = findCall(state, /COUNT\(\*\) AS total FROM app_notices/i);
  assert.ok(/title LIKE \?/.test(count.sql) && /status = \?/.test(count.sql), count.sql);
  assert.deepEqual(count.args.slice(0, 2), ['%维护%', 1]);
});

test('公告列表: 停用/未生效/已过期的补充说明', async () => {
  const { env } = makeAdminEnv({
    rows: {
      app_notices: [Object.assign({}, NOTICE, { status: 0 }), Object.assign({}, NOTICE, { id: 9, status: 1, start_at: '2099-01-01 00:00:00' })]
    },
    counts: { app_notices: 2 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/notice_manage', env, cookie)).text();
  assert.ok(html.includes('已停用，小程序不显示'));
  assert.ok(html.includes('未到生效时间'));
});

test('公告编辑: 跳转页面必须以 /pages/ 或 /subpackages/ 开头', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/notice_edit?id=0',
    { title: '公告一', level: 'info', link_value: 'https://example.com/x' }, env, cookie);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('跳转页面必须以 /pages/ 或 /subpackages/ 开头'));
  assert.equal(findCall(state, /INSERT INTO app_notices/i), null);
});

test('公告编辑: 开始时间晚于结束时间被拒', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/notice_edit?id=0',
    { title: '公告二', level: 'info', start_at: '2026-10-10T10:00', end_at: '2026-10-01T10:00' }, env, cookie);
  assert.ok((await res.text()).includes('生效开始时间不能晚于结束时间'));
});

test('公告编辑: 保存成功时 link_type 由跳转地址派生, 时间归一成带秒的格式', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/notice_edit?id=0', {
    title: '公告三', level: 'warning', link_value: '/pages/notice/notice', start_at: '2026-10-10T10:00', status: '1'
  }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('公告已添加')));
  const insert = findCall(state, /INSERT INTO app_notices/i);
  assert.equal(insert.args[3], 'page', 'link_type 派生为 page');
  assert.equal(insert.args[5], '2026-10-10 10:00:00', 'datetime-local 的 T 要归一(否则公告永不生效)');
});

test('公告列表(2.5.9): 接收人列显示发给谁, 可按接收人筛选', async () => {
  const { env, state } = makeAdminEnv({
    rows: {
      app_notices: [
        Object.assign({}, NOTICE, { id: 8, receiver_type: 0 }),
        Object.assign({}, NOTICE, { id: 9, receiver_type: 3, target_user_ids: ',7,' }),
        Object.assign({}, NOTICE, { id: 10, receiver_type: 1 })
      ],
      users: [{ id: 7, nickname: '老王', username: 'wx_a' }]
    },
    counts: { app_notices: 3 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/notice_manage?receiver=3', env, cookie)).text();
  // 四种接收人都要出现在筛选按钮里, 缺一个就等于筛不出来
  for (const label of ['所有用户', '内部测试用户', '普通用户', '指定用户']) {
    assert.ok(html.includes(label), `筛选缺少「${label}」`);
  }
  assert.ok(html.includes('老王'), '「指定用户」的公告要显示发给谁(否则列表里看不出收件人)');
  const count = findCall(state, /COUNT\(\*\) AS total FROM app_notices/i);
  assert.ok(/receiver_type = \?/.test(count.sql), count.sql);
  assert.deepEqual(count.args, [3]);
});

test('公告编辑(2.5.9): 接收人卡片仅超管可见, 选「指定用户」必须勾人', async () => {
  const { env, state } = makeAdminEnv({
    rows: { users: [{ id: 7, nickname: '老王', username: 'wx_a', avatar: '', is_trusted: 0 }] }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/notice_edit?id=0', env, cookie)).text();
  assert.ok(html.includes('name="receiver_type"'), '超管可改接收人');
  assert.ok(html.includes('name="target_user_id"'), '要能勾选具体用户');
  // 四个 radio 必须与 .notice-picker **平铺同级**, 否则 CSS 的 ~ 命不中, 选「指定用户」什么都不出现(2.6.1 修的就是它)。
  // 终点取到 `<div class="notice-picker` 的**标签开头**: 只写到 class= 的话, 那个 <div 会被算进"起点到终点之间", 永远判成跨层
  for (const value of [0, 1, 2, 3]) {
    assert.ok(sameLevel(html, `id="noticeReceiver${value}"`, '<div class="notice-picker'),
      `#noticeReceiver${value} 必须与 .notice-picker 同级(套了 .form-check 之类容器就隔了一层)`);
  }

  // 选了「指定用户」却没勾人 → 拦下, 不落库(否则这条公告谁都收不到)
  const bad = await post('/admin/notice_edit?id=0',
    { title: '定向公告', level: 'info', receiver_type: '3', status: '1' }, env, cookie);
  assert.equal(bad.status, 200);
  assert.ok((await bad.text()).includes('必须至少选一位用户'));
  assert.equal(findCall(state, /INSERT INTO app_notices/i), null);

  // 2.6.0 起收件人是**同名多值**字段: 勾两位就提交两个 target_user_id(见 app/admin/index.js 的 readForm),
  // 存成两端带逗号的逗号列表(见 core/notice_targets.js)
  const saved = await post('/admin/notice_edit?id=0',
    { title: '定向公告', level: 'info', receiver_type: '3', target_user_id: ['7', '9'], status: '1' }, env, cookie);
  assert.equal(saved.status, 302);
  const insert = findCall(state, /INSERT INTO app_notices/i);
  assert.equal(insert.args[9], 3, 'receiver_type=3(指定用户)');
  assert.equal(insert.args[10], ',7,9,', 'target_user_ids = 勾选的用户(逗号列表)');

  // 类型改回「所有用户」: 被 CSS 隐藏的收件人控件**照样会随表单提交**, 后端必须忽略它并把列表清空。
  // 反过来(依赖"前端保证不提交")的后果是一条发给 5 个人的定向公告, 被一次普通"改标题"扩散成全员广播
  const cleared = await post('/admin/notice_edit?id=0',
    { title: '改回全员', level: 'info', receiver_type: '0', target_user_id: ['7', '9'], status: '1' }, env, cookie);
  assert.equal(cleared.status, 302);
  const inserts = state.calls.filter((call) => /INSERT INTO app_notices/i.test(call.sql));
  assert.equal(inserts[inserts.length - 1].args[9], 0, 'receiver_type 落成「所有用户」');
  assert.equal(inserts[inserts.length - 1].args[10], '', '非「指定用户」时收件人列表必须清空');
});

test('公告批量删除(2.6.1): 一次删多条 + 连带清已读记录 + 筛选页码带回 + 失败项说明原因', async () => {
  const { env, state } = makeAdminEnv({
    rows: {
      users: [{ id: 7, nickname: '老王', username: 'wx_a', avatar: '', is_trusted: 0 }],
      app_notices: [Object.assign({}, NOTICE, { id: 8 }), Object.assign({}, NOTICE, { id: 9 })]
    },
    counts: { app_notices: 2 },
    // 桩把"这条公告还在不在"固定成 8/9 还在: 999 用来验证"勾了之后被别人删掉"的跳过分支
    db: (sql, args, kind) => (kind === 'all' && /SELECT id FROM app_notices WHERE id IN/i.test(sql)
      ? [{ id: 8 }, { id: 9 }] : undefined)
  });
  const cookie = await loginCookie(env);

  // 列表: 表头全选 + 每行勾选框 + 批量表单(与笔记页共用 static/js/news_batch.js, 靠 data-unit 换文案与确认语)
  const listHtml = await (await get('/admin/notice_manage?receiver=3&keyword=维护&page=2', env, cookie)).text();
  assert.ok(listHtml.includes('id="rowCheckAll"'), '表头要有全选');
  assert.ok(listHtml.includes('class="form-check-input rowCheck" value="8"'), '行里要有勾选框');
  assert.ok(listHtml.includes('action="/admin/notice_batch_delete"'), '批量表单要指向批量删除端点');
  assert.ok(listHtml.includes('data-unit="公告"'), '文案单位由页面下发, 否则确认框会说"删除 2 条笔记"');
  assert.ok(listHtml.includes('js/news_batch.js'), '要引入共用的批量勾选脚本');
  assert.ok(listHtml.includes('name="receiver" value="3"'), '接收人筛选要随批次带回');
  // 触底加载出来的行也要有勾选框, 否则翻页后的行根本选不了
  const fragment = await (await get('/admin/notice_rows?page=1', env, cookie)).json();
  assert.ok(String(fragment.rows).includes('rowCheck'), '分页片段里的行同样要能勾选');

  const res = await post('/admin/notice_batch_delete',
    { ids: '8,9', keyword: '维护', status: '1', receiver: '3', page: '2' }, env, cookie);
  assert.equal(res.status, 302);
  const location = res.headers.get('location') || '';
  assert.ok(location.includes(encodeURIComponent('已删除 2 条公告')), location);
  // 删完回到"当时的筛选 + 页码", 而不是把管理员扔回未筛选的第一页
  const query = new URL(`${location.startsWith('http') ? '' : 'https://admin.test'}${location}`).searchParams;
  assert.deepEqual(
    [query.get('keyword'), query.get('status'), query.get('receiver'), query.get('page')],
    ['维护', '1', '3', '2']);
  // 已读记录必须先清: 公告删了就再也查不出该清哪些 notice_id, 留下的孤儿行会让将来同 id 的新公告"没读却已读"
  const reads = findCall(state, /DELETE FROM app_notice_reads WHERE notice_id IN/i);
  assert.ok(reads, '要连带清掉这些公告的已读记录');
  assert.deepEqual(reads.args, [8, 9]);
  const deleted = findCall(state, /DELETE FROM app_notices WHERE id IN/i);
  assert.ok(deleted, '两条一起删');
  assert.deepEqual(deleted.args, [8, 9]);

  // 勾了之后被别人删掉的: 跳过并说明跳了几条 —— 不能谎报"已删除 3 条"
  const partial = await post('/admin/notice_batch_delete', { ids: '8,9,999' }, env, cookie);
  assert.equal(partial.status, 302);
  assert.ok((partial.headers.get('location') || '').includes(encodeURIComponent('另有 1 条已不存在已跳过')),
    partial.headers.get('location'));

  // 一条都没勾 / ids 是垃圾: 不落任何 DELETE
  const empty = await post('/admin/notice_batch_delete', { ids: '' }, env, cookie);
  assert.equal(empty.status, 302);
  assert.ok((empty.headers.get('location') || '').includes(encodeURIComponent('没有选中任何公告')));

  // 单条删除也必须清已读记录(2.6.1 起两个入口共用 purgeNotices): 否则同样留下孤儿行
  const single = await post('/admin/notice_delete', { id: '8' }, env, cookie);
  assert.equal(single.status, 302);
  const readPurges = state.calls.filter((call) => /DELETE FROM app_notice_reads WHERE notice_id IN \(/i.test(call.sql));
  assert.deepEqual(readPurges[readPurges.length - 1].args, [8], '单条删除走的是同一个 purgeNotices');

  // 全都不存在(比如列表页开着时别人清空了公告): 明确报错, 也不落 DELETE
  const gone = makeAdminEnv({ db: (sql, args, kind) => (kind === 'all' && /SELECT id FROM app_notices WHERE id IN/i.test(sql) ? [] : undefined) });
  const goneCookie = await loginCookie(gone.env);
  const allGone = await post('/admin/notice_batch_delete', { ids: '8' }, gone.env, goneCookie);
  assert.equal(allGone.status, 302);
  assert.ok((allGone.headers.get('location') || '').includes(encodeURIComponent('都已不存在')));
  assert.equal(findCall(gone.state, /DELETE FROM app_notices/i), null, '没有可删的就不该发 DELETE');
});

test('公告编辑(2.5.9): 非超管改正文不会把定向公告重置成「所有用户」', async () => {
  const { env, state } = makeAdminEnv({
    // 非超管: 本项目的超管口径是 role 为 super/admin, 所以这里用 normal
    role: 'normal',
    db: (sql, args, kind) => (kind === 'first' && /FROM app_notices WHERE id = \?/i.test(sql)
      ? Object.assign({}, NOTICE, { receiver_type: 3, target_user_ids: ',7,' }) : undefined)
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/notice_edit?id=8', env, cookie)).text();
  assert.ok(!html.includes('name="receiver_type"'), '接收人只给超管改');
  assert.ok(html.includes('接收人：指定用户'), '非超管也要看得到这条公告发给谁');

  const res = await post('/admin/notice_edit?id=8',
    { title: '改个标题', level: 'info', receiver_type: '0', status: '1' }, env, cookie);
  assert.equal(res.status, 302);
  const update = findCall(state, /UPDATE app_notices SET/i);
  assert.equal(update.args[9], 3, '提交里塞了 receiver_type=0 也要保留库里的 3');
  assert.equal(update.args[10], ',7,', '收件人也原样保留(非超管提交里根本没有这个字段)');
});

test('分类列表: 显示笔记数与首页引用, 并对未登记分类给黄框', async () => {
  const { env, state } = makeAdminEnv({
    rows: { app_categories: CATEGORY_ROWS },
    // 关联计数与"未登记分类"都取自同一条 GROUP BY(不再逐行子查询、也不再单独扫一遍 news), 所以桩按新形状喂数:
    // GROUP BY 的结果本身就是"news 里出现过的分类标识 + 各有多少篇", 空值也在里面
    db: (sql, args, kind) => {
      if (kind === 'first' && /COUNT\(\*\) AS c FROM app_categories/i.test(sql)) return { c: 2 };
      if (kind === 'all' && /FROM app_categories ORDER BY/i.test(sql)) return CATEGORY_ROWS;
      if (kind === 'all' && /GROUP BY category/i.test(sql)) {
        return [{ category: 'outdoor', total: 12 }, { category: 'legacy_x', total: 2 }, { category: '', total: 1 }];
      }
      if (kind === 'all' && /GROUP BY item_id/i.test(sql)) return [{ item_id: 'outdoor', total: 1 }];
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_category_manage', env, cookie)).text();
  assert.ok(html.includes('户外'));
  assert.ok(html.includes('>12<'), '显示笔记数');
  assert.ok(html.includes('发现 2 个未登记的分类'));
  assert.ok(html.includes('legacy_x') && html.includes('（空值）'));
  // 2.5.2: 未登记分类从那条 GROUP BY 里挑, 页面不该再为它单独扫一遍 news
  assert.equal(findCall(state, /NOT IN \(SELECT category_key/i), null, '不能再单独扫一遍 news');
});

test('分类编辑: 标识格式与占用都要拦下', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const bad = await post('/admin/app_category_edit?id=0', { category_key: 'Outdoor!', name: '户外' }, env, cookie);
  assert.ok((await bad.text()).includes('分类标识只能用小写字母开头'));
  const missing = await post('/admin/app_category_edit?id=0', { category_key: 'outdoor', name: '' }, env, cookie);
  assert.ok((await missing.text()).includes('请填写必填项: 名称'));
  assert.equal(findCall(state, /INSERT INTO app_categories/i), null);
});

test('分类编辑: 改标识但没勾迁移时给出提醒文案', async () => {
  const { env, state } = makeAdminEnv({ rows: { app_categories: CATEGORY_ROWS } });
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_category_edit?id=1', { category_key: 'outdoor2', name: '户外' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('旧标识「outdoor」下的笔记未迁移')));
  assert.ok(findCall(state, /UPDATE app_home_sections SET item_id/i), '改标识必须同步首页板块引用');
});

test('分类删除确认页: 摊开影响面并给迁移下拉', async () => {
  const { env } = makeAdminEnv({
    db: (sql, args, kind) => {
      if (kind === 'first' && /FROM app_categories WHERE id = \?/i.test(sql)) return CATEGORY_ROWS[0];
      if (kind === 'first' && /COUNT\(\*\) AS c FROM news/i.test(sql)) return { c: 12 };
      if (kind === 'first' && /COUNT\(\*\) AS c FROM app_home_sections/i.test(sql)) return { c: 1 };
      if (kind === 'all' && /FROM app_categories WHERE status=1/i.test(sql)) return [CATEGORY_ROWS[1]];
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_category_delete_confirm?id=1', env, cookie)).text();
  assert.ok(html.includes('即将删除分类「户外」'));
  assert.ok(html.includes('不迁移（笔记变成未归类）'));
  // 2.3.5: 迁移下拉与筛选标签一样只显示名称
  assert.ok(html.includes('>聚餐</option>') && !html.includes('聚餐（food）'));
  assert.ok(html.includes('引用该分类的首页入口'));
});

test('分类删除: 勾了迁移就回"已迁移"文案并改笔记归属', async () => {
  const { env, state } = makeAdminEnv({
    db: (sql, args, kind) => {
      if (kind === 'first' && /FROM app_categories WHERE id = \?/i.test(sql)) return CATEGORY_ROWS[0];
      if (kind === 'first' && /FROM app_categories WHERE category_key=\?/i.test(sql)) return CATEGORY_ROWS[1];
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_category_delete', { id: '1', move_to: 'food' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('已迁移到「food」')));
  const move = findCall(state, /UPDATE news SET category=\?/i);
  assert.deepEqual(move.args, ['food', 'outdoor']);
});

test('首页板块(合并后): 三块内容同一页, 筛选组走 ?section=, 精选项目用原首页精选的数据', async () => {
  const { env } = makeAdminEnv({
    rows: { app_home_sections: HOME_ROWS, app_featured_items: FEATURED_ROWS, app_categories: CATEGORY_ROWS }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_home_manage', env, cookie)).text();
  assert.ok(html.includes('主题项目'), 'section_key=main 要显示中文');
  assert.ok(html.includes('户外'), '分类名实时取自分类表');
  assert.ok(html.includes('https://media.test/news_uploads/home/hw.jpg'));

  // 默认「全部」: 三块各一张表, 顺序与筛选组一致(与留言管理页同一套按钮组)
  const bar = (html.match(/<div class="btn-group[\s\S]*?<\/div>/) || [''])[0];
  assert.match(bar, /^<div class="btn-group btn-group-sm" role="group" aria-label="按首页内容板块筛选">/);
  for (const label of ['全部', '主题项目', '拓展项目', '精选项目']) {
    assert.ok(bar.includes(`>${label}</a>`), `筛选组要有「${label}」`);
  }
  assert.match(html,
    /<h2 class="h6 mb-0">主题项目<\/h2>[\s\S]*<h2 class="h6 mb-0">拓展项目<\/h2>[\s\S]*<h2 class="h6 mb-0">精选项目<\/h2>/,
    '三块内容各一张表');
  // 精选项目 = 原「首页精选管理」的内容(表 app_featured_items; 2.3.8 起编辑入口也走合并后的 app_home_edit)
  assert.ok(html.includes('outdoor_sale') && html.includes('/admin/app_home_edit?id=9&amp;section=featured'));
  assert.ok(html.includes('kind=featured') && html.includes('kind=home_section'), '两类的删除确认入口都在');

  // 只看精选: 只渲染这一块, 选中态由 ?section= 决定(= 刷新/直链都能定位)
  const featured = await (await get('/admin/app_home_manage?section=featured', env, cookie)).text();
  assert.ok(featured.includes('outdoor_sale') && !featured.includes('hw.jpg'), '只显示精选项目');
  assert.match((featured.match(/<div class="btn-group[\s\S]*?<\/div>/) || [''])[0],
    /class="btn btn-outline-secondary active" href="\/admin\/app_home_manage\?section=featured"[^>]*aria-current="page">精选项目</);
  // 不带参数 = 全部, 且与留言页一样"全部"也带参数(?section=all)
  assert.match(bar, /class="btn btn-outline-secondary active" href="\/admin\/app_home_manage\?section=all"[^>]*aria-current="page">全部</);
});

test('首页精选(合并后): 新增/编辑/删除都回「首页板块管理」的精选项目视图', async () => {
  const { env, state } = makeAdminEnv({ rows: { app_featured_items: FEATURED_ROWS } });
  const cookie = await loginCookie(env);

  // 2.3.8: 精选的新增/编辑走合并后的 /admin/app_home_edit?section=featured
  const saved = await post('/admin/app_home_edit?id=0&section=featured',
    { item_key: 'outdoor_sale', name: '户外精选', image_url: 'image/a.png', page_path: '/pages/outdoor/outdoor' },
    env, cookie);
  assert.equal(saved.status, 302);
  assert.ok(saved.headers.get('location').startsWith('/admin/app_home_manage?'), '保存后回合并页');
  assert.ok(saved.headers.get('location').includes('section=featured'), '并停在精选项目这一块');
  assert.ok(findCall(state, /INSERT INTO app_featured_items/i));

  const deleted = await post('/admin/app_featured_delete', { id: '9' }, env, cookie);
  assert.equal(deleted.status, 302);
  assert.ok(deleted.headers.get('location').includes('section=featured'));
  assert.ok(findCall(state, /DELETE FROM app_featured_items/i));

  // 删除确认页的名称与返回地址都指向合并后的视图(否则删完回到已删掉的页面)
  const confirm = await (await get('/admin/delete_confirm?kind=featured&id=9', env, cookie)).text();
  assert.ok(confirm.includes('精选项目'));
  assert.ok(confirm.includes('/admin/app_home_manage?section=featured'));
});

test('首页板块编辑: 从某个板块的「添加入口」进来会预选那个板块', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_home_edit?id=0&section=ext', env, cookie)).text();
  assert.match(html, /<option value="ext" selected>/, '拓展项目的添加要预选拓展');
  assert.ok(html.includes('/admin/app_home_manage?section=ext'), '返回列表回到该板块视图');
});

test('首页板块编辑: 分类必须是启用中的分类', async () => {
  const { env, state } = makeAdminEnv({
    db: (sql, args, kind) => {
      if (kind === 'all' && /category_key FROM app_categories WHERE status=1/i.test(sql)) return [{ category_key: 'outdoor' }];
      if (kind === 'all' && /category_key, name(, status)? FROM app_categories/i.test(sql)) return CATEGORY_ROWS;
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_home_edit?id=0',
    { section_key: 'main', item_id: 'food', image_url: 'news_uploads/x.png' }, env, cookie);
  const html = await res.text();
  assert.ok(html.includes('请选择有效的分类（须为「分类管理」中已启用的分类）'));
  assert.equal(findCall(state, /INSERT INTO app_home_sections/i), null);
});

test('首页精选编辑: 标识格式与必填项按旧站文案拦住', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const bad = await post('/admin/app_home_edit?id=0&section=featured', { item_key: 'Bad-Key' }, env, cookie);
  assert.ok((await bad.text()).includes('标识格式不正确: 小写字母开头'));
  const noImage = await post('/admin/app_home_edit?id=0&section=featured',
    { item_key: 'outdoor_sale', name: '户外精选', page_path: '/pages/x' }, env, cookie);
  assert.ok((await noImage.text()).includes('请填写必填项: 图片地址'));
});

test('首页内容编辑页合并(2.3.8): ?section= 决定字段集, 两种类型字段都不丢且互不串改', async () => {
  const { env, state } = makeAdminEnv({
    rows: { app_home_sections: HOME_ROWS, app_featured_items: FEATURED_ROWS, app_categories: CATEGORY_ROWS },
    // 真库里 id=9 不在板块表、id=5 不在精选表 —— 按 id 过滤, 才能验证"不带 section 的老地址"
    db: (sql, args, kind) => {
      if (kind === 'first' && /FROM app_home_sections WHERE id = \?/i.test(sql)) {
        return Number(args[0]) === 5 ? HOME_ROWS[0] : null;
      }
      if (kind === 'first' && /FROM app_featured_items WHERE id = \?/i.test(sql)) {
        return Number(args[0]) === 9 ? FEATURED_ROWS[0] : null;
      }
      return undefined;
    }
  });
  const cookie = await loginCookie(env);

  // ① 板块入口(?section=main): 原有字段一个不少, 也不会冒出精选的字段
  const home = await (await get('/admin/app_home_edit?id=0&section=main', env, cookie)).text();
  for (const name of ['section_key', 'item_id', 'image_url', 'sort_order', 'status']) {
    assert.ok(home.includes(`name="${name}"`), `板块入口表单要有 ${name}`);
  }
  for (const name of ['item_key', 'page_path']) {
    assert.ok(!home.includes(`name="${name}"`), `板块入口表单不该有精选字段 ${name}`);
  }
  assert.ok(home.includes('添加入口</button>'), '主按钮文案照旧「添加入口」');
  assert.ok(home.includes('改为添加精选项目'), '新增时给一条"换成精选类型"的入口');

  // ② 精选(?section=featured): 标识/名称/图片/跳转页面/排序/启用, 没有板块与分类
  const featured = await (await get('/admin/app_home_edit?id=0&section=featured', env, cookie)).text();
  for (const name of ['item_key', 'name', 'image_url', 'page_path', 'sort_order', 'status']) {
    assert.ok(featured.includes(`name="${name}"`), `精选表单要有 ${name}`);
  }
  for (const name of ['section_key', 'item_id']) {
    assert.ok(!featured.includes(`name="${name}"`), `精选表单不该有板块入口字段 ${name}`);
  }
  assert.ok(featured.includes('添加精选</button>'), '主按钮文案照旧「添加精选」');
  assert.ok(featured.includes('改为添加板块入口'), '新增时给一条"换成板块入口类型"的入口');

  // ③ 编辑已有记录: 按 id + section 定位到正确的表; 老地址(?id= 不带 section)也照旧能开
  assert.ok((await (await get('/admin/app_home_edit?id=5&section=main', env, cookie)).text()).includes('value="outdoor"'),
    '板块入口那一行读到了');
  assert.ok((await (await get('/admin/app_home_edit?id=5', env, cookie)).text()).includes('name="item_id"'),
    '老地址也能编辑板块入口');
  assert.ok((await (await get('/admin/app_home_edit?id=9&section=featured', env, cookie)).text()).includes('value="outdoor_sale"'),
    '精选那一行读到了');
  assert.ok((await (await get('/admin/app_home_edit?id=9', env, cookie)).text()).includes('value="outdoor_sale"'),
    '老地址也能编辑精选(先在板块表找, 找不到再去精选表)');
  assert.ok((await (await get('/admin/app_home_edit?id=999', env, cookie)).text()).includes('找不到该配置项'),
    'id 不存在时给明确文案');

  // ④ 保存互不串改: 精选只写精选表, 板块入口只写板块入口表
  state.calls.length = 0;
  await post('/admin/app_home_edit?id=0&section=featured',
    { item_key: 'sale2', name: '新精选', image_url: 'image/b.png', page_path: '/pages/x' }, env, cookie);
  assert.ok(findCall(state, /INSERT INTO app_featured_items/i), '精选写入精选表');
  assert.equal(findCall(state, /INTO app_home_sections/i), null, '不该碰板块入口表');

  state.calls.length = 0;
  await post('/admin/app_home_edit?id=0&section=main',
    { section_key: 'main', item_id: 'outdoor', image_url: 'news_uploads/y.png' }, env, cookie);
  assert.ok(findCall(state, /INSERT INTO app_home_sections/i), '板块入口写入板块入口表');
  assert.equal(findCall(state, /INTO app_featured_items/i), null, '不该碰精选表');
});

test('通用删除确认页: kind 非法时回控制面板并带错误', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await get('/admin/delete_confirm?kind=not_exist&id=1', env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').startsWith('/admin/dashboard?error='));
});

test('通用删除确认页: 只删配置记录的提示与隐藏字段', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/delete_confirm?kind=banner&id=7&page=2', env, cookie)).text();
  assert.ok(html.includes('此操作不可恢复'));
  assert.ok(html.includes('确认彻底删除'));
  assert.ok(html.includes('name="id" value="7"'));
  assert.ok(html.includes('name="page" value="2"'));
  assert.ok(html.includes('素材保留策略'));
});
