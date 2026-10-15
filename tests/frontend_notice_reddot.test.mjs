// 小程序前端守卫(4.5.2 起; 4.5.3 补"同身份资料刷新不许抹红点"; 4.5.4 补"前台公告轮询"): 我的页「通知公告」红点的刷新时机 + 公告页已读补丁
//
// 为什么这条守卫放在后端测试里: 小程序工程没有 npm / 测试跑不起来(纯原生 WXML+JS),
// 而这两个页面文件与 app.js 都是**可被 Node 直接 require 的普通 CommonJS 模块** ——
// 用桩顶掉 getApp/wx/Page/App 就能真跑一遍逻辑。守卫本身仍是"静态检查"级别的证据,
// 真机效果要靠微信开发者工具; 但它能挡住最要命的两种回归: 红点又吃缓存(改了不生效)、已读后条目红点复活。
//
// 口径与 review_guard 一致: 本机没有前端源码(只部署后端)时**跳过**, 不算失败。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 前端目录: 与 fastapi 的守卫同一口径(允许 LYXJ_DIR 覆盖, 缺省 = 与 cfapi 同级的 xapp)
const XAPP = (process.env.LYXJ_DIR || fileURLToPath(new URL('../../xapp/', import.meta.url)))
  .replace(/[\\/]+$/, '') + '/';
const APP = XAPP + 'app.js';
const PROFILE = XAPP + 'pages/profile/profile.js';
const NOTICES = XAPP + 'subpackages/content/notices/notices.js';

const require = createRequire(new URL('../main.js', import.meta.url));

// 小程序全局对象的桩: 只实现被 require 到的那些方法, 不做任何真实 IO
function installMiniProgramStubs(handlers) {
  globalThis.wx = {
    getStorageSync: () => '', setStorageSync() {}, removeStorageSync() {}, clearStorageSync() {},
    showToast() {}, hideToast() {}, showLoading() {}, hideLoading() {}, showModal() {},
    navigateTo() {}, redirectTo() {}, navigateBack() {}, switchTab() {}, reLaunch() {},
    setNavigationBarTitle() {}, stopPullDownRefresh() {}, startPullDownRefresh() {},
    showNavigationBarLoading() {}, hideNavigationBarLoading() {}, setTabBarBadge() {},
    removeTabBarBadge() {}, setClipboardData() {}, getSystemInfoSync: () => ({ windowWidth: 375, statusBarHeight: 20 }),
    ...(handlers || {})
  };
  globalThis.getCurrentPages = () => [];
  globalThis.Behavior = (cfg) => cfg;
  globalThis.Component = (cfg) => cfg;
}

function dropMiniProgramStubs() {
  ['wx', 'getApp', 'App', 'Page', 'Behavior', 'Component', 'getCurrentPages'].forEach((key) => {
    delete globalThis[key];
  });
}

