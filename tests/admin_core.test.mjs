// 后台核心自检: 实体注册表(写路径归类 + 写入口自检)、工具函数(分页/回跳/幂等)
import assert from 'node:assert/strict';
import test from 'node:test';

import { auditAdminWriteRoutes, classifyWritePath } from '../app/admin/lib/entities.js';
import { buildListUrl, clampPage, firstScreenLimit, idemKey, isDuplicateSubmit } from '../app/admin/lib/utils.js';

test('写路径归类: 按路径边界匹配, 不误伤同前缀的其它路径', () => {
  assert.equal(classifyWritePath('/admin/users'), 'super');
  assert.equal(classifyWritePath('/admin/users_xxx'), 'unregistered', '/admin/users 不能误伤它');
  assert.equal(classifyWritePath('/admin/db_manage/exec'), 'super', '多命中时取最长的那条');
  assert.equal(classifyWritePath('/admin/banner_edit'), 'normal');
  assert.equal(classifyWritePath('/admin/admin_users'), 'route_super');
  assert.equal(classifyWritePath('/admin/login'), 'exempt');
  assert.equal(classifyWritePath('/admin'), 'exempt');
  assert.equal(classifyWritePath('/news/list'), 'unregistered');
});

test('写入口自检: 只有写方法参与, 未登记的被点名', () => {
  const result = auditAdminWriteRoutes([
    ['GET', '/admin/dashboard'],
    ['POST', '/admin/banner_edit'],
    ['POST', '/admin/brand_new_thing']
  ]);
  assert.equal(result.checked, 2, 'GET 不算写入口');
  assert.deepEqual(result.unregistered, ['/admin/brand_new_thing']);
});

test('分页口径: 首屏最多 3 页, 页码有硬上界', () => {
  assert.deepEqual(firstScreenLimit('2', 10, 50), [2, 20]);
  assert.deepEqual(firstScreenLimit('9', 10, 50), [3, 30], '更深的页码交给触底加载');
  assert.deepEqual(firstScreenLimit('x', 10, 5), [1, 10]);
  assert.equal(clampPage('99999'), 1000);
});

test('回列表 URL: 保留筛选与页码, 忽略空值与 all', () => {
  const url = buildListUrl('/admin/banner_manage', {
    message: '已更新',
    filters: { position: 'news', status: 'all', q: '' },
    page: 2
  });
  assert.ok(url.startsWith('/admin/banner_manage?message='));
  assert.ok(url.includes('position=news'));
  assert.ok(!url.includes('status='), 'all 表示不筛选, 不该出现在 URL 里');
  assert.ok(!url.includes('q='));
  assert.ok(url.endsWith('&page=2'));
});

test('幂等键: 同一动作同一参数得到同一个键', () => {
  assert.equal(idemKey('banner_delete', 7, 3), 'banner_delete:7:3');
  assert.notEqual(idemKey('banner_delete', 7, 3), idemKey('banner_delete', 7, 4));
});

test('幂等防重: 计数表不可用时放行(不误挡正常操作)', async () => {
  const env = { DB: { prepare() { throw new Error('d1 down'); } } };
  assert.equal(await isDuplicateSubmit(env, 'x', 10), false);
});
