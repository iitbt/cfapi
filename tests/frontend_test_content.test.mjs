// 小程序前端守卫(4.5.7 起): 测试内容(专题视频 / 正文视频 / 留言区)必须真的显示出来
//
// 为什么放在后端测试里: 小程序工程没有 npm、测试跑不起来(纯原生 WXML+JS),
// 而这几个文件都是**可被 Node 直接 require 的 CommonJS 模块**, 用桩顶掉 getApp/wx/Page/Behavior 就能真跑一遍。
// 守卫挡住的是这条最容易复发的回归链:
//   ① 秒开缓存里 video_url 被清空(有意设计) → 服务端回包补上 → 列表指纹若不含 video_url 就会判成"内容没变",
//      整表跳过 setData, 渲染层永远是空串 → 内部测试用户看不到播放按钮、点封面也播不出来;
//   ② 端上再按**本地身份镜像**(只在「我的」页刷新)把服务端下发的 video_url 清掉 → 后台刚授权就白授权;
//   ③ 详情页(正文视频 / 留言区)不认服务端的 can_watch_video, 只认本地镜像 → 同样"改了不生效"。
// 口径与 review_guard 一致: 本机没有前端源码(只部署后端)时跳过, 不算失败。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 前端目录: 与其它跨端守卫同一口径(允许 LYXJ_DIR 覆盖, 缺省 = 与 cfapi 同级的 xapp)
const XAPP = (process.env.LYXJ_DIR || fileURLToPath(new URL('../../xapp/', import.meta.url)))
  .replace(/[\\/]+$/, '') + '/';
const UTIL = XAPP + 'utils/util.js';
const TRUSTED = XAPP + 'utils/trustedUser.js';
const VIDEO_BEHAVIOR = XAPP + 'subpackages/content/behaviors/videoListBehavior.js';
const DETAIL = XAPP + 'subpackages/content/news-detail/news-detail.js';

const require = createRequire(new URL('../main.js', import.meta.url));

// 被 Page() 注册到的页面配置(按注册顺序)
const registered = [];
let store = {};

// 小程序全局对象的桩: storage 用内存实现(缓存相关逻辑要真跑), UI 方法一律空实现
function installStubs(appStub) {
  store = {};
  globalThis.wx = {
    getStorageSync: (key) => (store[key] === undefined ? '' : store[key]),
    setStorageSync: (key, value) => { store[key] = value; },
    removeStorageSync: (key) => { delete store[key]; },
    getStorageInfoSync: () => ({ keys: Object.keys(store), currentSize: 0, limitSize: 10240 }),
    stopPullDownRefresh() {}, showToast() {}, hideToast() {}, showLoading() {}, hideLoading() {},
    showModal() {}, setNavigationBarTitle() {}, startPullDownRefresh() {}, setClipboardData() {}
  };
  globalThis.getCurrentPages = () => [];
  globalThis.Behavior = (cfg) => cfg;
  globalThis.Component = (cfg) => cfg;
  globalThis.Page = (cfg) => { registered.push(cfg); };
  globalThis.getApp = () => appStub;
}

function dropStubs() {
  ['wx', 'getApp', 'App', 'Page', 'Behavior', 'Component', 'getCurrentPages'].forEach((key) => {
    delete globalThis[key];
  });
}

// 够用的 setData: 支持整表(newsList)与按下标(newsList[0].isPlaying)两种写法
const makeSetData = (target, patches) => function setData(patch) {
  patches.push(patch);
  Object.keys(patch || {}).forEach((key) => {
    const path = key.replace(/\[(\d+)\]/g, '.$1').split('.');
    let node = target;
    for (let i = 0; i < path.length - 1; i += 1) node = node[path[i]];
    node[path[path.length - 1]] = patch[key];
  });
};