test('我的页红点(4.5.2): 每次刷新都重新问服务端, 只有状态翻转才重渲染菜单', async (t) => {
  if (!existsSync(PROFILE) || !existsSync(NOTICES)) {
    t.skip(`本机没有小程序源码 ${PROFILE}`);
    return;
  }

  const unreadCalls = [];
  let nextCount = 0;
  const appStub = {
    fetchNoticeUnread: () => {
      unreadCalls.push(Date.now());
      return Promise.resolve(nextCount);
    },
    isLoggedIn: () => true,
    globalData: { version: '4.5.2', api: { content: {} }, userInfo: null, isLoggedIn: true }
  };
  installMiniProgramStubs();
  globalThis.getApp = () => appStub;
  const loaded = {};
  globalThis.Page = (cfg) => {
    if (!loaded.profile) loaded.profile = cfg;
    else loaded.notices = cfg;
  };
  try {
    require(PROFILE);
    require(NOTICES);
    assert.ok(loaded.profile && loaded.notices, '两个页面都要能加载');
  } finally {
    dropMiniProgramStubs();
  }

  // ---- 红点刷新: 每次都真去问服务端(进我的页 onShow / 下拉刷新都会走到这里) ----
  let menuRenders = 0;
  const pageCtx = { data: {}, _noticesUnreadState: false, loadMenuItems() { menuRenders += 1; } };

  nextCount = 3;
  assert.deepEqual(await loaded.profile.loadNoticeRedDot.call(pageCtx), { ok: true, changed: true });
  assert.equal(unreadCalls.length, 1);
  assert.equal(menuRenders, 1, '红点由无到有要重渲染菜单');

  // 再进一次页面(仍未读 3): 仍要请求, 但状态没变就不重渲染
  assert.deepEqual(await loaded.profile.loadNoticeRedDot.call(pageCtx), { ok: true, changed: false });
  assert.equal(unreadCalls.length, 2, '每次 onShow 都要重新问服务端(否则管理员刚改完不生效)');
  assert.equal(menuRenders, 1);

  // 全部已读 → 红点消失
  nextCount = 0;
  assert.deepEqual(await loaded.profile.loadNoticeRedDot.call(pageCtx), { ok: true, changed: true });
  assert.equal(pageCtx._noticesUnreadState, false, '全部已读后红点要关掉');
  assert.equal(menuRenders, 2);

  // ---- 公告页已读补丁: 只改那一条, 并把结果写回秒开缓存 ----
  let patched = null;
  let saved = null;
  const noticesCtx = {
    listKey: 'noticeList',
    getList: () => [{ id: 9, is_read: false }, { id: 10, is_read: true }],
    setData(patch) { patched = patch; },
    writeListCache(list) { saved = list; }
  };
  loaded.notices._patchRowRead.call(noticesCtx, '9');
  assert.equal(patched.noticeList[0].is_read, true, '展开过的那条要标已读');
  assert.equal(patched.noticeList[0].id, 9, '不能动到别的行');
  assert.ok(Array.isArray(saved) && saved[0].is_read === true, '缓存也要一起改, 否则再进页面红点复活');

  patched = null;
  loaded.notices._patchRowRead.call(noticesCtx, '999');
  assert.equal(patched, null, '列表里没有这条就不 setData');
  loaded.notices._patchRowRead.call(noticesCtx, 10);
  assert.equal(patched, null, '本来就是已读就不 setData(数字 id 也要能对上)');
});

// 我的页菜单(4.5.8 起整体住在 pages/profile/profile.js, 不再由 app.js 下发/计算)
// 这条守卫专门挡"搬漏了"这一类回归: 4.5.8 首次搬迁时 getMenuItems 里引用的 normalizeMenuIcon /
// getMenuBuiltinIcon 没跟过来, 真机一进「我的」页就抛 is not a function(静态语法检查看不出来)
test('我的页菜单(4.5.8): loadMenuItems 走完整条 getMenuItems 链路, 顺序/红点/登录态/图标兜底都对', (t) => {
  if (!existsSync(PROFILE)) {
    t.skip(`本机没有小程序源码 ${PROFILE}`);
    return;
  }

  let unread = 3;
  const appStub = {
    isLoggedIn: () => true,
    isTrustedUser: () => false,
    getNoticeUnreadCount: () => unread,
    // app 层的图标归一化唯一实现: 这里照抄口径(空值/不像地址 → 兜底图)
    normalizeIconValue: (icon, fallback) => (icon && /[/.]/.test(String(icon)) ? String(icon) : fallback),
    globalData: { version: '4.5.8', api: { content: {} }, userInfo: null, isLoggedIn: true }
  };
  installMiniProgramStubs();
  globalThis.getApp = () => appStub;
  let profileCfg = null;
  globalThis.Page = (cfg) => { if (!profileCfg) profileCfg = cfg; };
  try {
    // Node 会缓存模块: 前一个用例已经 require 过 profile.js, 这里必须清掉缓存重新加载
    // (页面模块顶层就执行 getApp(), 不清缓存拿到的还是上一个用例的 Page 注册结果)
    delete require.cache[require.resolve(PROFILE)];
    require(PROFILE);
    assert.ok(profileCfg, 'profile.js 要能加载');
  } finally {
    dropMiniProgramStubs();
  }

  // getMenuItems 引用的方法必须都在这一个页面里(搬迁时最容易漏的就是这种跨文件引用)
  ['getMenuItems', 'loadMenuItems', 'normalizeMenuIcon', 'getMenuBuiltinIcon', 'onMenuIconError'].forEach((name) => {
    assert.equal(typeof profileCfg[name], 'function', `profile.js 必须自带 ${name}（菜单 4.5.8 起不再挂在 app.js 上）`);
  });

  // ctx 带上页面自身的方法: loadMenuItems 内部要调 this.getMenuItems
  const ctx = Object.assign({}, profileCfg, {
    data: { menuItems: [], debugMenuItems: [] },
    setData(patch) { Object.assign(this.data, patch); }
  });
  ctx.loadMenuItems();
  assert.deepEqual(ctx.data.menuItems.map((item) => item.key),
    ['likes', 'favorites', 'history', 'notices', 'privacy', 'about', 'apply_test', 'delete_account'],
    '菜单顺序就是 APP_MENU 数组顺序');
  assert.equal(ctx.data.menuItems[0].icon, '/images/like.png', '图标取自常量表');
  assert.equal(ctx.data.menuItems[6].icon, '/images/test.png', '未通过时申请测试用 test.png');
  assert.equal(ctx.data.menuItems[3].badge, true, '有未读公告时通知公告要带红点');

  // 内部测试身份 → 申请测试换成 test_a.png
  appStub.isTrustedUser = () => true;
  ctx.data.menuItems = [];
  ctx.loadMenuItems();
  assert.equal(ctx.data.menuItems[6].icon, '/images/test_a.png', '已通过时申请测试用 test_a.png');

  // 未登录 → need_login 的项一个都不该出现
  appStub.isLoggedIn = () => false;
  ctx.data.menuItems = [];
  ctx.loadMenuItems();
  assert.deepEqual(ctx.data.menuItems.map((item) => item.key), ['notices', 'privacy', 'about']);
  assert.equal(ctx.data.menuItems[0].badge, false, '未登录不该亮红点');

  // 图标地址坏了 → 按 key 回退到这一项自己的包内图标
  assert.equal(profileCfg.getMenuBuiltinIcon('notices'), '/images/Notice.png');
  assert.equal(profileCfg.normalizeMenuIcon('随手敲的abc', 'notices'), '/images/Notice.png', '不像地址的值要用本项兜底图');
  assert.equal(profileCfg.normalizeMenuIcon('/images/like.png', 'notices'), '/images/like.png', '正常包内路径原样用');
});

