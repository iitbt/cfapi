// 后台侧栏菜单自检: 超管专属项必须在**每一页**都稳定出现(漏传超管标识会让它时隐时现)
import assert from 'node:assert/strict';
import test from 'node:test';

import { NORMAL_WRITE_PATHS, SUPER_ONLY_WRITE_PATHS } from '../app/admin/lib/entities.js';
import { editShell } from '../app/admin/lib/partials.js';
import { NAV_GROUPS } from '../app/admin/lib/nav.js';
import { PAGE_ROUTES } from '../app/admin/pages/index.js';
import { statusKind } from '../app/admin/lib/status.js';
import { get, loginCookie, makeAdminEnv } from './admin_stub.mjs';

//: 菜单里声明 superOnly 的三项(数据库工具在 2.2.9 改名为「数据库管理」, 地址与权限键未变)
const SUPER_ONLY = ['管理员管理', '数据库管理', '素材库管理'];
//: 覆盖两种 adminLayout 调用风格(显式传 isSuper / 只摊 ctx)与错误页、工具页自身
const PAGES = ['/admin/dashboard', '/admin/users', '/admin/settings', '/admin/system_info',
  '/admin/news_manage', '/admin/banner_manage', '/admin/media_manage', '/admin/db_tools',
  '/admin/not_found_page'];

const navLabels = NAV_GROUPS.flatMap((group) => group.items).map((item) => item.title);

test('超管: 每一页的侧栏都带齐三个超管专属菜单', async () => {
  const { env } = makeAdminEnv({ role: 'super' });
  const cookie = await loginCookie(env);
  for (const path of PAGES) {
    const html = await (await get(path, env, cookie)).text();
    for (const label of SUPER_ONLY) {
      assert.ok(html.includes(`<span class="nav-label">${label}`), `${path} 的侧栏缺少「${label}」`);
    }
  }
});

test('非超管: 每一页的侧栏都不出现超管专属菜单', async () => {
  const { env } = makeAdminEnv({ role: 'normal' });
  const cookie = await loginCookie(env);
  for (const path of PAGES) {
    const html = await (await get(path, env, cookie)).text();
    for (const label of SUPER_ONLY) {
      assert.ok(!html.includes(`<span class="nav-label">${label}`), `${path} 不该出现「${label}」`);
    }
  }
});

test('页头不再有"返回控制面板"类按钮: 回控制面板只走侧栏菜单/logo（2.3.1）', async () => {
  const { env } = makeAdminEnv({ role: 'super' });
  env.ENABLE_SQL_TOOL = '1';
  const cookie = await loginCookie(env);
  const pages = ['/admin/settings', '/admin/system_info', '/admin/db_tools', '/admin/media_manage'];
  for (const path of pages) {
    const html = await (await get(path, env, cookie)).text();
    assert.ok(!html.includes('返回控制面板'), `${path} 不该再有"返回控制面板"按钮`);
    // 外壳里仍有两个导航元素指向控制面板(侧栏 logo + 「控制面板」菜单项), 那是应用导航、不是页面返回按钮;
    // 这里只要求**页面内容区**不再有回控制面板的链接
    const contentArea = html.slice(html.indexOf('<div class="content-wrap">'), html.indexOf('</main>'));
    assert.ok(contentArea.length > 0, `${path} 应能取到内容区`);
    assert.ok(!contentArea.includes('href="/admin/dashboard"'), `${path} 的内容区不该再有回控制面板的链接`);
  }
  // 编辑页外壳: 没给返回地址就**不渲染**返回按钮(否则会是一个 href="" 的死按钮)
  const shell = editShell({ action: '/admin/x', primaryLabel: '保存' });
  assert.ok(!shell.includes('bi-arrow-left'), '没给 backUrl 时不该有返回按钮');
  const withBack = editShell({ action: '/admin/x', backUrl: '/admin/news_manage', backLabel: '返回列表' });
  assert.ok(withBack.includes('href="/admin/news_manage"') && withBack.includes('返回列表'), '给了 backUrl 时照旧渲染');
});

