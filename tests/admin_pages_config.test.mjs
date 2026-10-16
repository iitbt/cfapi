// 配置中心与专题端到端自检: 版本配置 / 运营文案 / 专题精选(含预览)
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { findCall, get, loginCookie, makeAdminEnv, post } from './admin_stub.mjs';
import {
  IMAGE_FALLBACK_SRC, IMG_FALLBACK_ATTR, addButton, listToolbar, searchBar, searchInput, searchSelect
} from '../app/admin/lib/partials.js';

test('图片兜底(2.6.9): 六个页面的每张图片都挂同一份兜底(唯一实现在 lib/partials.js)', async () => {
  const { env } = makeAdminEnv({
    rows: {
      news: [{
        id: 5, title: '笔记', desc: '', image: 'news_uploads/a.png', category: 'outdoor', type: 'users',
        status: 1, publish_time: '2026-10-01 10:00:00', video_url: '',
        content: '<p>正文</p><img src="image/a.png" alt="">'
      }],
      app_categories: [{ category_key: 'outdoor', name: '户外' }],
      app_home_sections: [{
        id: 2, section_key: 'main', item_id: 'outdoor', name: '户外',
        image_url: 'image/home.png', sort_order: 1, status: 1
      }],
      banner_images: [{ id: 3, title: '轮播', image_url: 'news_uploads/b.png', position: 'news', sort_order: 1, status: 1 }],
      motorcycle_trips: [{ id: 9, title: '摩旅', description: '简介', poster: 'image/p.png', status: 1 }]
    }
  });
  const cookie = await loginCookie(env);
  const paths = [
    '/admin/news_manage', '/admin/news_preview?id=5', '/admin/banner_manage', '/admin/app_home_manage',
    '/admin/app_home_edit?section=main', '/admin/topics_manage?topic=motorcycle'
  ];
  for (const path of paths) {
    const html = await (await get(path, env, cookie)).text();
    assert.ok(html.includes(IMAGE_FALLBACK_SRC), `${path} 的兜底地址应指向 /lucky.jpg`);
    // 逐张数: onerror 里带 ">=" 会被"取到第一个 >"的正则截断, 所以按"img 前缀 + 紧跟兜底属性"数配对
    const total = (html.match(/<img\b/gi) || []).length;
    const guarded = (html.match(/<img\b[^>]*?onerror="this\.src\.indexOf\('/g) || []).length;
    assert.ok(total > 0, `${path} 应有图片`);
    assert.equal(guarded, total, `${path} 有 ${total - guarded} 张图片没挂兜底`);
  }
  assert.ok(IMG_FALLBACK_ATTR.includes("this.src.indexOf('/lucky.jpg')>=0"),
    '兜底图自己再失败时要收起, 避免无限循环');
});

test('统一(2.3.4): searchInput/searchSelect/searchBar 是全站唯一一份搜索区实现', () => {
  const input = searchInput({ name: 'keyword', value: '甲', placeholder: '搜索标题' });
  assert.equal(input,
    '<input type="search" class="form-control form-control-sm search-input" name="keyword" value="甲" placeholder="搜索标题">',
    '输入框: type=search + sm 高度 + 统一宽度类(.search-input)');
  assert.ok(!input.includes('style='), '宽度不再各页写内联 style');

  const select = searchSelect({ name: 'status', value: 'pending', items: [['all', '全部'], ['pending', '待审']] });
  assert.ok(select.startsWith('<select class="form-select form-select-sm search-select" name="status">'), '下拉框: sm + .search-select');
  assert.ok(select.includes('<option value="pending" selected>待审</option>'), '当前值选中');
  assert.ok(searchSelect({ name: 'col', wide: true, items: [] }).includes('search-select-lg'),
    '选项很长的下拉用 lg 宽度(12rem)');

  const bar = searchBar({ action: '/admin/x', hidden: '<input type="hidden" name="k" value="v">', body: input });
  assert.ok(bar.startsWith('<form class="search-bar d-flex flex-wrap align-items-center gap-2" method="get" action="/admin/x">'),
    '表单: 一行(flex-wrap + align-items-center + gap-2)');
  assert.ok(bar.includes('<input type="hidden" name="k" value="v">'), '隐藏字段放在控件前面');
  assert.ok(bar.includes('<button class="btn btn-sm btn-outline-secondary" type="submit">'
    + '<i class="bi bi-search" aria-hidden="true"></i> 搜索</button>'), '按钮: 样式/图标/文案三统一');
  assert.ok(!bar.includes('bi-funnel'), '搜索按钮不再用漏斗图标');
});

test('统一(2.3.4): 各页搜索条都引用共用实现, 且没有残留的旧写法(max-width / width:auto / bi-funnel)', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  env.ENABLE_SQL_TOOL = '1';
  // [地址, 必须出现的参数名(保留各页语义), 期望的共用片段]
  const cases = [
    ['/admin/news_manage', ['name="category"', 'name="status"', 'name="keyword"'], '搜索标题/摘要'],
    ['/admin/news_recycle', ['name="source"', 'name="keyword"'], '搜索标题'],
    ['/admin/notice_manage', ['name="status"', 'name="keyword"'], '按标题搜索'],
    ['/admin/topics_manage', ['name="topic"', 'name="keyword"'], '搜索标题/简介等'],
    ['/admin/users', ['name="trusted"', 'name="search"'], '按用户名或邮箱搜索'],
    ['/admin/app_text_manage', ['name="group"'], ''],
    ['/admin/media_manage', ['name="prefix"', 'name="kind"', 'name="sort"', 'name="q"'], '按对象键搜索（本层）']
  ];
  for (const [path, params, placeholder] of cases) {
    const html = await (await get(path, env, cookie)).text();
    assert.equal((html.match(/<form class="search-bar /g) || []).length, 1, `${path} 有且只有一条搜索条`);
    const bar = html.match(/<form class="search-bar[\s\S]*?<\/form>/)[0];
    assert.ok(bar.includes('class="form-select form-select-sm search-select"')
      || !bar.includes('<select'), `${path} 下拉框走 searchSelect`);
    if (placeholder) assert.ok(bar.includes('class="form-control form-control-sm search-input"'), `${path} 输入框走 searchInput`);
    assert.ok(bar.includes('<i class="bi bi-search" aria-hidden="true"></i> 搜索</button>'), `${path} 搜索按钮样式/图标/文案统一`);
    for (const param of params) assert.ok(bar.includes(param), `${path} 参数 ${param} 还在(语义不变)`);
    if (placeholder) assert.ok(bar.includes(`placeholder="${placeholder}"`), `${path} 提示文案不变`);
    assert.ok(!/max-width:\s*(130|150|120|160|200|220|14rem)px/.test(bar), `${path} 不再用 max-width 定宽`);
    assert.ok(!bar.includes('style="width:auto"') && !bar.includes('bi-funnel'), `${path} 不再用 width:auto / 漏斗图标`);
  }
});

test('缩略图(2.4.0): 派生缩略图的实现、下发与前端引用都删干净了', async () => {
  const scheme = await import('../app/core/media_scheme.js');
  for (const name of ['thumbKey', 'hasThumb', 'previewThumbUrl', 'previewBodyThumbs', 'existingThumbs',
    'NEWS_COVER_THUMB_WIDTH', 'PREVIEW_BODY_THUMB_WIDTH']) {
    assert.equal(scheme[name], undefined, `media_scheme 不该再导出 ${name}`);
  }
  const storage = await import('../app/core/storage.js');
  assert.equal(storage.thumbKeyOf, undefined, 'storage 不该再有 thumbKeyOf');
  assert.equal(storage.CACHE_CONTROL_THUMB, undefined, '缩略图的缓存口径常量也该删掉');
  const upload = await import('../app/admin/lib/mediaUpload.js');
  assert.equal(upload.thumbUrlOf, undefined, 'mediaUpload 不该再有 thumbUrlOf');

  // 关键调用点: 源码里不许再出现缩略图的助手/字段(注释除外)
  const stripComments = (source) => source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  for (const file of ['../app/api/news.js', '../app/admin/pages/news.js', '../app/admin/pages/media.js',
    '../app/admin/lib/mediaUpload.js', '../app/admin/pages/mediaGovern.js']) {
    const source = stripComments(await readFile(new URL(file, import.meta.url), 'utf8'));
    assert.ok(!/image_thumb|previewBodyThumbs|previewThumbUrl|thumbUrlOf|thumbKeyOf|thumbKey\(/.test(source),
      `${file} 不该再有缩略图代码`);
  }
});

test('上传(2.4.0): 页面用 XHR 报进度、顺序上传、失败可重试/跳过; 命名策略与文件夹入口都在', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  env.ENABLE_SQL_TOOL = '1';
  const html = await (await get('/admin/media_manage', env, cookie)).text();
  // 2.5.0: 上传脚本已搬到 static/js/media_govern.js 真文件 —— 脚本内容的断言读文件, 页面里只留引标签
  const script = await readFile(new URL('../app/admin/static/js/media_govern.js', import.meta.url), 'utf8');
  assert.ok(html.includes('static/js/media_govern.js'), '页面要引到搬出去的上传脚本');
  assert.ok(html.includes('window.__mediaGovernCfg'), '脚本要的两个常量由页面注入(不再写死在模板里)');
  // 进度只能来自 XHR(fetch 没有上传进度), 且一次只发一个文件(顺序) —— 并发会让两条进度互相打架
  assert.ok(script.includes('new XMLHttpRequest()'), '用 XHR 上传(才有 upload.onprogress)');
  assert.ok(script.includes("xhr.upload.addEventListener('progress'"), '监听上传进度');
  assert.ok(!script.includes('Promise.all(pending.map'), '不并发上传(顺序逐文件)');
  assert.ok(script.includes("data.set('name_mode', mode())"), '命名策略随请求发出');
  assert.ok(script.includes("data.set('rel_path', item.rel)"), '相对路径随请求发出');
  assert.ok(html.includes('webkitdirectory'), '文件夹入口(浏览器原生目录选择)');
  assert.ok(script.includes("buttonIn('重试'") && script.includes('function renderList()'),
    '失败项带「重试」按钮(渲染在同一份待上传清单里)');
  assert.ok(script.includes("buttonIn('跳过'"), '失败可跳过');
  // 2.4.2: 目录结构两种命名模式都保留 —— rel_path 不再按命名模式分叉, 也不再剥掉顶层文件夹名
  assert.ok(!script.includes("mode() === 'keep' && item.rel"), 'rel_path 不该只在"保留原名"时发');
  assert.ok(!script.includes('parts.slice(1).join'), '不再剥掉顶层文件夹名(整棵树都要保留)');
  assert.ok(script.includes("return file.webkitRelativePath || ''"), '相对路径整条带上(清洗交给服务端)');

  // 2.6.8: 命名默认「保留原名」+ 待上传清单(缩略图/相对路径/大小/类型/状态 + 按文件或按文件夹移除)
  assert.ok(html.includes('id="mediaNameKeep" value="keep" checked'), '命名默认值改成「保留原名」(2.6.8)');
  assert.ok(!html.includes('id="mediaNameAuto" value="auto" checked'), '「自动生成」不再默认勾选(仍是可选项)');
  assert.ok(html.includes('id="mediaUploadListBox"') && html.includes('id="mediaUploadList"'), '页面有待上传清单容器');
  assert.ok(!html.includes('id="mediaUploadFailed"'), '原来的"失败项列表"已并入待上传清单(不再两处渲染)');
  assert.ok(script.includes('URL.createObjectURL(item.file)') && script.includes('URL.revokeObjectURL'),
    '图片用本地 objectURL 出缩略图, 移除时回收');
  assert.ok(script.includes("buttonIn('移除'") && script.includes("buttonIn('移除整个文件夹'"),
    '可移除单个文件, 也可整组(整个文件夹)移除');
  assert.ok(script.includes('function groupOf(item)'), '选文件夹时按"选中的那层文件夹"分组');
  assert.ok(script.includes("wait: '等待'") && script.includes("doing: '上传中'")
    && script.includes("ok: '成功'") && script.includes("fail: '失败'"), '行内显示等待/上传中/成功/失败');
  assert.ok(script.includes('item.rel || item.file.name'), '行内显示相对路径(单独选的文件就是文件名)');
  assert.ok(script.includes("item.state === 'wait' || item.state === 'fail' || item.state === 'skip'"),
    '只有还没传上去的能移除(已成功/正在传的不可撤)');
  const bundle = await readFile(new URL('../app/admin/assets/static-assets.js', import.meta.url), 'utf8');
  assert.ok(bundle.includes('.upload-list'), '清单样式要同步进生成物(记得重跑 embed_admin_assets.mjs)');
});

test('页面内联脚本必须能解析(2.4.2): 页面用模板字符串生成 <script>, 多层转义很容易吃掉反斜杠', async () => {
  // 2026-10-10 踩过: 生成的脚本里写了 `.replace(/\\/g, '/')`, 模板字符串把它变成 `/\/g` →
  // 整段脚本 SyntaxError → 素材库页的上传/批量选择全部失效(页面看起来正常, 只是点不动)。
  const { env } = envWith();
  const cookie = await loginCookie(env);
  for (const path of ['/admin/media_manage', '/admin/news_manage', '/admin/comments_manage', '/admin/banner_manage']) {
    const html = await (await get(path, env, cookie)).text();
    const codes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(codes.length > 0, `${path} 应有内联脚本`);
    codes.forEach((code, index) => {
      assert.doesNotThrow(() => {
        // eslint-disable-next-line no-new-func
        new Function(code);
      }, `${path} 的第 ${index + 1} 段内联脚本有语法错误`);
    });
  }
});

test('统一(2.3.4): 页面源码里不许再手写搜索输入框/搜索按钮(只能用共用实现)', async () => {
  const dir = new URL('../app/admin/pages/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 10, `扫到页面目录: ${files.length} 个文件`);
  for (const name of files) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.ok(!source.includes('type="search"'), `${name} 不该自己写搜索输入框(用 searchInput)`);
    assert.ok(!source.includes('bi bi-search'), `${name} 不该自己写搜索按钮(用 searchBar)`);
    assert.ok(!/max-width:\s*(120|130|150|160|200|220|14rem)px/.test(source),
      `${name} 不该再用 max-width 给搜索框定宽(宽度统一在 admin.css 的 .search-input/.search-select)`);
  }
  // 有搜索条的页面必须调用共用实现（清单按 2.3.4 盘点结果固定下来, 防遗漏/防回退）
  for (const name of ['news.js', 'notices.js', 'topics.js', 'users.js', 'appText.js', 'mediaGovern.js', 'dbTools.js']) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.ok(source.includes('searchBar('), `${name} 要用共用搜索条 searchBar()`);
  }
});

test('统一(2.3.4): 搜索区宽度/高度只写在 admin.css 一处, 且内嵌资源包已同步', async () => {
  const css = await readFile(new URL('../app/admin/static/css/admin.css', import.meta.url), 'utf8');
  assert.match(css, /\.search-input \{ width: 12rem; \}/, '输入框统一 12rem(192px)');
  assert.match(css, /\.search-select \{ width: 9rem; \}/, '下拉框统一 9rem(144px)');
  assert.match(css, /\.search-select-lg \{ width: 12rem; \}/, '选项很长的下拉 12rem');
  // 手机端(≤767.98px)适配层: 按钮与输入框等高 + 每项独占一行
  assert.match(css, /\.search-bar \.btn, \.search-group \.btn \{ min-height: 38px; \}/, '手机端按钮补到 38px');
  assert.match(css, /\.search-bar \.form-control-sm, \.search-bar \.form-select-sm \{ width: 100%; max-width: 100%; \}/,
    '手机端每项独占一行');
  // 改了 static/** 必须重跑 tools/embed_admin_assets.mjs, 否则线上拿到的还是旧样式(2.3.2 的教训之一)
  const bundle = await readFile(new URL('../app/admin/assets/static-assets.js', import.meta.url), 'utf8');
  assert.ok(bundle.includes('.search-input') && bundle.includes('.search-group .btn'),
    '生成物里要有搜索区样式(记得重跑 embed_admin_assets.mjs)');
});

test('统一(2.3.4): 素材库弹窗的筛选行也用 sm 尺寸(与页面搜索区一致, 按钮与输入框等高)', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/news_edit?id=0', env, cookie)).text();
  const row = html.match(/<div class="input-group search-group[\s\S]*?<\/div>/)[0];
  assert.ok(row.includes('class="form-control form-control-sm"'), '筛选输入框是 sm');
  assert.ok(row.includes('class="btn btn-sm btn-outline-secondary"'), '同一行的刷新按钮也是 sm(高度一致)');
});

test('统一(2.3.3): listToolbar 固定三行(新增 / 标签条 / 搜索表单)，没传的行不渲染', () => {
  const three = listToolbar({ primary: 'A', filters: 'F', search: 'S' });
  assert.equal((three.match(/mb-3/g) || []).length, 3, '三行各占一行');
  assert.ok(three.indexOf('A') < three.indexOf('F') && three.indexOf('F') < three.indexOf('S'), '顺序固定: 新增 → 标签条 → 搜索');
  assert.ok(three.startsWith('<div class="d-flex flex-wrap align-items-center gap-2 mb-3">A'), '第一行就是新增按钮所在行');

  const two = listToolbar({ primary: 'A', search: 'S' });
  assert.equal((two.match(/mb-3/g) || []).length, 2, '没有标签条就不渲染那一行(不留空行)');
  assert.ok(!two.includes('btn-group'));

  const one = listToolbar({ primary: 'A', meta: 'M' });
  assert.equal((one.match(/mb-3/g) || []).length, 1, '只有第一行');
  assert.ok(one.includes('A') && one.includes('M') && one.includes('ms-auto'), '统计靠右跟在第一行');

  assert.equal(listToolbar({}), '', '传空就什么都不渲染');
  assert.ok(listToolbar({ meta: 'M' }).includes('M'), '只有统计也要渲染第一行');
});

test('统一(2.3.3): 各 _edit?id=0 列表页的三行顺序 —— 新增按钮在前, 标签条第二行, 搜索表单第三行', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  // [地址, 新增按钮 HTML, 标签条 aria-label(没有传 ''), 搜索表单里的字样]
  const cases = [
    ['/admin/news_manage', addButton('/admin/news_edit?id=0', '发布笔记'), '按分类筛选', '搜索标题/摘要'],
    ['/admin/topics_manage', addButton('/admin/topics_edit?topic=motorcycle&id=0', '新增摩旅路线'), '按专题分类筛选', '搜索标题/简介等'],
    ['/admin/notice_manage', addButton('/admin/notice_edit?id=0', '添加公告'), '', '按标题搜索'],
    ['/admin/app_text_manage', addButton('/admin/app_text_edit?id=0', '添加文案'), '', '全部分组']
  ];
  for (const [path, add, pillsLabel, formHint] of cases) {
    const html = await (await get(path, env, cookie)).text();
    const atAdd = html.indexOf(add);
    assert.ok(atAdd > 0, `${path} 第一行要有新增按钮`);
    const beforeAdd = html.slice(Math.max(0, atAdd - 400), atAdd);
    assert.ok(beforeAdd.includes('<div class="d-flex flex-wrap align-items-center gap-2 mb-3">'),
      `${path} 新增按钮在工具条行里`);
    assert.ok(!beforeAdd.includes('btn-group btn-group-sm'), `${path} 新增按钮之前不该有标签条`);

    const atForm = html.indexOf(formHint);
    assert.ok(atForm > atAdd, `${path} 搜索/筛选表单在新增按钮之后的另一行`);
    if (pillsLabel) {
      const atPills = html.indexOf(pillsLabel);
      assert.ok(atPills > atAdd, `${path} 标签条在新增按钮之后（第二行）`);
      assert.ok(atForm > atPills, `${path} 搜索表单在标签条之后（第三行）`);
    }
  }

  // 只有"新增"一行的页面不该凭空多出空行
  const banner = await (await get('/admin/banner_manage', env, cookie)).text();
  assert.equal((banner.match(/<div class="d-flex flex-wrap align-items-center gap-2 mb-3">/g) || []).length, 1,
    '轮播图页只有第一行');
});

function envWith(overrides = {}) {
  return makeAdminEnv(overrides);
}

test('统一(2.3.2): 各列表页的"添加/发布/新增"按钮是同一份实现(addButton)且尺寸一致', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  const pages = [
    ['/admin/banner_manage', '添加轮播图', '/admin/banner_edit?id=0'],
    ['/admin/app_text_manage', '添加文案', '/admin/app_text_edit?id=0'],
    ['/admin/app_category_manage', '添加分类', '/admin/app_category_edit?id=0'],
    ['/admin/notice_manage', '添加公告', '/admin/notice_edit?id=0'],
    ['/admin/topics_manage', '新增摩旅路线', '/admin/topics_edit?topic=motorcycle&id=0'],
    ['/admin/news_manage', '发布笔记', '/admin/news_edit?id=0']
  ];
  for (const [path, label, href] of pages) {
    const html = await (await get(path, env, cookie)).text();
    assert.ok(html.includes(addButton(href, label)), `${path} 要用共用的 addButton: ${addButton(href, label)}`);
    // 位置统一: 都在列表卡片顶部的工具条里(与筛选组同一排)
    assert.ok(html.includes('<div class="d-flex flex-wrap align-items-center gap-2 mb-3">'), `${path} 按钮在工具条里`);
  }

  // 首页板块管理: 一个"添加"(2.3.7 提到页面第一行, 2.3.8 三个合成一个), 尺寸与其它页一致 —— 不再是小号 btn-sm
  const home = await (await get('/admin/app_home_manage', env, cookie)).text();
  assert.ok(home.includes(addButton('/admin/app_home_edit?id=0&section=main', '添加')));
  assert.ok(!home.includes('btn btn-primary btn-sm'), '新增按钮不该再用 btn-sm');
  assert.ok(!home.includes('&amp;amp;section='), '链接不该被二次转义');
});

test('统一(2.3.7/2.3.8): 首页板块管理的头部与 news_manage 同构 —— 一个新增按钮第一行、板块标签条第二行', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  // [地址, 选中的 section, 第一行那**一个**按钮]（2.3.8: 三个合成一个, 按当前视图决定类型）
  const cases = [
    ['/admin/app_home_manage?section=all', 'all', ['/admin/app_home_edit?id=0&section=main', '添加']],
    ['/admin/app_home_manage?section=main', 'main', ['/admin/app_home_edit?id=0&section=main', '添加入口']],
    ['/admin/app_home_manage?section=ext', 'ext', ['/admin/app_home_edit?id=0&section=ext', '添加入口']],
    ['/admin/app_home_manage?section=featured', 'featured', ['/admin/app_home_edit?id=0&section=featured', '添加精选']]
  ];
  for (const [path, active, [href, label]] of cases) {
    const html = await (await get(path, env, cookie)).text();
    // 第一行: **一个**新增按钮(共用 addButton 逐字相同), 主按钮样式 + plus 图标
    assert.ok(html.includes(`<div class="d-flex flex-wrap align-items-center gap-2 mb-3">${addButton(href, label)}</div>`),
      `${path} 第一行只有这一个新增按钮: ${addButton(href, label)}`);
    const firstRow = html.match(/<div class="d-flex flex-wrap align-items-center gap-2 mb-3">[\s\S]*?<\/div>/)[0];
    assert.equal((firstRow.match(/bi bi-plus-lg/g) || []).length, 1, `${path} 第一行按钮个数为 1`);
    assert.ok(!firstRow.includes('btn-group'), `${path} 第一行不放标签条`);
    assert.equal((html.match(/btn-group btn-group-sm/g) || []).length, 1, `${path} 只有一条板块标签条`);
    // 顺序: 新增按钮在前, 标签条在后(与 news_manage 的第一/二行一致)
    assert.ok(html.indexOf('bi bi-plus-lg') < html.indexOf('btn-group btn-group-sm'), `${path} 新增按钮要排在标签条前面`);
    // 标签条: 与 news_manage 同款结构 + 当前 section 的选中态(直链/刷新都定位得到)
    assert.ok(html.includes('<div class="btn-group btn-group-sm" role="group" aria-label="按首页内容板块筛选">'));
    assert.match(html.match(/<div class="btn-group[\s\S]*?<\/div>/)[0],
      new RegExp(`class="btn btn-outline-secondary active" href="/admin/app_home_manage\\?section=${active}"[^>]*aria-current="page"`));
    // 按钮不再挂在板块卡片头部(靠右的小角落), 也没有旧的 /admin/app_featured_edit 入口
    assert.ok(!html.includes('ms-auto" href="/admin/app_home_edit'), `${path} 卡片头部不该再有靠右的新增按钮`);
    assert.ok(!html.includes('/admin/app_featured_edit'), `${path} 不该再有已删除的精选编辑入口`);
  }
});

test('统一(2.3.2): 各 *_edit 页面与 news_edit 同一骨架(单列居中 + 800px 尺度 + 发布设置卡)', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  // [地址, 主按钮文案, 设置卡标题] —— 卡标题各页可自定义(版本配置页叫"保存"), 但骨架必须一致
  const edits = [
    ['/admin/news_edit?id=0', '发布笔记', '发布设置'],
    ['/admin/banner_edit?id=0', '添加轮播图', '发布设置'],
    ['/admin/app_text_edit?id=0', '添加', '发布设置'],
    ['/admin/app_category_edit?id=0', '添加分类', '发布设置'],
    ['/admin/notice_edit?id=0', '添加公告', '发布设置'],
    // 2.7.0: 摩旅/户外两个编辑页合并成 topics_edit(?topic= 区分)
    ['/admin/topics_edit?topic=motorcycle&id=0', '新增摩旅路线', '发布设置'],
    // 2.3.8: 精选的编辑页已并入 app_home_edit(?section=featured, 字段集与板块入口不同)
    ['/admin/app_home_edit?id=0&section=featured', '添加精选', '发布设置'],
    ['/admin/app_home_edit?id=0&section=main', '添加入口', '发布设置'],
    ['/admin/app_version_edit', '保存配置', '保存']
  ];
  for (const [path, primary, sideTitle] of edits) {
    const html = await (await get(path, env, cookie)).text();
    assert.ok(html.includes('class="row g-3 justify-content-center"'), `${path} 单列居中`);
    assert.ok(html.includes('class="col-lg-8 mp-frame"'), `${path} 主列取 800px 小程序尺度`);
    assert.ok(!html.includes('class="col-lg-4"'), `${path} 不该再有右侧栏(设置项收进卡片)`);
    assert.ok(html.includes(`<div class="form-label">${sideTitle}</div>`), `${path} 设置卡标题 ${sideTitle}`);
    assert.ok(html.includes(`</i> ${primary}</button>`), `${path} 主按钮文案 ${primary}`);
  }
});

test('版本配置: 表里没有这一行时用默认值渲染, 且不写库', async () => {
  const { env, state } = envWith();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_version_edit', env, cookie)).text();
  assert.ok(html.includes('发现新版本，更新后体验更好'), '默认提示语');
  assert.equal(findCall(state, /INSERT INTO app_version_config/i), null, '只是看一眼不该写库');
});

test('版本配置: 格式与 min>latest 都要拦下', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  const bad = await post('/admin/app_version_edit', { latest_version: 'v3.4' }, env, cookie);
  assert.ok((await bad.text()).includes('最新版本格式不正确'));
  const wrong = await post('/admin/app_version_edit', { latest_version: '3.4', min_version: '3.9' }, env, cookie);
  assert.ok((await wrong.text()).includes('最低可用版本不能高于最新版本'));
});