// 造一个"户外/摩旅页"的最小运行环境: 行为方法 + 页面级配置 + 内存 setData
function makeVideoListCtx(behavior, apiRequest) {
  const patches = [];
  const ctx = Object.assign({}, behavior.methods, {
    listKey: 'outdoorActivities',
    cacheKey: 'outdoor_activities_v1',
    apiUrl: '/content/get_outdoor',
    defaultTitle: '未命名户外活动',
    api: { request: apiRequest }
  });
  ctx.data = Object.assign({}, behavior.data, {
    outdoorActivities: [], pageSize: 6, firstLoading: true, loadingMore: false
  });
  ctx.setData = makeSetData(ctx.data, patches);
  ctx.patches = patches;
  return ctx;
}

const BASE_ITEM = {
  id: 1, title: '徒步穿越', desc: '周末爬野山', poster: 'image/p1.png',
  category: 'outdoor', type: 'admin_users', likes: 3, favorites: 1, shares: 0
};

const APP_STUB = () => ({
  globalData: { userInfo: { id: 7, is_trusted: 0 }, isLoggedIn: true, appConfig: null, viewedNewsIds: {} },
  getAppConfig: () => null
});

test('专题列表(4.5.7): 秒开缓存后服务端补发的 video_url 必须真的进渲染层', async (t) => {
  if (!existsSync(VIDEO_BEHAVIOR) || !existsSync(UTIL)) {
    t.skip(`本机没有小程序源码 ${VIDEO_BEHAVIOR}`);
    return;
  }
  // 本地身份镜像是旧的(后台刚授权, 或只在「我的」页刷新过), 服务端按 token 判定为内部测试用户
  installStubs(APP_STUB());
  try {
    const util = require(UTIL);
    const behavior = require(VIDEO_BEHAVIOR);

    // ---- ① 秒开缓存: 与线上一致, 缓存里没有视频地址(缓存不存视频地址) ----
    const cached = [Object.assign({}, BASE_ITEM, { video_url: '', activated: false, isPlaying: false })];
    util.writeCache('outdoor_activities_v1', { list: cached, hasMore: false });

    let response = {
      code: 200,
      data: {
        list: [Object.assign({}, BASE_ITEM, { video_url: 'https://media.test/outdoor_1.mp4', can_watch_video: true })],
        total: 1
      }
    };
    const ctx = makeVideoListCtx(behavior, () => Promise.resolve(response));
    assert.equal(ctx.restoreListCache(), true, '秒开缓存要命中');
    assert.equal(ctx.data.outdoorActivities[0].video_url, '', '缓存里的视频地址按设计已被清空');

    // ---- ② 服务端回包带上视频地址: 列表必须被重写(指纹一旦漏掉 video_url 就会跳过) ----
    const restored = ctx.patches.length;   // 秒开那一次 setData 也是整表, 不算在内
    await ctx.fetchList(1);
    assert.equal(ctx.data.outdoorActivities[0].video_url, 'https://media.test/outdoor_1.mp4',
      '内部测试用户必须拿到视频地址, 否则播放按钮不出现、点封面也播不出来');
    assert.equal(ctx.patches.slice(restored).filter((p) => p && 'outdoorActivities' in p).length, 1,
      '视频地址进渲染层只有整表覆盖这一条路');

    // ---- ③ 非内部测试: 回包没有 video_url, 指纹一致 → 不写列表(省掉整表跨线程序列化) ----
    util.removeCache('outdoor_activities_v1');
    util.writeCache('outdoor_activities_v1', { list: cached, hasMore: false });
    response = { code: 200, data: { list: [Object.assign({}, BASE_ITEM)], total: 1 } };
    const plain = makeVideoListCtx(behavior, () => Promise.resolve(response));
    plain.restoreListCache();
    const plainRestored = plain.patches.length;
    await plain.fetchList(1);
    assert.equal(plain.patches.slice(plainRestored).filter((p) => p && 'outdoorActivities' in p).length, 0,
      '内容没变就不该整表 setData(列表页的既有优化不能被这次修复带坏)');

    util.flushCacheWrites();   // 把挂起的缓存写入落盘, 免得测试收工后定时器还在跑
  } finally {
    dropStubs();
  }
});