test('app.fetchNoticeUnread(4.5.2): 不再有 30 秒内存缓存, 并发只发一次请求', async (t) => {
  if (!existsSync(APP)) {
    t.skip(`本机没有小程序源码 ${APP}`);
    return;
  }

  const requests = [];
  let response = { code: 200, data: { unread_count: 2, ids: [5, 6] } };
  let appCfg = null;
  installMiniProgramStubs();
  globalThis.App = (cfg) => { appCfg = cfg; };
  try {
    require(APP);
    assert.ok(appCfg && typeof appCfg.fetchNoticeUnread === 'function', 'app.js 要能加载并暴露 fetchNoticeUnread');
  } finally {
    dropMiniProgramStubs();
  }

  appCfg.isLoggedIn = () => true;
  appCfg.api = { request: (opts) => { requests.push(opts); return Promise.resolve(response); } };

  // 连续两次(等价于两次 onShow): 必须发两次请求 —— 这就是 4.5.2 去掉 30 秒缓存的验收点
  assert.equal(await appCfg.fetchNoticeUnread(), 2);
  assert.equal(await appCfg.fetchNoticeUnread(), 2);
  assert.equal(requests.length, 2, '每次调用都要真请求(D1 上就是一条未读统计)');
  assert.equal(requests[0].method, 'POST');
  assert.ok(appCfg.getNoticeUnreadCount() > 0, '有未读时红点判定为亮');

  // 并发(下拉刷新会同时触发公告列表与未读数): 在途去重, 只发一次
  const before = requests.length;
  response = { code: 200, data: { unread_count: 0, ids: [] } };
  await Promise.all([appCfg.fetchNoticeUnread(), appCfg.fetchNoticeUnread()]);
  assert.equal(requests.length, before + 1, '并发调用共用同一次在途请求');
  assert.equal(appCfg.getNoticeUnreadCount() > 0, false, '未读清零后红点判定为灭');

  // 同身份的资料刷新不许抹掉红点(4.5.3): 「我的」页 onShow 会同时发"拉未读"与"拉资料"两条请求,
  // 资料那条回来要调 updateLoginStatus —— 它以前**无条件**把未读数清零, 于是谁后到谁说了算:
  // 资料后到就把刚亮起的红点抹成灭(现象: 后台发布公告后进「我的」页, 红点不出现或一闪就没)。
  // 根因是清零的条件写错了 —— 清零只该发生在"换人/首次登录"。
  appCfg.globalData.isLoggedIn = true;
  appCfg.globalData.userInfo = { id: 7 };
  response = { code: 200, data: { unread_count: 4, ids: [9] } };
  await appCfg.fetchNoticeUnread();
  assert.equal(appCfg.getNoticeUnreadCount() > 0, true);
  // updateLoginStatus 要落缓存, 所以这一段需要 wx 桩(上面 require 时那套已经在 finally 里撤掉了)
  installMiniProgramStubs();
  try {
    appCfg.updateLoginStatus({ id: 7, nickname: '老王' }, null);   // 同一身份, 只是资料刷新
    assert.equal(appCfg.getNoticeUnreadCount() > 0, true, '同一身份的资料刷新不该把红点抹掉');
    appCfg.updateLoginStatus({ id: 8, nickname: '张三' }, 'tok-2');   // 换账号: 旧读数属于上一个身份
    assert.equal(appCfg.getNoticeUnreadCount() > 0, false, '换账号后未读数必须归零');
  } finally {
    dropMiniProgramStubs();
  }

  // 服务端不可用 / 老版本: 记 0 灭掉红点, 不沿用旧值
  appCfg.api.request = () => Promise.reject(new Error('offline'));
  assert.equal(await appCfg.fetchNoticeUnread(), 0);

  // 未登录: 不发请求, 红点恒灭
  appCfg.isLoggedIn = () => false;
  const countBefore = requests.length;
  assert.equal(await appCfg.fetchNoticeUnread(), 0);
  assert.equal(requests.length, countBefore, '游客不该去打未读接口');
  assert.equal(appCfg.getNoticeUnreadCount() > 0, false, '未登录不亮红点');
});