test('登录名: 只摊 ctx 的页面(控制面板)顶栏也显示当前管理员', async () => {
  const { env } = makeAdminEnv({ role: 'super' });
  const cookie = await loginCookie(env);
  const html = await (await get('/admin/dashboard', env, cookie)).text();
  assert.ok(/bg-success-subtle text-success"><i[^>]*><\/i> admin<\/span>/.test(html), '顶栏应显示登录名');
});

test('首页精选管理已合并: 菜单与路由不再有它, 写权限与状态注册表照旧, 老地址落到 404 页', async () => {
  assert.ok(!navLabels.includes('首页精选管理'), '侧栏不该再有这个入口');
  assert.ok(!NAV_GROUPS.flatMap((group) => group.items).some((item) => item.href.includes('app_featured_manage')),
    '菜单里不该再有它的地址');
  assert.ok(!PAGE_ROUTES.some((route) => route.path.includes('app_featured_manage')), '页面路由表不该再有它');
  assert.ok(PAGE_ROUTES.some((route) => route.path === '/admin/app_home_manage'), '合并后的页面还在');
  // 2.3.8: 精选的**编辑页**也并进了 /admin/app_home_edit(?section=featured), 它的路由与写路径登记都删了;
  // 删除端点仍在(路径不变, 实现搬到了 pages/appHome.js), 权限登记照旧
  assert.ok(!PAGE_ROUTES.some((route) => route.path === '/admin/app_featured_edit'), '精选的编辑路由已删除');
  assert.ok(!NORMAL_WRITE_PATHS.includes('/admin/app_featured_edit'), '写路径清单里也不该再有它');
  assert.ok(PAGE_ROUTES.some((route) => route.path === '/admin/app_featured_delete'), '精选的删除端点还在');
  assert.ok(NORMAL_WRITE_PATHS.includes('/admin/app_featured_delete'));
  assert.ok(NORMAL_WRITE_PATHS.includes('/admin/app_home_edit'), '合并后的编辑入口有写权限(与板块入口同一路径)');
  assert.ok(statusKind('app_featured'), '精选的状态类型照旧');

  const { env } = makeAdminEnv({ role: 'super' });
  const cookie = await loginCookie(env);
  const res = await get('/admin/app_featured_manage', env, cookie);
  assert.equal(res.status, 404, '老地址不再是一个页面');
  assert.ok((await res.text()).includes('没有这个页面'));
  // 老的精选编辑地址现在也是 404(合并前是页面)
  const gone = await get('/admin/app_featured_edit?id=0', env, cookie);
  assert.equal(gone.status, 404, '已删除的精选编辑地址落到 404');
});

test('专题编辑已合并(2.7.0): 摩旅/户外两个编辑路由与写路径登记都删了, 只剩一个 topics_edit', async () => {
  assert.ok(PAGE_ROUTES.some((route) => route.path === '/admin/topics_edit' && route.methods.includes('POST')),
    '合并后的编辑页要能 GET 也能 POST');
  assert.ok(NORMAL_WRITE_PATHS.includes('/admin/topics_edit'), '合并后的编辑入口已登记写权限');
  for (const gone of ['/admin/motorcycle_edit', '/admin/outdoor_edit']) {
    assert.ok(!PAGE_ROUTES.some((route) => route.path === gone), `${gone} 路由已删除`);
    assert.ok(!NORMAL_WRITE_PATHS.includes(gone), `${gone} 写路径登记已删除`);
  }
  // 列表/预览/删除/行片段仍按项目分开(本次只合并编辑页)
  for (const kept of ['/admin/motorcycle_preview', '/admin/outdoor_preview', '/admin/motorcycle_delete', '/admin/outdoor_delete']) {
    assert.ok(PAGE_ROUTES.some((route) => route.path === kept), `${kept} 仍在`);
  }

  const { env } = makeAdminEnv({ role: 'super' });
  const cookie = await loginCookie(env);
  const gone = await get('/admin/motorcycle_edit?id=0', env, cookie);
  assert.equal(gone.status, 404, '旧的摩旅编辑地址落到 404');
});

test('用户笔记审核已彻底移除: 菜单、路由、权限清单、状态注册表都不再引用', async () => {
  assert.ok(!navLabels.includes('用户笔记审核'), '侧栏不该再有这个入口');
  assert.ok(!NAV_GROUPS.flatMap((group) => group.items).some((item) => item.href.includes('user_news')),
    '菜单里不该再有 user_news 的地址');
  assert.ok(!PAGE_ROUTES.some((route) => route.path.includes('user_news')), '页面路由表不该再有它');
  assert.ok(!SUPER_ONLY_WRITE_PATHS.includes('/admin/user_news_manage'), '权限清单里不该再登记它');
  assert.ok(!statusKind('user_news'), '状态注册表里不该再有 user_news');

  // 老地址落到统一 404 页(不是白屏, 也不是仍能打开)
  const { env } = makeAdminEnv({ role: 'super' });
  const cookie = await loginCookie(env);
  const res = await get('/admin/user_news_manage', env, cookie);
  assert.equal(res.status, 404);
  assert.ok((await res.text()).includes('没有这个页面'));
});