test('测试内容可见性(4.5.7): 服务端字段优先, 没有才回退本地身份', (t) => {
  if (!existsSync(TRUSTED)) {
    t.skip(`本机没有小程序源码 ${TRUSTED}`);
    return;
  }
  installStubs(APP_STUB());
  try {
    const trusted = require(TRUSTED);

    // 服务端说能看就以它为准 —— 后台刚改过身份时本地镜像是旧的
    assert.equal(trusted.canSeeTestContent({ can_watch_video: true }, { is_trusted: 0 }), true);
    assert.equal(trusted.canSeeTestContent({ can_watch_video: 1 }, { is_trusted: 0 }), true);
    assert.equal(trusted.canSeeTestContent({ can_watch_video: 0 }, { is_trusted: 1 }), false);
    // 备用后端(fastapi)没有这个字段 → 回退本地身份
    assert.equal(trusted.canSeeTestContent({}, { is_trusted: 1 }), true);
    assert.equal(trusted.canSeeTestContent(null, { is_trusted: 1 }), true);
    assert.equal(trusted.canSeeTestContent(null, { is_trusted: 0 }), false);
    assert.equal(trusted.canSeeTestContent(null, null), false, '未登录/无资料一律不可见');

    // 落值: 值没变就不 setData(tabBar 页 onShow 很频繁)
    const patches = [];
    const page = { data: { isTrusted: false } };
    page.setData = makeSetData(page.data, patches);
    assert.equal(trusted.applyToPage(page, { can_watch_video: true }), true);
    assert.equal(page.data.isTrusted, true);
    assert.equal(patches.length, 1);
    trusted.applyToPage(page, { can_watch_video: true });
    assert.equal(patches.length, 1, '可见性没变就不 setData');
    trusted.applyToPage(page, { can_watch_video: false });
    assert.equal(page.data.isTrusted, false);
    assert.equal(patches.length, 2);

    // 服务端资料 -> 本地资料: 服务端没给身份字段时沿用旧值(备用后端没有 is_trusted / test_applied)
    const merged = trusted.mergeTrustedFields({ id: 7, token: 'tok-1' }, { is_trusted: 1, test_applied: 0 });
    assert.equal(merged.is_trusted, 1);
    assert.equal(merged.test_applied, 0);
    assert.ok(!('token' in merged), 'token 不是用户资料, 不许落缓存');
  } finally {
    dropStubs();
  }
});

test('笔记详情(4.5.7): 测试内容可见性认服务端 can_watch_video, 不认过期的本地镜像', (t) => {
  if (!existsSync(DETAIL)) {
    t.skip(`本机没有小程序源码 ${DETAIL}`);
    return;
  }
  installStubs(APP_STUB());
  try {
    require(DETAIL);
    const detail = registered[0];
    assert.ok(detail && typeof detail.processNewsData === 'function', '详情页要能加载并暴露 processNewsData');

    const ctx = Object.assign({}, detail, {
      data: { isTrusted: false, userInfo: null },
      // 正文分段不是这条守卫要管的事, 桩掉
      processRichTextContent() {}
    });
    const patches = [];
    ctx.setData = makeSetData(ctx.data, patches);

    ctx.processNewsData({ id: 5, title: '雪线之上', content: '<p>正文</p>', image: '', likes: 1, favorites: 0, can_watch_video: true });
    assert.equal(ctx.data.isTrusted, true, '服务端说能看正文视频/留言区就要显示(本地镜像是普通用户也一样)');

    ctx.processNewsData({ id: 5, title: '雪线之上', content: '<p>正文</p>', image: '', likes: 1, favorites: 0, can_watch_video: 0 });
    assert.equal(ctx.data.isTrusted, false, '服务端说不能看就必须收起来(撤回内部测试身份后立即生效)');
  } finally {
    dropStubs();
  }
});
