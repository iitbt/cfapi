// 用户/管理员/留言/笔记/上传 端到端自检
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAdmin } from '../app/admin/index.js';
import { findCall, get, HOST, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

const USER_ROW = {
  id: 7, username: 'wx_abc', nickname: '老王', email: '', avatar: 'avatar_uploads/a.png',
  login_type: 'wechat', is_trusted: 0, test_applied: 0, status: 0, create_time: '2026-09-01 10:00:00',
  last_login_time: '2026-09-30 20:00:00', deleted_at: null, raw_nickname: '老王'
};
const NEWS_ROW = {
  id: 5, title: '重走来时路', desc: '摘要', category: 'outdoor', image: 'news_uploads/a.png',
  publish_time: '2026-10-01 09:00:00', status: 'approved', type: 'admin_users',
  view_count: 3, likes: 2, favorites: 1, content: '<p>正文</p>', video_url: '', activity_time: ''
};

test('用户列表: 搜索与内部测试筛选进 SQL, 昵称直读库字段', async () => {
  const { env, state } = makeAdminEnv({ rows: { users: [USER_ROW] }, counts: { users: 1 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/users?search=王&trusted=untrusted', env, cookie)).text();
  assert.ok(html.includes('老王'));
  assert.ok(html.includes('https://media.test/avatar_uploads/a.png'), '头像要拼绝对地址');
  assert.ok(html.includes('普通'), '类型徽章');
  const count = findCall(state, /COUNT\(\*\) AS total FROM users/i);
  assert.ok(/username LIKE \?/.test(count.sql) && /is_trusted = 0/.test(count.sql));
});

test('用户列表(4.4.7): 已申请的用户显示「已申请」徽章, 也能按「仅已申请」筛出来', async () => {
  const applied = Object.assign({}, USER_ROW, { test_applied: 1 });
  const { env, state } = makeAdminEnv({
    rows: { users: [applied, USER_ROW, Object.assign({}, USER_ROW, { id: 8, is_trusted: 1, test_applied: 1 })] },
    counts: { users: 3 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/users', env, cookie)).text();
  assert.ok(html.includes('普通') && html.includes('微信'), '类型列照旧拼「普通 微信」');
  assert.ok(html.includes('<span class="badge text-bg-warning">已申请</span>'), '已申请要有徽章');
  // 已是内部测试的用户即便残留申请标记也不显示「已申请」(管理员处理过就该回到「内部测试 微信」)
  assert.equal((html.match(/已申请<\/span>/g) || []).length, 1, '只给"待处理"的那一条打徽章');

  const filtered = await (await get('/admin/users?trusted=applied', env, cookie)).text();
  assert.ok(filtered.includes('>仅已申请<'), '筛选下拉要有这一项');
  // 取**最后一次**用户表计数: 前面那次未筛选的 GET 也在 state.calls 里
  const counts = state.calls.filter((call) => /COUNT\(\*\) AS total FROM users/i.test(call.sql));
  const last = counts[counts.length - 1];
  assert.ok(last && /test_applied = 1 AND is_trusted = 0/.test(last.sql), '「仅已申请」要真的进 SQL');
});

test('用户列表: 非超管看不到敏感操作按钮', async () => {
  const { env } = makeAdminEnv({ role: 'normal', rows: { users: [USER_ROW] }, counts: { users: 1 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/users', env, cookie)).text();
  assert.ok(html.includes('详情'));
  assert.ok(!html.includes('设为内部测试'));
  assert.ok(!html.includes('>删除<'));
});

test('用户写操作: 设为内部测试 / 删除用户(级联) / 恢复账号', async () => {
  const { env, state } = makeAdminEnv({ db: (sql, args, kind) => (kind === 'first' && /FROM users WHERE id = \?/i.test(sql) ? USER_ROW : undefined) });
  const cookie = await loginCookie(env);

  const trusted = await post('/admin/users', { action: 'set_trusted', user_id: '7' }, env, cookie);
  assert.equal(trusted.status, 302);
  assert.ok(trusted.headers.get('location').includes(encodeURIComponent('已成功设置为内部测试用户')));
  // 4.4.7: 设为内部测试的同时清掉申请标记(申请已处理, 列表不再显示「已申请」)
  const setTrusted = findCall(state, /UPDATE users SET is_trusted = 1/i);
  assert.ok(/test_applied = 0/.test(setTrusted.sql), setTrusted.sql);

  // 列表里的两个按钮都要能提交, 且先弹确认(超管才看得到)
  const listEnv = makeAdminEnv({ rows: { users: [USER_ROW] }, counts: { users: 1 } });
  const listCookie = await loginCookie(listEnv.env);
  const listHtml = await (await get('/admin/users', listEnv.env, listCookie)).text();
  assert.ok(listHtml.includes('name="action" value="set_trusted"'), '按钮要把 action 提交上去');
  assert.ok(listHtml.includes('onclick="return confirm('), '设为/取消内部测试都要先确认');
  assert.ok(listHtml.includes('设为内部测试用户？设置后可查看专题视频'), '确认文案要写清权限范围');

  const restored = await post('/admin/users', { action: 'restore_user', user_id: '7' }, env, cookie);
  assert.ok(restored.headers.get('location').includes(encodeURIComponent('账号已恢复')));
  const restoreSql = findCall(state, /UPDATE users SET status=0, nickname=\?/i);
  assert.ok(restoreSql, '恢复要重算昵称');
  assert.ok(!/deleted_at/.test(restoreSql.sql), '恢复时 deleted_at 必须保留(后台据此显示"已恢复")');
  assert.ok(String(restoreSql.args[0]).endsWith('(已恢复)'), restoreSql.args[0]);

  const removed = await post('/admin/users', { action: 'delete_user', user_id: '7' }, env, cookie);
  assert.ok(removed.headers.get('location').includes(encodeURIComponent('已全部删除')));
});

test('设/取消内部测试: 给本人发一条定向公告(覆盖式, 同一用户只留最新一条)', async () => {
  const { env, state } = makeAdminEnv({
    db: (sql, args, kind) => (kind === 'first' && /FROM users WHERE id = \?/i.test(sql) ? USER_ROW : undefined)
  });
  const cookie = await loginCookie(env);

  const setRes = await post('/admin/users', { action: 'set_trusted', user_id: '7' }, env, cookie);
  assert.equal(setRes.status, 302, '发公告失败也不能把身份变更报成失败');
  // 先清旧的那条(连它的已读行) —— 否则"已通过"与"已取消"会同时躺在公告页里
  assert.ok(findCall(state, /DELETE FROM app_notice_reads WHERE notice_id IN \(SELECT id FROM app_notices WHERE target_user_id=\?\)/i),
    '要一并清掉旧定向消息的已读行(不然新消息的红点会被旧 id 的已读盖住)');
  assert.ok(findCall(state, /DELETE FROM app_notices WHERE target_user_id=\?/i), '同一用户只保留最新一条');
  const insert = findCall(state, /INSERT INTO app_notices/i);
  assert.ok(insert, '要插入一条定向公告');
  assert.match(insert.sql, /target_user_id/, '公告必须带上收件人');
  assert.equal(insert.args[3], 7, '收件人 = 被操作的用户');
  assert.equal(insert.args[2], 'important', '身份变更属于重要消息');
  assert.ok(String(insert.args[0]).includes('内部测试申请已通过'), insert.args[0]);

  // 取消内部测试 → 同样发一条(覆盖掉上一条)
  const removeRes = await post('/admin/users', { action: 'remove_trusted', user_id: '7' }, env, cookie);
  assert.equal(removeRes.status, 302);
  const inserts = state.calls.filter((call) => /INSERT INTO app_notices/i.test(call.sql));
  assert.equal(inserts.length, 2, '两次操作各发一条');
  assert.ok(String(inserts[1].args[0]).includes('内部测试已取消'), inserts[1].args[0]);
});

test('用户详情: 缺 id 时给出明确文案', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/user_detail', env, cookie)).text();
  assert.ok(html.includes('缺少有效的用户ID参数'));
});

test('管理员列表: 内置超管不显示重置/删除按钮', async () => {
  const { env } = makeAdminEnv({
    rows: { admin_users: [{ id: 1, username: 'admin', nickname: '管理员', email: '' }] },
    counts: { admin_users: 1 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/admin_users', env, cookie)).text();
  assert.ok(html.includes('超管'));
  assert.ok(html.includes('内置账户'));
  assert.ok(!html.includes('重置口令'));
});

test('管理员: 重置口令成功时就地渲染(口令绝不进 URL)', async () => {
  const { env } = makeAdminEnv({
    db: (sql, args, kind) => (kind === 'first' && /FROM admin_users WHERE id = \?/i.test(sql)
      ? { id: 2, username: 'helper' } : undefined)
  });
  const cookie = await loginCookie(env);
  const res = await post('/admin/admin_users', { reset_admin_password: '1', admin_id: '2' }, env, cookie);
  assert.equal(res.status, 200, '不能 302 —— 口令会落进访问日志');
  const html = await res.text();
  assert.ok(html.includes('新密码仅本次显示'));
});

test('管理员: 新增时两次口令不一致被拒', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/admin_users',
    { add_admin: '1', username: 'newbie', password: 'password-1234', confirm_password: 'password-9999' }, env, cookie);
  assert.ok((await res.text()).includes('两次输入的密码不一致'));
  assert.equal(findCall(state, /INSERT INTO admin_users/i), null);
});

test('留言: 删除是物理删除且文案写明不可恢复', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/comments_manage', { action: 'delete', id: '9' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').includes(encodeURIComponent('留言已删除（不可恢复）')));
  assert.ok(findCall(state, /DELETE FROM news_comments WHERE id = \?/i));
});

test('笔记列表: 复选框列 + 批量区 + 回收站入口', async () => {
  const { env } = makeAdminEnv({ rows: { news: [NEWS_ROW] }, counts: { news: 1 }, rows2: {} });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_manage', env, cookie)).text();
  assert.ok(html.includes('rowCheck'));
  // 表头复选框必须是真控件: 曾经被 listShell 转义, 页面上显示成一段源码文本
  assert.ok(html.includes('<th scope="col"><input type="checkbox" id="rowCheckAll" aria-label="全选"></th>'));
  assert.ok(!html.includes('&lt;input'), '列表页不应出现被转义的 input 源码');
  assert.ok(html.includes('batchForm'));
  assert.ok(html.includes('回收站'));
  assert.ok(html.includes('设为显示'));
});

/** 取页面上的筛选组(与留言管理页同一套 .btn-group) */
function filterBar(html) {
  return (html.match(/<div class="btn-group[\s\S]*?<\/div>/) || [''])[0];
}

/** 给每条 D1 查询加 15ms 延迟并统计"同时在飞"的峰值: 顺序实现峰值恒为 1 */
function withDelay(env) {
  const stats = { calls: 0, inFlight: 0, peak: 0 };
  const original = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const stmt = original(sql);
    const wrap = (fn) => async (...args) => {
      stats.calls += 1;
      stats.inFlight += 1;
      stats.peak = Math.max(stats.peak, stats.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      try { return await fn(...args); } finally { stats.inFlight -= 1; }
    };
    stmt.all = wrap(stmt.all.bind(stmt));
    stmt.first = wrap(stmt.first.bind(stmt));
    return stmt;
  };
  return stats;
}

test('笔记列表(2.4.1): 去掉「跳至 N 页 / 跳转」, 只留滚动加载 + 回到顶部', async () => {
  // 25 条 / 每页 10 → 3 页, 哨兵才渲染成"滚动到底自动加载更多"(单页时是"已全部加载")
  const { env } = makeAdminEnv({ rows: { news: [NEWS_ROW] }, counts: { news: 25 }, rows2: {} });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_manage', env, cookie)).text();
  assert.ok(!html.includes('id="newsJumpBtn"') && !html.includes('id="newsJumpInput"'), '跳页控件已删');
  assert.ok(!html.includes('跳至') && !html.includes('>跳转<'), '页面上不该再有跳页文案');
  assert.ok(html.includes('id="newsBackTopBtn"') && html.includes('回到顶部'), '回到顶部保留');
  assert.ok(html.includes('id="newsLoadMore"') && html.includes('滚动到底自动加载更多'), '滚动加载照旧');
  // 跳页只是少了下发元素 id: 加载器与行片段端点都不受影响(分页逻辑本身没动)
  assert.ok(html.includes('"rowsUrl":"/admin/news_manage_rows"'));
  assert.ok(!html.includes('jumpBtnId'), 'pagerScript 也不该再下发跳页 id');
  // 其它列表页仍保留跳页(本次只改笔记管理页与素材库页)
  const banners = await (await get('/admin/banner_manage', env, cookie)).text();
  assert.ok(banners.includes('id="bannerJumpBtn"') && banners.includes('跳至'), '其它页不受影响');
});

test('笔记列表: 三条查询并发发出(依赖链 3 次 D1 往返 → 1 次), 标题列固定宽度', async () => {
  const { env, state } = makeAdminEnv({
    rows: {
      news: [Object.assign({}, NEWS_ROW, { title: '很长很长的标题'.repeat(12) })],
      app_categories: [{ category_key: 'outdoor', name: '户外', status: 1, sort_order: 1 }]
    },
    counts: { news: 1 }
  });
  const cookie = await loginCookie(env);
  const stats = withDelay(env);
  state.calls.length = 0;
  const html = await (await get('/admin/news_manage', env, cookie)).text();

  assert.ok(state.calls.length >= 3, `列表页要发 3 条查询(总数/列表/分类), 实际 ${state.calls.length}`);
  // 只看"同时在飞的峰值": 顺序实现峰值恒为 1, 并发才会 >1 —— 这是与机器负载无关的判据。
  // (原来还断言了 wall-clock 耗时, 但整套测试并发跑时 setTimeout 会被拖长, 会偶发误报, 已去掉)
  assert.ok(stats.peak >= 2, `查询要并发发出(依赖链只留 1 次往返), 实际峰值 ${stats.peak}`);

  // 标题列: 固定宽度容器 + 单行省略号, 整串标题放进 title 便于悬停查看
  const long = '很长很长的标题'.repeat(12);
  assert.match(html, /<td class="cell-title">\s*<div class="text-truncate" title="[^"]+">/);
  assert.ok(html.includes(`title="${long}"`), '超长标题要整串放进 title 提示');
});


test('笔记筛选: 分类改成 URL 参数 ?category= 的筛选条, 选中态/过滤/表单带回都对', async () => {
  const { env, state } = makeAdminEnv({
    rows: {
      news: [NEWS_ROW],
      app_categories: [
        { category_key: 'outdoor', name: '户外', status: 1, sort_order: 1 },
        { category_key: 'swim', name: '游泳', status: 1, sort_order: 2 }
      ]
    },
    counts: { news: 1 }
  });
  const cookie = await loginCookie(env);

  // 直链/刷新: 参数决定选中态, 选项来自库里的 app_categories
  const html = await (await get('/admin/news_manage?category=outdoor', env, cookie)).text();
  const bar = filterBar(html);
  assert.ok(bar.includes('>全部分类</a>'));
  // 2.3.5: 标签只显示名称, 不再「名称（标识）」
  assert.ok(bar.includes('>户外</a>') && bar.includes('>游泳</a>'), '分类项来自 app_categories, 只显示名称');
  assert.ok(!bar.includes('（outdoor）') && !bar.includes('（swim）'), '标签里不再出现分类标识');
  assert.match(bar, /class="btn btn-outline-secondary active"[^>]*href="\/admin\/news_manage\?category=outdoor"[^>]*aria-current="page">户外</);
  // 过滤是真的进了 SQL(不是只在页面上高亮)
  assert.ok(state.calls.some((call) => /category = \?/i.test(call.sql) && call.args.includes('outdoor')),
    '列表 SQL 要按 category 过滤');
  // 分类从下拉挪到按钮组后, 状态/关键词表单要把它带过去
  assert.ok(html.includes('<input type="hidden" name="category" value="outdoor">'));

  // 不带参数与 ?category=all 都等价于"全部分类"(后者的选中态也要正确)
  for (const path of ['/admin/news_manage', '/admin/news_manage?category=all']) {
    const all = await (await get(path, env, cookie)).text();
    assert.match(filterBar(all),
      /class="btn btn-outline-secondary active" href="\/admin\/news_manage\?category=all"[^>]*aria-current="page">全部分类</,
      `${path} 应选中「全部分类」`);
  }
});

test('分类显示(2.3.5): 标签条/列表列/表单下拉都只显示名称, 标识只留在 URL 参数与取值里', async () => {
  const { env } = makeAdminEnv({
    rows: {
      news: [
        Object.assign({}, NEWS_ROW, { id: 1, category: 'outdoor' }),
        Object.assign({}, NEWS_ROW, { id: 2, category: 'gone', deleted_at: '2026-10-01 10:00:00' })
      ],
      app_categories: [
        { category_key: 'outdoor', name: '户外', status: 1, sort_order: 1 },
        { category_key: 'swim', name: '游泳', status: 1, sort_order: 2 }
      ]
    },
    counts: { news: 1 }
  });
  const cookie = await loginCookie(env);

  // ① 分类标签条(URL 参数切换的那个): 只显示名称, 取值仍是标识
  const list = await (await get('/admin/news_manage?category=outdoor', env, cookie)).text();
  const bar = filterBar(list);
  assert.ok(bar.includes('>户外</a>') && !bar.includes('（outdoor）'), '标签只显示名称');
  assert.ok(bar.includes('href="/admin/news_manage?category=outdoor"'), 'URL 参数与选址态不变(仍是标识)');

  // ② 列表「分类」列: 显示名称; 已删除/未登记的标识按 nameFor 回退成标识本身(便于发现脏数据)
  const categoryCells = list.match(/<td class="text-nowrap">([^<]*)<\/td>/g) || [];
  assert.ok(categoryCells.some((cell) => cell.includes('>户外<')), '列表分类列显示中文名称');
  assert.ok(!/>outdoor</.test(list.replace(/category=outdoor/g, '')), '列表里不再直接显示标识 outdoor');

  // ③ 编辑页的分类下拉(表单选项): 文案只显示名称
  const edit = await (await get('/admin/news_edit?id=1', env, cookie)).text();
  assert.ok(edit.includes('<option value="outdoor" selected>户外</option>'), '下拉只显示名称且选中当前值');
  assert.ok(!edit.includes('户外（outdoor）'), '下拉不再带标识');

  // ④ 回收站「分类」列: 同样显示名称
  const recycle = await (await get('/admin/news_recycle', env, cookie)).text();
  assert.ok(recycle.includes('>户外<'), '回收站分类列也显示名称');

  // ⑤ 删除分类时的「迁移到」下拉: 与 categorySource 同一口径(只显示名称)
  const confirm = await (await get('/admin/app_category_delete_confirm?id=1', env, cookie)).text();
  assert.ok(confirm.includes('<option value="swim">游泳</option>'), '迁移目标下拉只显示名称');
});

test('笔记预览: 结构/类名与旧站 news_preview 一致, 分类显示中文, 不 +1 浏览量', async () => {
  const { env, state } = makeAdminEnv({
    rows: {
      news: [Object.assign({}, NEWS_ROW, {
        video_url: 'video/v1.mp4', content: '<p>正文</p><img src="image/a.png" alt="">'
      })],
      app_categories: [{ category_key: 'outdoor', name: '户外' }]
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_preview?id=5', env, cookie)).text();

  // 与旧站 templates/news_preview.html 同结构: 800px 手机框 + 卡片 + 元信息 + 两个居中返回按钮
  for (const cls of ['mp-preview mp-frame', 'mp-frame-hint', 'mp-cover', 'mp-card', 'mp-title',
    'mp-meta', 'mp-chip', 'mp-author', 'mp-video', 'news-content', 'page-actions-center']) {
    assert.ok(html.includes(cls), `预览页缺少 .${cls.split(' ')[0]}`);
  }
  assert.ok(html.includes('小程序笔记详情页预览（800px 宽，与编辑区一致）'));
  assert.ok(html.includes('封面图（列表页展示）'), '封面要有标注');
  assert.ok(html.includes('副标题（列表页展示）'), '摘要要有标注');
  assert.ok(html.includes('<span class="mp-chip">户外</span>'), '分类要显示中文(不是 outdoor)');
  assert.ok(html.includes('<span class="mp-author">管理员</span>'));
  // 主视频 + 正文里的视频都转成浏览器可播的 <video>(绝对地址)
  assert.ok(html.includes('/video/v1.mp4'), '主视频地址要绝对化');
  assert.ok(html.includes('<i class="bi bi-eye" aria-hidden="true"></i> 3'), '统计: 浏览');
  assert.ok(html.includes('返回编辑') && html.includes('返回列表'));
  // 预览是只读的: 不许给前台浏览量 +1(旧站口径)
  assert.ok(!state.calls.some((call) => /UPDATE news SET view_count/i.test(call.sql)), '预览不该改浏览量');
});

test('笔记预览(2.4.0): 正文与封面都直接用原图, 不再换成 800px 缩略图', async () => {
  const asked = [];
  const { env } = makeAdminEnv({
    rows: { news: [Object.assign({}, NEWS_ROW, { content: '<p>正文</p><img src="image/a.png" alt="">' })] },
    // 就算桶里"有"缩略图也不该被用/被探测(规则已移除)
    mediaHead: (key) => { asked.push(key); return { key }; }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_preview?id=5', env, cookie)).text();
  assert.ok(html.includes('https://media.test/image/a.png'), '正文配图用原图');
  assert.ok(html.includes('https://media.test/news_uploads/a.png'), '封面用原图');
  assert.ok(!html.includes('_thumb'), '预览页不该出现任何缩略图地址');
});

test('笔记编辑: 与旧站同布局(单列 mp-frame + 发布设置卡 + 数据统计卡)', async () => {
  const { env } = makeAdminEnv({
    rows: { news: [NEWS_ROW], app_categories: [{ category_key: 'outdoor', name: '户外' }] }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_edit?id=5', env, cookie)).text();
  assert.ok(html.includes('<div class="row g-3 justify-content-center">'), '单列居中(旧站 news_edit 布局)');
  assert.ok(html.includes('col-lg-8 mp-frame'), '主列取 800px 小程序尺度');
  assert.ok(html.includes('<div class="form-label">发布设置</div>'), '发布设置收在一张卡里');
  assert.ok(html.includes('数据统计：浏览 3 ｜ 点赞 2 ｜ 收藏 1'), '编辑已有笔记要显示统计卡');
  assert.ok(html.includes('name="status"') && html.includes('name="publish_time"') && html.includes('name="activity_time"'));
  // 新建页没有统计卡(与旧站一致)
  const fresh = await (await get('/admin/news_edit?id=0', env, cookie)).text();
  assert.ok(!fresh.includes('数据统计：浏览'), '新建页不该有统计卡');
  // 字段顺序: 标题 → 分类 → 封面 → 视频地址 → 摘要 → 正文
  const order = ['name="title"', 'name="category"', 'name="image"', 'name="video_url"', 'name="desc"', 'id="contentRaw"']
    .map((needle) => html.indexOf(needle));
  assert.ok(order.every((at) => at > 0), '六个字段都要在页面上');
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), '字段顺序要与旧站一致');
});

test('列表页: 三个带状态筛选的页面都声明了就地隐藏用的属性', async () => {
  const { env } = makeAdminEnv({
    rows: { news: [NEWS_ROW], news_comments: [], app_notices: [] }, counts: { news: 1, news_comments: 0, app_notices: 0 }
  });
  const cookie = await loginCookie(env);
  for (const path of ['/admin/news_manage', '/admin/comments_manage', '/admin/notice_manage']) {
    const html = await (await get(path, env, cookie)).text();
    assert.ok(html.includes('data-status-filter-param="status"'), `${path} 要声明状态筛选参数`);
  }
});

test('笔记编辑: 必填项合并成一句, 正文视频转成 wx-video 且摘要自动截取', async () => {
  // 分类下拉来自 app_categories: 不给数据会被"分类无效"拦下(校验是对的)
  const { env, state } = makeAdminEnv({
    rows: { app_categories: [{ category_key: 'outdoor', name: '户外', status: 1 }] }
  });
  const cookie = await loginCookie(env);
  const missing = await post('/admin/news_edit?id=0', { title: '标题' }, env, cookie);
  assert.ok((await missing.text()).includes('请填写必填项: 分类、封面图、正文内容'));

  const stored = await post('/admin/news_edit?id=0', {
    title: '带视频的笔记', category: 'outdoor', image: 'news_uploads/a.png',
    content: '<p>正文</p><div data-w-e-type="video"><video><source src="/news_uploads/video_1.mp4" type="video/mp4"></video></div>',
    status: '1', publish_time: '2026-10-05T10:30'
  }, env, cookie);
  assert.equal(stored.status, 302);
  const insert = findCall(state, /INSERT INTO news/i);
  assert.ok(insert.args[2].includes('<wx-video src="news_uploads/video_1.mp4"'), '视频要还原成库内格式');
  assert.ok(insert.args[2].includes('object-fit="cover"'));
  assert.equal(insert.args[1], '正文', '摘要留空时自动截取正文');
  assert.equal(insert.args[6], 'approved');
  assert.equal(insert.args[7], '2026-10-05 10:30:00', 'datetime-local 的 T 要归一');
});

test('笔记编辑: 新目录素材(image//video/)进出库都还原成相对记录值', async () => {
  const { env, state } = makeAdminEnv({
    rows: { app_categories: [{ category_key: 'outdoor', name: '户外', status: 1 }] }
  });
  const cookie = await loginCookie(env);
  // 编辑器交上来的是站点根路径(编辑页在 /admin/ 下, 相对地址会解析错), 图片与视频都要还原成相对值
  const stored = await post('/admin/news_edit?id=0', {
    title: '新目录素材', category: 'outdoor', image: '/image/cover.png',
    content: '<p>正文</p><img src="/image/a.png"><video src="/video/v.mp4" controls></video>',
    status: '1', publish_time: '2026-10-06T09:00'
  }, env, cookie);
  assert.equal(stored.status, 302);
  const insert = findCall(state, /INSERT INTO news/i);
  assert.ok(insert.args[2].includes('<img src="image/a.png">'), '图片要还原成 image/ 相对值');
  assert.ok(insert.args[2].includes('<wx-video src="video/v.mp4"'), '视频要还原成 video/ 相对值');
  assert.ok(!insert.args[2].includes('"/image/'), '入库不该留前导斜杠');
  // 封面/视频地址是单值字段, 与旧站一致只做去空白(不做路径归一): 素材库与上传给的本来就是相对值
  assert.equal(insert.args[4], '/image/cover.png');
});

test('笔记删除与复制: 文案与幂等键', async () => {
  const { env, state } = makeAdminEnv({
    db: (sql, args, kind) => {
      if (kind === 'first' && /SELECT title FROM news/i.test(sql)) return { title: '老笔记' };
      if (kind === 'first' && /SELECT \* FROM news/i.test(sql)) return NEWS_ROW;
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const removed = await post('/admin/news_delete', { id: '5' }, env, cookie);
  assert.ok(removed.headers.get('location').includes(encodeURIComponent('已移入回收站')));
  const update = findCall(state, /UPDATE news SET deleted_at=\?/i);
  assert.ok(update, '软删除只标记 deleted_at');

  const copied = await post('/admin/news_copy', { id: '5' }, env, cookie);
  assert.ok(copied.headers.get('location').includes(encodeURIComponent('新ID: 42')));
  const insert = findCall(state, /INSERT INTO news/i);
  assert.ok(String(insert.args[0]).endsWith(' (副本)'));
  assert.ok(insert.sql.includes("'pending'"), '副本一律待审核');
});

test('笔记回收站: 恢复与彻底删除(级联清子表)', async () => {
  const { env, state } = makeAdminEnv({
    db: (sql, args, kind) => (kind === 'first' && /SELECT title FROM news/i.test(sql) ? { title: '老笔记' } : undefined)
  });
  const cookie = await loginCookie(env);
  const restored = await post('/admin/news_restore', { id: '5' }, env, cookie);
  assert.ok(restored.headers.get('location').includes(encodeURIComponent('已恢复')));
  assert.ok(findCall(state, /UPDATE news SET deleted_at=NULL/i));

  const purged = await post('/admin/news_purge', { id: '5' }, env, cookie);
  assert.ok(purged.headers.get('location').includes(encodeURIComponent('已彻底删除')));
  assert.ok(findCall(state, /DELETE FROM news_likes WHERE news_id IN/i), '级联清子表');
  assert.ok(findCall(state, /DELETE FROM news WHERE id IN/i));
});

test('上传: 内容嗅探拦掉伪装的图片, 通过后写 R2 并回相对地址', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);

  const fakeForm = new FormData();
  fakeForm.append('purpose', 'cover');
  fakeForm.append('file', new File([new TextEncoder().encode('这不是图片')], 'x.png', { type: 'image/png' }));
  const rejected = await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
    method: 'POST', headers: { cookie }, body: fakeForm
  }), env);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.success, false);
  assert.ok(rejectedBody.message.includes('不是有效图片'));

  const realForm = new FormData();
  realForm.append('purpose', 'cover');
  // PNG 魔数 + 少量填充
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  realForm.append('file', new File([png], 'cover.png', { type: 'image/png' }));
  const okRes = await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
    method: 'POST', headers: { cookie }, body: realForm
  }), env);
  const okBody = await okRes.json();
  assert.equal(okBody.success, true);
  assert.match(okBody.url, /^image\/cover_\d+\.png$/, '图片素材落 image/ 目录');
  assert.equal(state.puts.length, 1);
});

test('上传: 视频素材落 video/ 目录, 图片目录不混进视频', async () => {
  const { env, state } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const form = new FormData();
  form.append('purpose', 'video');
  // ISO-BMFF: ftyp 品牌
  const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  form.append('file', new File([mp4], 'video_x.mp4', { type: 'video/mp4' }));
  const body = await (await handleAdmin(new Request(`${HOST}/admin/image_upload`, {
    method: 'POST', headers: { cookie }, body: form
  }), env)).json();
  assert.equal(body.success, true);
  assert.match(body.url, /^video\/video_\d+\.mp4$/, '视频素材落 video/ 目录');
  assert.deepEqual(state.puts, [body.url]);
});

test('素材库: 新目录与历史目录一起列, 头像/异类不混进来(2.4.0 起历史缩略图也照列)', async () => {
  const { env } = makeAdminEnv({
    mediaObjects: [
      { key: 'image/new.png', size: 30, uploaded: '2026-10-05T00:00:00Z' },
      { key: 'news_uploads/a.png', size: 10, uploaded: '2026-10-01T00:00:00Z' },
      { key: 'video/new.mp4', size: 40, uploaded: '2026-10-05T00:00:00Z' },
      { key: 'news_uploads/moto.mp4', size: 20, uploaded: '2026-10-02T00:00:00Z' },
      { key: 'news_uploads/_thumb/480/a.webp', size: 5, uploaded: '2026-10-01T00:00:00Z' },
      { key: 'avatar/avatar_7_1.png', size: 7, uploaded: '2026-10-03T00:00:00Z' }
    ]
  });
  const cookie = await loginCookie(env);
  const images = await (await get('/admin/media_library?kind=image', env, cookie)).json();
  assert.equal(images.success, true);
  // 2.4.0: 缩略图规则移除后, 桶里历史遗留的 _thumb 对象就是普通素材(出现在清单里才能被清理)
  // 排序: 时间倒序, 同时间按名字(`_` 比字母小, 所以 _thumb 那条排在 a.png 前)
  assert.deepEqual(images.items.map((item) => item.name), ['new.png', '_thumb/480/a.webp', 'a.png'],
    '新目录在前(按时间倒序)、历史缩略图照列、视频不混进图片、头像不参与素材库');
  // 前端靠这两个字段画预览与目录徽章, 缺了会"列表里没有图"
  assert.deepEqual(images.items.map((item) => item.kind), ['image', 'image', 'image']);
  assert.deepEqual(images.items.map((item) => item.dir), ['image', 'news_uploads', 'news_uploads'],
    '历史缩略图那一条的目录仍是 news_uploads(它就是一个普通对象)');
  assert.ok(images.accept.includes('png'));

  const videos = await (await get('/admin/media_videos', env, cookie)).json();
  assert.deepEqual(videos.items.map((item) => item.name), ['new.mp4', 'moto.mp4']);
  assert.deepEqual(videos.items.map((item) => item.dir), ['video', 'news_uploads']);
});

const RECYCLE_ROW = {
  id: 5, title: '老笔记', category: 'outdoor', image: '', status: 'approved', type: 'admin_users',
  publish_time: '2026-01-01 09:00:00', deleted_at: '2026-01-01 09:00:00'
};

test('回收站: 打开页面不再删任何东西(到期清理已从 GET 挪走)', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', rows: { news: [RECYCLE_ROW] }, counts: { news: 1 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_recycle', env, cookie)).text();
  assert.ok(html.includes('清理到期记录'), '超管在回收站能看到手工清理入口');
  // 子表 DELETE 只有 cleanupNews 会发: GET 页面出现它就说明"打开页面就删数据"又回来了
  assert.equal(findCall(state, /DELETE FROM news_likes/i), null, 'GET 回收站不许有物理删除');
});

test('回收站: 到期清理只认超管 POST + 确认标记, 并写审计', async () => {
  const normal = makeAdminEnv({ role: 'normal', rows: { news: [RECYCLE_ROW] }, counts: { news: 1 } });
  const normalCookie = await loginCookie(normal.env);
  const denied = await post('/admin/news_purge_expired', { confirm: '1' }, normal.env, normalCookie);
  assert.equal(denied.status, 403, '普通管理员不能批量删数据');

  const { env, state } = makeAdminEnv({ role: 'super', rows: { news: [RECYCLE_ROW] }, counts: { news: 1 } });
  const cookie = await loginCookie(env);
  const noConfirm = await post('/admin/news_purge_expired', {}, env, cookie);
  assert.ok(decodeURIComponent(String(noConfirm.headers.get('location')).replace(/\+/g, ' ')).includes('缺少确认标记'));
  assert.equal(findCall(state, /DELETE FROM news_likes/i), null, '没确认就不许删');

  const done = await post('/admin/news_purge_expired', { confirm: '1' }, env, cookie);
  assert.equal(done.status, 302);
  assert.ok(String(done.headers.get('location')).includes(encodeURIComponent('已清理 1 条')), '回报清理条数');
  assert.ok(findCall(state, /DELETE FROM news_likes/i), '确认后才真正连带子表删除');
  assert.ok(findCall(state, /SELECT id FROM news WHERE deleted_at IS NOT NULL/i), '先挑出超过保留期的记录');
});

test('删除确认页: 用户 kind 摊开级联影响面', async () => {
  const { env } = makeAdminEnv({
    db: (sql, args, kind) => (kind === 'all' && /FROM news WHERE user_id=\?/i.test(sql)
      ? [{ label: '发布的笔记', c: 3 }, { label: '点赞记录', c: 5 }] : undefined)
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/delete_confirm?kind=user&id=7', env, cookie)).text();
  assert.ok(html.includes('用户 #7'));
  assert.ok(html.includes('发布的笔记'));
  assert.ok(html.includes('8 条关联数据'), '3 + 5 合计');
  assert.ok(html.includes('name="delete_user" value="1"'));
  assert.ok(html.includes('name="user_id" value="7"'));
});

test('列表分页(2.3.6): 带 URL 参数时上划加载只拼一个 ?，并带着当前筛选与下一页页码', async () => {
  const { readFile } = await import('node:fs/promises');
  // 直接把静态脚本跑起来(它是个只依赖 window/document/fetch 的 IIFE), 不需要浏览器
  const source = await readFile(new URL('../app/admin/static/js/infinite_scroll.js', import.meta.url), 'utf8');
  const urls = [];
  const appended = [];
  const els = {
    newsLoadMoreText: { innerHTML: '', textContent: '' },
    newsTbody: { insertAdjacentHTML: (position, html) => { if (position === 'beforeend') appended.push(html); } }
  };
  const fakeDocument = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
    documentElement: { scrollHeight: 0 }
  };
  const win = {
    location: { search: '?category=outdoor&page=1&message=ok', pathname: '/admin/news_manage', origin: 'https://x', href: '' },
    addEventListener: () => {},
    setTimeout: (fn) => fn()
  };
  const fakeFetch = (url) => {
    urls.push(url);
    return Promise.resolve({ json: async () => ({ success: true, rows: '<tr class="rowCheck"></tr>' }) });
  };
  new Function('window', 'document', 'fetch', 'URLSearchParams', 'console', source)(
    win, fakeDocument, fakeFetch, URLSearchParams, console);

  const loader = win.AdminListLoader.init({
    tbodyId: 'newsTbody', sentinelId: 'newsLoadMore', textId: 'newsLoadMoreText',
    // 故意带上查询串: 线上就是被页面这么下发的(双 ? 的 bug 由此而来)
    rowsUrl: '/admin/news_manage_rows?category=outdoor',
    loadedPage: 1, totalPages: 3, total: 25, perPage: 10, rowMarker: 'rowCheck',
    cleanParams: ['message', 'error'], hintId: 'newsLoadedHint'
  });
  loader.loadNext();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(urls.length, 1, '只发了一次取数请求');
  const url = urls[0];
  assert.equal(url.indexOf('?'), url.lastIndexOf('?'), `地址里只能有一个 ?（双 ? 会把参数值污染）: ${url}`);
  assert.ok(url.startsWith('/admin/news_manage_rows?'), `端点路径不变: ${url}`);
  assert.ok(url.includes('category=outdoor'), '当前筛选要带上(不串数据)');
  assert.ok(url.includes('page=2'), '页码是下一页(不跳回第一页)');
  assert.ok(!url.includes('message='), '提示类参数不带过去');
  assert.equal(appended.length, 1, '第二页的行追加了一次');
  assert.equal(loader.state.page, 2, '页码前进到 2');

  // 空页(真的到底了)才停: 服务端回了没有标记行的片段
  loader.state.totalPages = 5;
  loader.state.page = 2;
  urls.length = 0;
  win.location.search = '?category=outdoor';
  loader.loadNext();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(urls[0], '/admin/news_manage_rows?category=outdoor&page=3', '不带 page 的地址也补成下一页');
});

test('列表分页(2.3.6): 各列表页下发的 rowsUrl 只含路径(查询参数一律由前端按 location.search 拼)', async () => {
  const { env } = makeAdminEnv({ rows: { app_categories: [] }, counts: { news: 0 } });
  const cookie = await loginCookie(env);
  const pages = [
    '/admin/news_manage?category=outdoor',
    '/admin/news_manage?category=outdoor&status=pending&keyword=x',
    '/admin/comments_manage?status=pending',
    '/admin/users?search=admin',
    '/admin/notice_manage',
    '/admin/banner_manage',
    '/admin/topics_manage'
  ];
  for (const path of pages) {
    const html = await (await get(path, env, cookie)).text();
    const found = html.match(/AdminListLoader\.init\((\{[\s\S]*?\})\);/);
    assert.ok(found, `${path} 要下发 AdminListLoader 配置`);
    const config = JSON.parse(found[1]);
    assert.ok(config.rowsUrl.startsWith('/admin/'), `${path} rowsUrl 是后台端点: ${config.rowsUrl}`);
    assert.ok(!config.rowsUrl.includes('?'), `${path} rowsUrl 只能是路径(带 ? 就会拼出双 ?): ${config.rowsUrl}`);
  }
});
