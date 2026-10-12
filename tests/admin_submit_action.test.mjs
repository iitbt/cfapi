// 后台动作字段自检(防回归): 提交按钮不许设 disabled(会丢 name/value), 动作字段一律走隐藏域
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { USER_ROW } from './stub.mjs';
import { findCall, get, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';

const shellSource = await readFile(new URL('../app/admin/static/js/admin-shell.js', import.meta.url), 'utf8');
// 注释里会解释这条纪律(含"btn.disabled = true"字样), 断言只看真实代码
const shellCode = shellSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  // 注意别写成 /\/\/.*$/ —— 行尾的 \r 会让它匹配不上(文件是 CRLF)
  .map((line) => line.replace(/\/\/.*/, ''))
  .join('\n');

test('提交按钮防重: 不许设 disabled(会丢 name/value), 只能用 aria-disabled', () => {
  assert.ok(!/\.disabled\s*=\s*true/.test(shellCode),
    'submit 事件里给按钮设 disabled 会让它的 name/value 整条丢掉(表单数据构造在事件之后)');
  assert.ok(shellSource.includes("setAttribute('aria-disabled', 'true')"),
    '锁定按钮要走 aria-disabled');
  assert.ok(shellSource.includes('pointerEvents'), '锁定按钮要顺带停掉点击(pointer-events)');
  assert.ok(shellSource.includes('unlockButton'), '从 bfcache 返回时要能解锁');
});

test('用户页: 三个动作都用隐藏域提交, 且与后端识别值一致', async () => {
  // status=1 才有【恢复账号】, is_trusted=0 才有【设为内部测试】
  const row = Object.assign({}, USER_ROW, { status: 1, is_trusted: 0 });
  const { env } = makeAdminEnv({ rows: { users: [row] }, counts: { users: 1 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/users', env, cookie)).text();

  for (const value of ['set_trusted', 'restore_user']) {
    assert.ok(html.includes(`<input type="hidden" name="action" value="${value}">`),
      `${value} 必须走隐藏域(不依赖提交按钮)`);
  }
  assert.ok(html.includes('恢复账号') && html.includes('设为内部测试'));
  assert.ok(!/<button[^>]*name="action"/.test(html), '不要再把动作挂在按钮的 name 上');
  assert.ok(html.includes("confirm('恢复该账号？恢复后他可以正常登录。')"), '恢复账号要先确认');
  assert.ok(html.includes("confirm('设为内部测试用户？"), '设为内部测试要先确认');
});

test('用户页: 已设内部测试时给"取消内部测试"(动作值 remove_trusted)', async () => {
  const row = Object.assign({}, USER_ROW, { status: 0, is_trusted: 1 });
  const { env } = makeAdminEnv({ rows: { users: [row] }, counts: { users: 1 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/users', env, cookie)).text();
  assert.ok(html.includes('<input type="hidden" name="action" value="remove_trusted">'));
  assert.ok(html.includes('取消内部测试'));
});

test('上传弹窗: 静态脚本必须自己绑 [data-image-upload](漏了就是"点了上传没反应")', async () => {
  const uploader = await readFile(new URL('../app/admin/static/js/image_upload.js', import.meta.url), 'utf8');
  // 表单只带 data-* 说明行为, 真正发请求的是这个脚本; 旧站这段写在模板里, 抽静态脚本时最容易漏
  assert.ok(uploader.includes("hasAttribute('data-image-upload')"), '要认领上传表单');
  assert.ok(/document\.addEventListener\('submit',[\s\S]{0,4000}?\}, true\)/.test(uploader),
    '要用 capture 阶段监听: 先 preventDefault, 才不会被整页提交处理器当成重复提交锁住按钮');
  for (const attr of ['dataset.target', 'dataset.preview', 'dataset.insert', 'dataset.purpose']) {
    assert.ok(uploader.includes(attr), `要按表单的 ${attr} 决定回填/插入/用途`);
  }
  assert.ok(uploader.includes('MediaInsertFromUpload'), '正文用法要交给页面提供的插入回调');
});

test('编辑页: 必须引到上传与素材库脚本(漏引 = 点上传没反应、素材库弹窗空白)', async () => {
  const row = {
    id: 5, title: '标题', desc: '简介', image: 'news_uploads/home/a.jpg', video_url: '',
    category: 'outdoor', type: 'users', status: 'approved', publish_time: '2026-10-01 10:00:00',
    activity_time: '', view_count: 3, likes: 1, favorites: 0, shares: 0, user_id: 7
  };
  const { env } = makeAdminEnv({
    role: 'super',
    rows: { news: [row], app_categories: [{ category_key: 'outdoor', name: '户外' }] },
    counts: { news: 1 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_edit?id=5', env, cookie)).text();
  // 页面确实有这两个弹窗(不是"页面没用所以没引"): partials.js 只渲染 HTML, script 标签由外壳统一加
  assert.ok(html.includes('data-image-upload'), '上传弹窗表单');
  assert.ok(html.includes('id="mediaLibraryModal"'), '素材库弹窗');
  for (const name of ['image_upload.js', 'media_library.js']) {
    assert.ok(html.includes(`/admin/static/js/${name}?v=`), `${name} 必须被引入, 否则弹窗点了没反应`);
  }
});

test('编辑页: 富文本编辑器容器、自托管资源与三种插图入口都在', async () => {
  const row = {
    id: 5, title: '标题', desc: '简介', image: 'news_uploads/home/a.jpg',
    video_url: '', content: '<p>正文</p><wx-video src="video/v.mp4"></wx-video>',
    category: 'outdoor', type: 'users', status: 'approved', publish_time: '2026-10-01 10:00:00',
    activity_time: '', view_count: 3, likes: 1, favorites: 0, shares: 0, user_id: 7
  };
  const { env } = makeAdminEnv({
    role: 'super',
    rows: { news: [row], app_categories: [{ category_key: 'outdoor', name: '户外' }] },
    counts: { news: 1 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_edit?id=5', env, cookie)).text();

  // 容器三件套: 工具栏 + 编辑区 + 隐藏提交域(name=content)
  assert.ok(html.includes('id="contentToolbar"'), '工具栏容器');
  assert.ok(html.includes('id="contentEditor"'), '编辑区容器');
  assert.ok(html.includes('id="contentRaw" name="content"'), '隐藏文本域承载提交值');
  assert.ok(!html.includes('newsContentTextarea'), '旧的纯文本域不该还在');
  assert.ok(html.includes(`data-media-prefixes="image/,video/,news_uploads/"`), '回显转换用同一份目录清单');
  // 自托管资源(不走 CDN)与初始化脚本, 顺序: 样式 → 本体 → 初始化
  for (const asset of ['vendor/wangeditor/style.css', 'vendor/wangeditor/index.js', 'js/news_editor.js']) {
    assert.ok(html.includes(`/admin/static/${asset}?v=`), `${asset} 必须被引入`);
  }
  assert.ok(html.indexOf('vendor/wangeditor/index.js') < html.indexOf('js/news_editor.js'),
    '编辑器本体要先于初始化脚本加载');
  // 三种插图入口: 本地上传(kind=mixed + insert=editor) / 图片素材库 / 视频素材库(editor 模式)
  assert.ok(html.includes('id="editorUploadModal"'), '正文本地上传弹窗');
  assert.ok(html.includes('data-insert="editor"'), '上传成功后要插到编辑器');
  assert.ok(html.includes('data-media-mode="editor"'), '素材库要走 editor 模式');
  assert.ok(html.includes('data-media-target="#imageFieldUrl"'), '封面字段仍是 input 模式(两种模式互不干扰)');
  // 回显: 库内 wx-video 要转成编辑器认识的 <video>(根路径), 再作为文本域的值被转义输出
  const rawValue = (/<textarea id="contentRaw"[^>]*>([\s\S]*?)<\/textarea>/.exec(html) || [])[1] || '';
  assert.ok(rawValue.includes('&lt;video src=&quot;/video/v.mp4&quot;'), 'wx-video 回显成 video');
  assert.ok(!rawValue.includes('wx-video'), '交给编辑器的内容里不该再有 wx-video');
});

test('静态脚本不许有孤儿: 资源包里的每个 js 都要被页面或外壳引用', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const assets = (await import('../app/admin/assets/static-assets.js')).default;
  const files = (await readdir(new URL('../app/admin', import.meta.url), { recursive: true }))
    .filter((name) => name.endsWith('.js') && !name.includes('assets'));
  const text = (await Promise.all(files.map((name) => (
    readFile(new URL(`../app/admin/${name}`, import.meta.url), 'utf8')
  )))).join('\n');
  for (const key of Object.keys(assets).filter((name) => name.startsWith('js/'))) {
    const name = key.slice(key.lastIndexOf('/') + 1);   // 引用处写的是文件名(前缀由布局拼)
    assert.ok(text.includes(name), `${key} 没有任何地方引用: 抽静态脚本时最容易漏的就是 script 标签`);
  }
  assert.ok(text.includes('MODAL_SCRIPTS'), '弹窗脚本由 lib/layout.js 统一引');
});

test('素材库弹窗: 目录清单由模板下发(前端不自己写死 news_uploads/)', async () => {
  const { mediaLibraryModal } = await import('../app/admin/lib/partials.js');
  assert.ok(mediaLibraryModal().includes('data-media-prefixes="image/,video/,news_uploads/"'),
    '弹窗要下发素材目录清单(真值在 core/storage.js)');
  const picker = await readFile(new URL('../app/admin/static/js/media_library.js', import.meta.url), 'utf8');
  assert.ok(picker.includes("getAttribute('data-media-prefixes')"), '前端要读这份清单');
  assert.ok(!/v = 'news_uploads\/' \+ v/.test(picker), '手工填路径不该再强行补历史前缀');
});

test('列宽: .cell-title 是固定宽度(桌面 360 / 手机 200), 且生成物里已带上', async () => {
  const css = await readFile(new URL('../app/admin/static/css/admin.css', import.meta.url), 'utf8');
  // 标题/文件名列必须"不随内容长短变化": 三个宽度一起写死, 长内容交给省略号 + title 提示
  assert.match(css, /\.cell-title \{ width: 360px; min-width: 360px; max-width: 360px; \}/);
  assert.match(css, /\.cell-title \{ width: 200px; min-width: 200px; max-width: 200px; \}/, '手机端适配层要收窄');
  // 改 static/** 必须重跑 tools/embed_admin_assets.mjs, 否则线上拿到的还是旧样式
  const bundle = await readFile(new URL('../app/admin/assets/static-assets.js', import.meta.url), 'utf8');
  assert.ok(bundle.includes('.cell-title'), '生成物里要有这条样式(记得重跑 embed_admin_assets.mjs)');
});

test('筛选组: 五个管理页共用 partials.filterButtons 一份实现(结构与留言管理页逐字一致)', async () => {
  const { filterButtons } = await import('../app/admin/lib/partials.js');
  const html = filterButtons({
    baseUrl: '/admin/x', param: 'kind', active: 'video', label: '按类型筛选',
    extra: { q: 'abc', sort: '' },
    items: [['all', '全部'], ['video', '视频']]
  });
  // 结构/class 与 comments_manage 上那一组一致(留言页也走这个函数, 所以两边逐字相同)
  assert.ok(html.startsWith('<div class="btn-group btn-group-sm" role="group" aria-label="按类型筛选">'), '与留言管理页同款');
  assert.ok(html.includes('<a class="btn btn-outline-secondary active" href="/admin/x?kind=video&amp;q=abc" aria-current="page">视频</a>'),
    '选中项高亮 + 可直链, 且其它筛选参数跟着走');
  assert.ok(html.includes('<a class="btn btn-outline-secondary" href="/admin/x?kind=all&amp;q=abc">全部</a>'),
    '"全部"也带参数(与留言页 ?status=all 同口径), 且其它筛选参数跟着走');
  // 五个页面都只引用共用实现, 不自己拼按钮组/胶囊标记
  for (const page of ['comments', 'topics', 'news', 'mediaGovern', 'appHome']) {
    const source = await readFile(new URL(`../app/admin/pages/${page}.js`, import.meta.url), 'utf8');
    assert.ok(source.includes('filterButtons('), `${page}.js 要用共用筛选组`);
    assert.ok(!source.includes('btn-group'), `${page}.js 不该自己写按钮组标记`);
    assert.ok(!source.includes('nav-pills'), `${page}.js 不该自己写筛选条标记`);
  }
  // 旧的胶囊样式已随统一一并删除(只留注释说明), 且手机端允许换行
  const css = await readFile(new URL('../app/admin/static/css/admin.css', import.meta.url), 'utf8');
  assert.ok(!/\.nav-pills \.nav-link \{/.test(css), '旧胶囊样式应已删除');
  assert.match(css, /\.btn-group \{ flex-wrap: wrap; \}/, '手机端适配层要允许筛选组换行');
});

test('管理员页: 重置口令 / 删除 也用隐藏域(同类问题一并修)', async () => {
  const other = {
    id: 2, username: 'ops', nickname: '运维', email: '', role: 'normal',
    create_time: '2026-09-01 10:00:00', last_login_time: '2026-10-01 08:00:00'
  };
  const { env } = makeAdminEnv({ rows: { admin_users: [other] }, counts: { admin_users: 2 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/admin_users', env, cookie)).text();
  assert.ok(html.includes('<input type="hidden" name="reset_admin_password" value="1">'));
  assert.ok(html.includes('<input type="hidden" name="delete_admin" value="1">'));
});

test('专题: 写操作只认路径对应的表(?topic= 不能把摩托罗拉的删除指到户外表)', async () => {
  const { env, state } = makeAdminEnv({ rows: { motorcycle_trips: [{ id: 3, title: '摩旅', poster: '' }] } });
  const cookie = await loginCookie(env);
  const res = await post('/admin/motorcycle_delete', { id: '3', topic: 'outdoor' }, env, cookie);
  assert.equal(res.status, 302);
  const del = findCall(state, /^DELETE FROM (motorcycle_trips|outdoor_activities)/i);
  assert.ok(del, '要发出删除语句');
  assert.match(del.sql, /DELETE FROM motorcycle_trips/i, '路由是 motorcycle_delete 就只动 motorcycle_trips');
});

test('初始化: 没配 ADMIN_SESSION_SECRET 时 POST 也不能建超管(与 GET 同一口径)', async () => {
  const { env } = makeAdminEnv({ counts: { admin_users: 0 } });
  delete env.ADMIN_SESSION_SECRET;
  const res = await post('/admin/bootstrap', { username: 'boss', password: 'password-12345' }, env);
  assert.equal(res.status, 403);
  assert.ok((await res.text()).includes('后台未就绪'));
});

test('新增管理员: 角色按提交值写入(只认 super/normal, 默认普通)', async () => {
  const { env, state } = makeAdminEnv({ counts: { admin_users: 1 } });
  const cookie = await loginCookie(env);
  await post('/admin/admin_users', {
    add_admin: '1', username: 'ops2', password: 'password-12345', confirm_password: 'password-12345', role: 'super'
  }, env, cookie);
  const insert = findCall(state, /INSERT INTO admin_users/i);
  assert.ok(insert, '要发出 INSERT');
  assert.match(insert.sql, /role/i, 'INSERT 必须显式写角色列');
  assert.equal(insert.args[4], 'super');

  const plain = makeAdminEnv({ counts: { admin_users: 1 } });
  const plainCookie = await loginCookie(plain.env);
  await post('/admin/admin_users', {
    add_admin: '1', username: 'ops3', password: 'password-12345', confirm_password: 'password-12345', role: 'root'
  }, plain.env, plainCookie);
  assert.equal(findCall(plain.state, /INSERT INTO admin_users/i).args[4], 'normal', '非法角色回落普通管理员');
});

test('管理员列表: 角色列按库里的 role 渲染(内置账号恒为超管)', async () => {
  const other = { id: 2, username: 'ops', nickname: '运维', email: '', role: 'normal' };
  const { env } = makeAdminEnv({ rows: { admin_users: [other] }, counts: { admin_users: 2 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/admin_users', env, cookie)).text();
  assert.ok(html.includes('>角色</th>'), '列表要有角色列');
  assert.ok(/<span class="badge text-bg-secondary">普通<\/span>/.test(html), '普通管理员显示"普通"');
});

test('分页回显: 行内表单带的是"首屏实际渲染到的那一页", 不是 URL 里的 page', async () => {
  const other = { id: 2, username: 'ops', nickname: '运维', email: '', role: 'normal' };
  const { env } = makeAdminEnv({ rows: { admin_users: [other] }, counts: { admin_users: 50 } });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/admin_users?page=5', env, cookie)).text();
  // 首屏最多渲染 3 页(MAX_FIRST_SCREEN_PAGES), 所以回跳页码必须是 3 —— 用 5 会落在一页空白上
  assert.ok(html.includes('<input type="hidden" name="page" value="3">'), '回显页码要被首屏上限夹到 3');
  assert.ok(!html.includes('<input type="hidden" name="page" value="5">'));
});

test('id 参数: 只认纯数字("12-3" 这类写法一律拒绝)', async () => {
  const { env } = makeAdminEnv();
  const cookie = await loginCookie(env);
  const res = await post('/admin/news_restore', { id: '12-3' }, env, cookie);
  assert.equal(res.status, 302);
  assert.ok(String(res.headers.get('location')).includes(encodeURIComponent('参数错误')));
});