test('公告轮询(4.5.4): 前台每 30 秒问一次, 切后台必须停', async (t) => {
  if (!existsSync(APP)) {
    t.skip(`本机没有小程序源码 ${APP}`);
    return;
  }
  // app.js 已被上面那条用例 require 过, 这里清掉模块缓存重新执行一遍, 拿到一个干净的对象
  delete require.cache[require.resolve(APP)];
  let appCfg = null;
  installMiniProgramStubs();
  globalThis.App = (cfg) => { appCfg = cfg; };
  try {
    require(APP);
    assert.ok(appCfg && typeof appCfg.startNoticeWatcher === 'function', 'app.js 要暴露 startNoticeWatcher');
  } finally {
    dropMiniProgramStubs();
  }

  // 假定时器替掉真的: 既不用等 30 秒, 也不会把测试进程钉住
  const timers = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, cleared: false };
    timers.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => { if (handle) handle.cleared = true; };

  installMiniProgramStubs();   // onShow 里的 touchLoginState 要读 storage
  let asked = 0;
  const realFetch = appCfg.fetchNotices;
  appCfg.fetchNotices = () => { asked += 1; return Promise.resolve([]); };
  try {
    appCfg.onShow();
    assert.equal(timers.length, 1, '回前台要挂上公告轮询');
    assert.equal(timers[0].ms, 30000, '30 秒一拍(fetchNotices 自己还有 60 秒静默刷新节流)');
    assert.equal(appCfg._noticeWatcher, timers[0]);
    timers[0].fn();
    assert.equal(asked, 1, '到点要真去拉一次公告 —— 否则"页面不动也能收到"是空的');

    // 冷启动 App.onShow 会连着触发: 只能留一个定时器, 不许叠加
    appCfg.onShow();
    assert.equal(timers.length, 2);
    assert.equal(timers[0].cleared, true, '重复 onShow 要先清掉旧的定时器');
    assert.equal(appCfg._noticeWatcher, timers[1]);

    appCfg.onHide();
    assert.equal(timers[1].cleared, true, '切后台必须停轮询(后台发请求纯属浪费流量与电量)');
    assert.equal(appCfg._noticeWatcher, null);
  } finally {
    appCfg.fetchNotices = realFetch;
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    dropMiniProgramStubs();
  }
});