test('版本配置: 首次保存走 INSERT(id=1), 已存在时走 UPDATE', async () => {
  const fresh = envWith();
  const cookie = await loginCookie(fresh.env);
  const created = await post('/admin/app_version_edit', { latest_version: '3.5', min_version: '3.0' }, fresh.env, cookie);
  assert.equal(created.status, 302);
  assert.ok(created.headers.get('location').includes(encodeURIComponent('版本更新配置已保存')));
  const insert = findCall(fresh.state, /INSERT INTO app_version_config/i);
  assert.ok(insert, '首次保存要 INSERT');
  assert.deepEqual(insert.args.slice(0, 2), ['3.5', '3.0']);

  const existing = envWith({ rows: { app_version_config: [{ id: 1, latest_version: '3.4', min_version: '3.0', update_tip: 't', update_content: 'c' }] } });
  const cookie2 = await loginCookie(existing.env);
  await post('/admin/app_version_edit', { latest_version: '3.6' }, existing.env, cookie2);
  assert.ok(findCall(existing.state, /UPDATE app_version_config/i), '已有行要 UPDATE');
});

test('运营文案列表: 分组筛选 + 缺内置文案按全表判断', async () => {
  const { env, state } = envWith({
    rows: { app_texts: [{ id: 1, text_key: 'login.prompt', title: '授权登录提示', content: '需要登录', group_name: '登录授权', sort_order: 1, status: 1 }] },
    counts: { app_texts: 1 },
    db: (sql, args, kind) => {
      if (kind === 'all' && /SELECT text_key FROM app_texts/i.test(sql)) {
        // 全表里有 agreement.content(虽然不在展示行里), 说明它存在
        return [{ text_key: 'login.prompt' }, { text_key: 'agreement.content' }];
      }
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/app_text_manage?group=登录授权', env, cookie)).text();
  assert.ok(html.includes('授权登录提示'));
  assert.ok(!html.includes('agreement.content'), '全表已有的不该被报成缺失');
  assert.ok(html.includes('share.default_image'), '真正缺的要报出来');
  const count = findCall(state, /COUNT\(\*\) AS c FROM app_texts/i);
  assert.ok(/group_name = \?/.test(count.sql));
  assert.deepEqual(count.args, ['登录授权']);
});

test('运营文案编辑: 标识格式/重复/title 必填都拦得住', async () => {
  const { env, state } = envWith();
  const cookie = await loginCookie(env);
  const bad = await post('/admin/app_text_edit?id=0', { text_key: 'Login.prompt', title: 'x' }, env, cookie);
  assert.ok((await bad.text()).includes('文案标识格式不正确'));
  const noTitle = await post('/admin/app_text_edit?id=0', { text_key: 'login.prompt' }, env, cookie);
  assert.ok((await noTitle.text()).includes('请填写说明(后台列表里显示的那句话)'));
  assert.equal(findCall(state, /INSERT INTO app_texts/i), null);
});

test('运营文案编辑: 正文保留换行(不能 strip)', async () => {
  const { env, state } = envWith();
  const cookie = await loginCookie(env);
  const res = await post('/admin/app_text_edit?id=0',
    { text_key: 'about.content', title: '关于正文', content: '第一行\n第二行\n', group_name: '隐私与关于' }, env, cookie);
  assert.equal(res.status, 302);
  const insert = findCall(state, /INSERT INTO app_texts/i);
  assert.equal(insert.args[2], '第一行\n第二行\n');
});

test('专题列表: topic 参数决定表名与列头', async () => {
  const { env } = envWith({
    rows: { outdoor_activities: [{ id: 3, title: '雨崩', description: '徒步', poster: 'p.jpg', videoUrl: '', status: 'approved', date: '2013-11', location: '云南' }] },
    counts: { outdoor_activities: 1 }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/topics_manage?topic=outdoor', env, cookie)).text();
  assert.ok(html.includes('活动地点') && html.includes('活动日期'), '户外的额外字段列头');
  assert.ok(html.includes('雨崩'));
  assert.ok(html.includes('户外精选'), '选中项高亮');
  // 同一个筛选组宏(partials.filterButtons, 与留言管理页同款): 选中态 + aria-current, 两项都可直链
  assert.match(html, /class="btn btn-outline-secondary active" href="\/admin\/topics_manage\?topic=outdoor" aria-current="page">户外精选</);
  assert.match(html, /class="btn btn-outline-secondary" href="\/admin\/topics_manage\?topic=motorcycle">摩旅精选</);
});

test('专题旧地址: 302 到聚合页并带 topic', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  const res = await get('/admin/motorcycle_manage?page=2', env, cookie);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location').startsWith('/admin/topics_manage?'));
  assert.ok(res.headers.get('location').includes('topic=motorcycle'));
  assert.ok(res.headers.get('location').includes('page=2'), '原查询串不丢');
});

test('专题编辑: 必填项合并成一条文案, 状态非法时回落 approved', async () => {
  const { env, state } = envWith();
  const cookie = await loginCookie(env);
  const missing = await post('/admin/topics_edit?topic=motorcycle&id=0', { title: '川藏线' }, env, cookie);
  assert.ok((await missing.text()).includes('请填写必填项: 简介、封面图 URL'));
  const ok = await post('/admin/topics_edit?topic=motorcycle&id=0',
    { title: '川藏线', description: '骑行', poster: 'p.jpg', videoUrl: '', status: 'weird', distance: '2000' }, env, cookie);
  assert.equal(ok.status, 302);
  const insert = findCall(state, /INSERT INTO motorcycle_trips/i);
  assert.equal(insert.args[4], 'approved', '非法状态回落 approved');
  assert.equal(insert.args[5], '2000', '额外字段要一起写入');
});

test('专题编辑(2.7.0 合并): 项目单选决定字段集与写哪张表, 缺/非法 topic 一律拒绝且不写库', async () => {
  const { env, state } = envWith({
    db: (sql, args, kind) => {
      if (kind === 'first' && /FROM motorcycle_trips WHERE id = \?/i.test(sql)) {
        return { id: 7, title: '川藏线', description: '骑行', poster: 'p.jpg', videoUrl: '', status: 'approved', distance: '2000', duration: '30 天', difficulty: '困难' };
      }
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const navOf = (html) => html.slice(html.indexOf('选择项目类型') - 200, html.indexOf('选择项目类型') + 400);

  // ① 新增摩旅: 顶部有项目单选, 只有摩旅的独有字段
  const moto = await (await get('/admin/topics_edit?topic=motorcycle&id=0', env, cookie)).text();
  const motoNav = navOf(moto);
  assert.ok(motoNav.includes('btn-group btn-group-sm'), '单选沿用统一标签条(partials.filterButtons)');
  assert.ok(motoNav.includes('href="/admin/topics_edit?topic=motorcycle&amp;id=0"') && motoNav.includes('aria-current="page"'), '摩旅项选中');
  assert.ok(motoNav.includes('href="/admin/topics_edit?topic=outdoor&amp;id=0"'), '另一项目也能切');
  for (const label of ['骑行里程(km)', '计划时长', '难度']) assert.ok(moto.includes(label), `摩旅字段缺 ${label}`);
  for (const label of ['活动日期', '活动地点']) assert.ok(!moto.includes(label), `摩旅页不该有户外字段 ${label}`);
  assert.ok(moto.indexOf('选择项目类型') < moto.indexOf('id="titleInput"'), '单选在标题字段上方');
  // 封面与视频上下排: 两段不再包在同一个 row/col-md-6 里, 各占整行(上一段是封面、下一段是视频)
  assert.ok(!moto.includes('<div class="col-md-6">'), '封面与视频改为上下排版');
  assert.ok(moto.indexOf('id="posterFieldUrl"') < moto.indexOf('id="videoUrlFieldUrl"'), '封面在视频上方');

  // ② 新增户外: 独有字段换成户外的, 单选跟着切换
  const outdoor = await (await get('/admin/topics_edit?topic=outdoor&id=0', env, cookie)).text();
  assert.ok(navOf(outdoor).includes('href="/admin/topics_edit?topic=outdoor&amp;id=0"'), '户外项可选中');
  for (const label of ['活动日期', '活动地点']) assert.ok(outdoor.includes(label), `户外字段缺 ${label}`);
  for (const label of ['骑行里程(km)', '计划时长', '难度']) assert.ok(!outdoor.includes(label), `户外页不该有摩旅字段 ${label}`);

  // ③ 编辑态: 读的是本项目的表, 单选里本条记录保持 id, 另一种项目回到新增
  const edit = await (await get('/admin/topics_edit?topic=motorcycle&id=7', env, cookie)).text();
  assert.ok(edit.includes('川藏线'), '按 topic 读对应的表');
  const editNav = navOf(edit);
  assert.ok(editNav.includes('href="/admin/topics_edit?topic=motorcycle&amp;id=7"'), '本项目保持当前记录');
  assert.ok(editNav.includes('href="/admin/topics_edit?topic=outdoor&amp;id=0"'), '换项目=新增另一种(两张表 id 不是一回事)');
  assert.ok(edit.includes('name="title" id="titleInput" value="川藏线"') && edit.includes('name="distance"'), '字段带原值');

  // ④ 保存各写各的表(互不串改)
  const saved = await post('/admin/topics_edit?topic=outdoor&id=0',
    { title: '雨崩', description: '徒步', poster: 'p.jpg', videoUrl: '', status: 'approved', date: '2013-11', location: '云南' }, env, cookie);
  assert.equal(saved.status, 302);
  assert.ok(saved.headers.get('location').includes('topic=outdoor'), '保存后回户外列表');
  const insert = findCall(state, /INSERT INTO outdoor_activities/i);
  assert.ok(insert && insert.args.includes('云南'), '户外内容写进户外表');
  assert.equal(findCall(state, /INSERT INTO motorcycle_trips/i), null, '不会串写摩旅那张表');

  // ⑤ 缺 / 非法 topic: 报错页, 不碰数据库
  const before = state.calls.length;
  for (const path of ['/admin/topics_edit?id=0', '/admin/topics_edit?topic=weird&id=0']) {
    const bad = await post(path, { title: 'x', description: 'y', poster: 'z', location: '云南' }, env, cookie);
    assert.ok((await bad.text()).includes('缺少或无效的项目参数'), `${path} 要报错`);
  }
  assert.equal(state.calls.slice(before).filter((item) => /INSERT|UPDATE/i.test(item.sql)).length, 0,
    '缺/非法 topic 一律不写库(不回落摩旅表)');
});

test('专题预览: 只渲染非空的额外字段', async () => {
  const { env } = envWith({
    db: (sql, args, kind) => {
      if (kind === 'first' && /FROM outdoor_activities WHERE id = \?/i.test(sql)) {
        return { id: 3, title: '雨崩', description: '徒步', poster: 'p.jpg', videoUrl: '', status: 'pending', date: '2013-11', location: '' };
      }
      return undefined;
    }
  });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/outdoor_preview?id=3', env, cookie)).text();
  assert.ok(html.includes('雨崩'));
  assert.ok(html.includes('待审核'), '状态显示中文而不是 pending');
  assert.ok(html.includes('活动日期'));
  assert.ok(!html.includes('活动地点'), '空值行整行不渲染');
});

test('专题预览: 缺 id 给"缺少记录ID"', async () => {
  const { env } = envWith();
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/motorcycle_preview', env, cookie)).text();
  assert.ok(html.includes('缺少记录ID'));
});
