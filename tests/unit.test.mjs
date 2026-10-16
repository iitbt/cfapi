// 基础工具自检: MD5 标准向量、时间口径、素材地址、上传命名与落目录、净化、窗口计算
import assert from 'node:assert/strict';
import test from 'node:test';

import { routeTable } from '../main.js';
import { md5Hex } from '../app/core/md5.js';
import { beijingNow, nowEpoch, toEpoch, windowStart } from '../app/core/timeutil.js';
import { assetUrl, iconAssetUrl } from '../app/core/media_scheme.js';
import { checkObjectKey, isRootTreePath, listLevel, listNewsMedia, listUnder, mediaContentType, normRel, relPathsIn } from '../app/core/storage.js';
import { safeRelPath, safeTargetDir, saveUpload } from '../app/admin/lib/mediaUpload.js';
import { parentOf } from '../app/admin/lib/mediaBrowse.js';
import { absolutizeMedia, sanitizeHtml } from '../app/core/sanitize.js';
import { hashPassword, needsRehash, verifyDummy, verifyPassword } from '../app/admin/lib/password.js';
import { IN_CHUNK_SIZE, chunkIds, marksOf } from '../app/core/db.js';
import { QUOTAS } from '../app/core/ratelimit.js';
import { redactText } from '../app/core/logging.js';
import { makeAdminEnv } from './admin_stub.mjs';

test('MD5 与标准向量一致(新用户 username 命名依赖它)', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
});

test('日志脱敏: 带引号的敏感值也必须打码', () => {
  // SQL 里的字面量会被审计日志记进去, 这条漏了等于没脱敏(引号保留, 便于继续读日志)
  assert.equal(redactText("password = 'abc123'"), "password = '***'");
  assert.equal(redactText('token="xyz"'), 'token="***"');
  assert.ok(!redactText("session: 'zzz'").includes('zzz'));
  assert.equal(redactText('SELECT id FROM news'), 'SELECT id FROM news');
});

test('时间固定东八区且与库内字符串口径一致', () => {
  assert.match(beijingNow(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // 2026-10-04 12:00:00(+08:00) == 2026-10-04T04:00:00Z
  assert.equal(toEpoch('2026-10-04 12:00:00'), Date.UTC(2026, 9, 4, 4, 0, 0) / 1000);
  assert.equal(toEpoch(''), 0);
  assert.equal(toEpoch(null), 0);
  assert.equal(windowStart(60, new Date('2026-10-04T04:00:30Z')) % 60, 0);
  assert.equal(nowEpoch() > 1700000000, true);
});

test('素材地址: 相对路径拼媒体域, 绝对地址与包内图标原样', () => {
  const env = { MEDIA_BASE: 'https://storage.250036.xyz/' };
  assert.equal(assetUrl(env, 'news_uploads/a.png'), 'https://storage.250036.xyz/news_uploads/a.png');
  assert.equal(assetUrl(env, '/news_uploads/a.png'), 'https://storage.250036.xyz/news_uploads/a.png');
  assert.equal(assetUrl(env, 'https://gitee.com/x/y.png'), 'https://gitee.com/x/y.png');
  assert.equal(assetUrl(env, 'wxfile://tmp/x.png'), 'wxfile://tmp/x.png');
  assert.equal(assetUrl(env, ''), '');
  assert.equal(assetUrl(env, '', '/images/user.jpg'), '/images/user.jpg');
  assert.equal(iconAssetUrl(env, '/images/like.png'), '/images/like.png');
  assert.equal(iconAssetUrl(env, 'news_uploads/icon.png'), 'https://storage.250036.xyz/news_uploads/icon.png');
});

test('上传命名(2.4.0/2.4.2): 相对路径清洗挡住路径穿越/空段/控制字符/URL 破坏字符, 正常字符保留', () => {
  assert.equal(safeRelPath('folder/sub/a.png'), 'folder/sub/a.png', '子目录保留');
  assert.equal(safeRelPath('../../etc/passwd'), 'etc/passwd', '.. 被丢掉, 出不了素材目录');
  assert.equal(safeRelPath('/a//b/c.png'), 'a/b/c.png', '空段/前导斜杠去掉');
  assert.equal(safeRelPath('a\\b\\c.png'), 'a/b/c.png', '反斜杠归一');
  assert.equal(safeRelPath('C:\\素材\\a.png'), '素材/a.png', '盘符段剥掉');
  assert.equal(safeRelPath('folder/中文 名字(1).png'), 'folder/中文 名字(1).png', '中文/空格/括号保留');
  assert.equal(safeRelPath('a/./b.png'), 'a/b.png', '单点段去掉');
  assert.equal(safeRelPath('x'.repeat(400) + '/a.png').length <= 310, true, '总长封顶');
  // 2.4.2: 公开域是 `${MEDIA_BASE}/${路径}` 直拼 —— `#` 后面会被当锚点、`%` 会被当转义、`?` 会被当查询串
  assert.equal(safeRelPath('素材/图#1.png'), '素材/图_1.png', '# 换成 _');
  assert.equal(safeRelPath('素材/100%图?.png'), '素材/100_图_.png', '% 与 ? 换成 _');
  assert.equal(safeRelPath(''), '', '空串');
});

test('目标路径校验(2.4.3/2.4.4/2.6.5): 干净的相对目录都收(不再只认本入口根), 非法路径一律拒绝', () => {
  // 不传/留空 = 默认根目录(老调用方行为一字不变)
  assert.deepEqual(safeTargetDir('', 'image/'), { ok: true, dir: 'image/' });
  assert.deepEqual(safeTargetDir(undefined, 'video/'), { ok: true, dir: 'video/' });
  assert.equal(safeTargetDir('   ', 'image/').dir, 'image/', '纯空白 = 默认');
  // 2.4.4: `/` = 存储桶最外层(交到拼 key 时就是"空前缀"), 图片与视频入口都允许
  assert.deepEqual(safeTargetDir('/', 'image/'), { ok: true, dir: '' }, '根目录');
  assert.deepEqual(safeTargetDir('/'.repeat(1), 'video/'), { ok: true, dir: '' });
  assert.equal(safeTargetDir('//', 'image/').ok, false, '两个斜杠不是根目录写法');
  // 合法: 根本身、子目录、漏写尾斜杠、反斜杠(归一)、中文与空格
  assert.equal(safeTargetDir('image/', 'image/').dir, 'image/');
  assert.equal(safeTargetDir('image/2026-10/', 'image/').dir, 'image/2026-10/');
  assert.equal(safeTargetDir('image/2026-10', 'image/').dir, 'image/2026-10/', '自动补尾斜杠');
  assert.equal(safeTargetDir('image\\素材\\相册', 'image/').dir, 'image/素材/相册/', '分隔符归一');
  assert.equal(safeTargetDir('image/中文 目录(2026)/', 'image/').dir, 'image/中文 目录(2026)/', '正常字符保留');
  // 2.6.5: 不再要求"必须写在本入口素材根下面" —— 2.4.4 起根目录就能写, 「其它（手动填写）」也只能填本入口根
  // 就与"支持根目录上传"自相矛盾(线上报的就是 "图片的目标路径必须以 image/ 开头")。现在只拦非法路径。
  assert.equal(safeTargetDir('news_uploads/2026-10/', 'image/').dir, 'news_uploads/2026-10/', '历史素材目录也能手填');
  assert.equal(safeTargetDir('video/x/', 'image/').dir, 'video/x/', '跨入口不再由后端拦(代价见注释: 素材库按 kind 列举, 可能列不出来)');
  assert.equal(safeTargetDir('素材/相册/', 'video/').dir, '素材/相册/', '根下自定义目录同样放行');
  assert.equal(safeTargetDir('avatar/x/', 'image/').dir, 'avatar/x/', '站内自有目录也只是一条普通路径, 由页面用它自己决定要不要给选项');
  // 路径穿越 / 绝对路径 / 盘符 / 空段 / 单点 / 特殊字符 / 超长: 一律拒绝(而不是静默改写)
  for (const bad of ['image/../video/', '../image/', '/image/x/', 'C:/image/x/', 'image//x/', 'image/./x/', 'image/x#1/', 'image/ my /', `image/${'x'.repeat(400)}/`]) {
    const result = safeTargetDir(bad, 'image/');
    assert.equal(result.ok, false, `${bad} 应被拒`);
    assert.match(result.message, /目标路径/, '要给明确原因');
  }
});

test('上传落目录(2.4.2): 相对路径的目录部分在两种命名模式下都保留', async () => {
  const { env, state } = makeAdminEnv({ role: 'super' });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const save = (file, options) => saveUpload(env, Object.assign({ file }, options));

  // keep: 目录与文件名都照原样(含最外层那层文件夹名, 前端已不再剥)
  const kept = await save(new File([png], '图.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep', relPath: '素材/子目录/图.png' });
  assert.equal(kept.url, 'image/素材/子目录/图.png', 'keep: 整棵目录 + 原名');

  // auto: 目录保留, 只把文件名换成 <用途>_<时间戳>.ext
  const auto = await save(new File([mp4], '片子.mp4', { type: 'video/mp4' }),
    { purpose: 'video', nameMode: 'auto', relPath: '素材/子目录/片子.mp4' });
  assert.match(auto.url, /^video\/素材\/子目录\/video_\d+\.mp4$/, 'auto: 目录保留、文件名重生成');

  // 直接放在所选文件夹里的文件(rel 只有一层)落在该文件夹下, 不在素材目录根
  const root = await save(new File([png], 'a.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep', relPath: '素材/a.png' });
  assert.equal(root.url, 'image/素材/a.png', '根目录文件落 image/<所选文件夹>/');

  // 不带 rel_path 的调用方(编辑页/弹窗)行为不变: keep 回退到纯文件名, auto 直接落素材目录
  const plain = await save(new File([png], '封面.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep' });
  assert.equal(plain.url, 'image/封面.png', '无 rel_path: 用 file.name');
  const plainAuto = await save(new File([png], '封面.png', { type: 'image/png' }), { purpose: 'cover' });
  assert.match(plainAuto.url, /^image\/cover_\d+\.png$/, '无 rel_path 的 auto: 落素材目录根');

  // 同名文件在不同子目录里互不影响(各自用原名, 不互相顺延); 同目录同名才顺延
  const sameA = await save(new File([png], '图.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep', relPath: '相册一/图.png' });
  const sameB = await save(new File([png], '图.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep', relPath: '相册二/图.png' });
  assert.equal(sameA.url, 'image/相册一/图.png');
  assert.equal(sameB.url, 'image/相册二/图.png');
  const twice = await save(new File([png], '图.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep', relPath: '相册一/图.png' });
  assert.equal(twice.url, 'image/相册一/图_1.png', '同目录重名才顺延 _1');
  assert.equal(state.objects.has('image/相册一/图.png'), true, '不覆盖已有对象');
});

test('根目录素材(2.4.4/2.4.5): 根目录树的范围(裸文件名与根下自定义目录), 归一与引用抽取成对', () => {
  assert.equal(isRootTreePath('logo.png'), true);
  assert.equal(isRootTreePath('素材/子/图.png'), true, '根下自定义目录里的文件也算(2.4.5)');
  // 已知前缀一律不算"根目录素材": 素材目录由各自前缀收, 站内自有目录(头像/站点图标)不进素材库
  assert.equal(isRootTreePath('image/a.png'), false);
  assert.equal(isRootTreePath('news_uploads/a.png'), false);
  assert.equal(isRootTreePath('avatar/u.png'), false);
  assert.equal(isRootTreePath('avatar_uploads/u.png'), false);
  assert.equal(isRootTreePath('images/icon.png'), false);
  assert.equal(isRootTreePath('a//b.png'), false, '空段不算');
  assert.equal(isRootTreePath('../x.png'), false, '穿越不算');
  assert.equal(isRootTreePath(''), false);
  // normRel: 库内相对记录值 = 素材目录下的路径 或 根目录树里的路径(都要带图片/视频扩展名)
  assert.equal(normRel('image/a.png'), 'image/a.png', '老口径不变');
  assert.equal(normRel('logo.png'), 'logo.png', '根目录裸文件名');
  assert.equal(normRel('素材/子/图.png'), '素材/子/图.png', '根目录树里的路径(2.4.5)');
  assert.equal(normRel('/logo.png'), 'logo.png', '前导斜杠剥掉');
  assert.equal(normRel('https://host/logo.png'), '', '整串绝对地址不认');
  assert.equal(normRel('images/logo.png'), '', '站内自有目录不认');
  assert.equal(normRel('index.html'), '', '非素材扩展名不认(不能变成万能删除入口)');
  assert.equal(normRel('素材/说明.txt'), '', '根目录树下也要看扩展名');
  // 引用抽取: 根目录那块只能"按调用方给的候选名单"命中, 不从任意文本里猜
  assert.deepEqual(relPathsIn('<p><img src="logo.png"></p>'), [], '不给名单时不猜');
  assert.deepEqual(relPathsIn('<p><img src="logo.png"></p>', ['logo.png']), ['logo.png'], '给了名单就命中');
  assert.deepEqual(relPathsIn('<p><img src="image/a.png"></p><p><img src="logo.png"></p>', ['logo.png']),
    ['image/a.png', 'logo.png'], '两种形态同时命中');
  assert.deepEqual(relPathsIn('看 素材/子/图.png 这张', ['素材/子/图.png']), ['素材/子/图.png'], '带目录的也能命中');
});

test('引用判定(2.6.5): 根目录素材按"整段路径"命中, 同名后缀/子串不再误判', () => {
  // 线上报的原始例子: 素材实际引用的是 image/food/2017-2018.jpg, 根目录的 2018.jpg 却被标成"被引用"
  // (旧实现是 text.includes('2018.jpg') —— 子串命中)
  assert.deepEqual(relPathsIn('image/food/2017-2018.jpg', ['2018.jpg']), ['image/food/2017-2018.jpg'],
    '只认真实那个对象(旧实现会在同一个字段里再带出根目录的 2018.jpg —— 子串命中)');
  assert.deepEqual(relPathsIn('<p><img src="image/food/2017-2018.jpg"></p>', ['2018.jpg']), ['image/food/2017-2018.jpg'],
    '富文本里同样不带出根目录那个');
  assert.deepEqual(relPathsIn('image/2018.jpg', ['2018.jpg']), ['image/2018.jpg'],
    '另一个目录下的同名文件不算(根目录的 2018.jpg 是另一个对象)');
  assert.deepEqual(relPathsIn('image/food/2018.jpg', ['food/2018.jpg']), ['image/food/2018.jpg'],
    '根下自定义目录的名字也不能靠"子串"蹭上');
  // 真引用要照旧命中
  assert.deepEqual(relPathsIn('2018.jpg', ['2018.jpg']), ['2018.jpg'], '裸文件名');
  assert.deepEqual(relPathsIn('<p><img src="2018.jpg"></p>', ['2018.jpg']), ['2018.jpg'], 'HTML 属性里');
  assert.deepEqual(relPathsIn('https://storage.250036.xyz/2018.jpg', ['2018.jpg']), ['2018.jpg'], '绝对地址');
  assert.deepEqual(relPathsIn('https://storage.250036.xyz/a/2018.jpg', ['2018.jpg']), [],
    '绝对地址的目录不同: 那是 a/2018.jpg 这个对象');
  assert.deepEqual(relPathsIn('["活动 照片.jpg","2018.jpg"]', ['活动 照片.jpg', '2018.jpg']),
    ['活动 照片.jpg', '2018.jpg'], '名字里带空格也认(JSON 数组形态)');
  assert.deepEqual(relPathsIn('看 活动 照片.jpg 这张', ['活动 照片.jpg']), ['活动 照片.jpg'], '正文里带空格的名字');
});

test('对象键校验(2.4.6): 桶浏览器只收"干净"的键, 清洗结果必须与输入一致', () => {
  assert.deepEqual(checkObjectKey('image/a.png'), { ok: true, key: 'image/a.png' });
  assert.equal(checkObjectKey('素材/子/图.png').key, '素材/子/图.png', '中文与多级路径都行');
  assert.equal(checkObjectKey('assets/x.js').key, 'assets/x.js', '任意顶层目录(不限于素材目录)');
  assert.equal(checkObjectKey('image/2026-10', { asDir: true }).key, 'image/2026-10/', '目录形态自动补尾斜杠');
  assert.equal(checkObjectKey('').ok, false, '空串');
  assert.equal(checkObjectKey('   ').ok, false, '空白');
  for (const bad of ['a/../b.png', '../a.png', 'a//b.png', '/a.png', 'a/b.png#x', 'a/b.png?x', 'a/100%b.png', 'C:/x.png', './a.png']) {
    assert.equal(checkObjectKey(bad).ok, false, `${bad} 应被拒`);
  }
  assert.equal(checkObjectKey('x'.repeat(301)).ok, false, '超长(>300 字符)拒绝');
});

test('listUnder(2.4.6): 列前缀下的对象(不折叠目录), 目录级移动/删除靠它', async () => {
  const { env } = makeAdminEnv({
    role: 'super',
    mediaObjects: [
      { key: '素材/a.png', size: 1, uploaded: '2026-10-09T00:00:00Z' },
      { key: '素材/子/b.png', size: 2, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'image/c.png', size: 3, uploaded: '2026-10-09T00:00:00Z' }
    ]
  });
  const under = await listUnder(env, '素材/');
  assert.deepEqual(under.objects.map((one) => one.key).sort(), ['素材/a.png', '素材/子/b.png'],
    '整棵前缀下的对象都要列出来(含更深一层)');
  assert.equal(under.truncated, false);
  assert.deepEqual((await listUnder(env, 'image/')).objects.map((one) => one.key), ['image/c.png']);
});

test('单层列举(2.7.3): 目录与对象共享 limit, 截断时继续翻页把目录收全', async () => {
  // 摆 1000 个"字典序在目录之前"的根下对象, 目录排在后面 —— 只取第一页的话这三个目录一个都看不见,
  // 界面表现就是"文件夹显示不全"(真 R2 的 limit 是对象+目录合计配额)
  const mediaObjects = [];
  for (let i = 0; i < 1000; i += 1) {
    mediaObjects.push({ key: `a${String(i).padStart(4, '0')}.png`, size: 1, uploaded: '2026-10-01T00:00:00Z' });
  }
  for (const key of ['zadmin/vendor/fonts/a.woff2', 'zimage/a.png', 'zvideo/a.mp4']) {
    mediaObjects.push({ key: key, size: 1, uploaded: '2026-10-01T00:00:00Z' });
  }
  const { env } = makeAdminEnv({ role: 'super', mediaObjects: mediaObjects });

  const level = await listLevel(env, '', { limit: 1000 });
  assert.equal(level.truncated, true, '这一层确实超过单次上限');
  assert.deepEqual(level.folders.map((one) => one.key), ['zadmin/', 'zimage/', 'zvideo/'],
    '目录必须收全(翻页取到最后一页为止)');
  assert.equal(level.objects.length, 1000, '对象仍按第一页封顶, 口径与改前一致');

  // 小目录不受影响: 一层就那么几项时照常一次列全
  const small = await listLevel(env, 'zadmin/', { limit: 1000 });
  assert.deepEqual(small.folders.map((one) => one.key), ['zadmin/vendor/']);
  assert.equal(small.truncated, false);
});

test('上一级 parentOf(2.7.2): 目录前缀与对象键都要给出真的上一层', () => {
  // 治理页的「上一级」把**带尾斜杠**的目录前缀交给它: 原先切在最后那个斜杠上、返回自身, 点了停在原地
  assert.equal(parentOf('image/'), '', '一级目录的上一层是存储桶根目录');
  assert.equal(parentOf('image/food/'), 'image/', '多级目录退一层');
  assert.equal(parentOf('素材/子/'), '素材/', '中文目录同样退一层');
  assert.equal(parentOf(''), '', '根目录没有上一层(还是根目录, 页面因此不渲染按钮)');
  // 对象键的结果不变(详情页的「所在层」与改名页的「目标目录」都靠它)
  assert.equal(parentOf('image/a.png'), 'image/');
  assert.equal(parentOf('logo.png'), '', '根下对象就在存储桶根目录');
});

test('根目录素材(2.4.5): 按真 R2 的 delimiter 语义也列得出来(对象/目录两条路都覆盖)', async () => {
  const objects = [
    { key: 'logo.png', size: 1, uploaded: '2026-10-09T00:00:00Z' },
    { key: '素材/顶图.png', size: 1, uploaded: '2026-10-08T00:00:00Z' },
    { key: '素材/子/深图.png', size: 1, uploaded: '2026-10-07T00:00:00Z' },
    { key: 'image/a.png', size: 1, uploaded: '2026-10-06T00:00:00Z' },
    { key: 'image/sub/b.png', size: 1, uploaded: '2026-10-05T00:00:00Z' },
    { key: 'avatar/u.png', size: 1, uploaded: '2026-10-04T00:00:00Z' }
  ];
  // 按 Cloudflare R2 的**真实语义**实现 list: prefix 过滤 + delimiter 折叠
  // (根下对象进 objects、目录进 delimitedPrefixes) —— 桩 R2 忽略 delimiter, 这条补上那条路
  const env = {
    STORAGE: {
      async list(options = {}) {
        const prefix = String(options.prefix || '');
        const delimiter = String(options.delimiter || '');
        const matched = objects.filter((one) => one.key.startsWith(prefix));
        if (!delimiter) return { objects: matched, truncated: false };
        const direct = [];
        const folders = new Set();
        for (const one of matched) {
          const rest = one.key.slice(prefix.length);
          const at = rest.indexOf(delimiter);
          if (at < 0) direct.push(one);
          else folders.add(prefix + rest.slice(0, at + delimiter.length));
        }
        return { objects: direct, delimitedPrefixes: Array.from(folders), truncated: false };
      },
      async head() { return null; }
    }
  };
  const images = await listNewsMedia(env, 'image');
  assert.deepEqual(images.items.map((one) => one.path).sort(),
    ['image/a.png', 'image/sub/b.png', 'logo.png', '素材/子/深图.png', '素材/顶图.png'],
    '根下裸文件 + 根下目录(经 delimitedPrefixes 发现) + 素材目录(含更深子目录)');
  assert.ok(!images.items.some((one) => one.path.startsWith('avatar/')), '站内自有目录仍被排除');
});

test('根目录素材(2.4.5): 列举覆盖"根下整棵树", 且不与素材目录重复', async () => {
  const { env } = makeAdminEnv({
    role: 'super',
    mediaObjects: [
      { key: 'logo.png', size: 10, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'clip.mp4', size: 20, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'note.txt', size: 5, uploaded: '2026-10-09T00:00:00Z' },
      { key: 'image/a.png', size: 30, uploaded: '2026-10-08T00:00:00Z' },
      // 2.4.5 的关键场景: "根目录 + 选文件夹"传出来的对象(键带斜杠, 不属于任何素材前缀)
      { key: '素材/顶图.png', size: 40, uploaded: '2026-10-07T00:00:00Z' },
      { key: '素材/子/深图.png', size: 50, uploaded: '2026-10-06T00:00:00Z' },
      { key: '素材/子/片段.mp4', size: 60, uploaded: '2026-10-05T00:00:00Z' },
      // 站内自有目录: 不该混进素材库
      { key: 'avatar/u.png', size: 70, uploaded: '2026-10-04T00:00:00Z' },
      { key: 'images/icon.png', size: 80, uploaded: '2026-10-03T00:00:00Z' }
    ]
  });
  const images = await listNewsMedia(env, 'image');
  const videos = await listNewsMedia(env, 'video');
  assert.deepEqual(images.items.map((one) => one.path).sort(),
    ['image/a.png', 'logo.png', '素材/子/深图.png', '素材/顶图.png'], '图片: 根目录整棵树 + 素材目录, 不重复');
  assert.deepEqual(videos.items.map((one) => one.path).sort(), ['clip.mp4', '素材/子/片段.mp4'], '视频同理');
  const rootFile = images.items.find((one) => one.path === '素材/子/深图.png');
  assert.equal(rootFile.dir, '', '根目录那块的 dir 是空串(列表显示"根目录")');
  assert.equal(rootFile.name, '素材/子/深图.png', 'name 是相对路径(结构可见)');
  assert.equal(images.items.filter((one) => one.path === 'image/a.png').length, 1, '素材目录里的文件只出现一次');
  assert.ok(!images.items.some((one) => one.path === 'note.txt'), '非图片/视频扩展名不进清单');
  assert.ok(!images.items.some((one) => one.path.startsWith('avatar/') || one.path.startsWith('images/')),
    '站内自有目录不进素材库');
});

test('上传落目录(2.4.3): 目标路径作为根, 文件夹结构在其下继续保留', async () => {
  const { env, state } = makeAdminEnv({ role: 'super' });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const save = (file, options) => saveUpload(env, Object.assign({ file }, options));

  // 不操作时行为与以前完全一致: 图片落 image/ 根、视频落 video/ 根
  const plainImage = await save(new File([png], 'a.png', { type: 'image/png' }), { purpose: 'cover' });
  assert.match(plainImage.url, /^image\/cover_\d+\.png$/, '不传 targetDir: 仍落 image/ 根');
  const plainVideo = await save(new File([mp4], 'a.mp4', { type: 'video/mp4' }), { purpose: 'video' });
  assert.match(plainVideo.url, /^video\/video_\d+\.mp4$/, '不传 targetDir: 仍落 video/ 根');

  // 目标路径 + 文件夹结构**叠加**: key = <target_dir>/<rel_path 的目录>/<文件名>
  const nested = await save(new File([png], '图.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep', targetDir: 'image/2026-10/', relPath: '素材/相册/图.png' });
  assert.equal(nested.url, 'image/2026-10/素材/相册/图.png', '目标路径当根, 子目录结构照带');
  const nestedAuto = await save(new File([mp4], '片子.mp4', { type: 'video/mp4' }),
    { purpose: 'video', nameMode: 'auto', targetDir: 'video/活动', relPath: '素材/片子.mp4' });
  assert.match(nestedAuto.url, /^video\/活动\/素材\/video_\d+\.mp4$/, '自动生成同样保留目标路径与子目录');
  // 只选目标路径、不用文件夹上传 → 直接落目标路径下
  const direct = await save(new File([png], '图.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep', targetDir: 'image/2026-10/' });
  assert.equal(direct.url, 'image/2026-10/图.png');

  // 2.6.5: 任意干净的相对目录都能手填(跨入口 / 历史素材目录 / 根下自建目录), 落到哪就是哪
  const manual = await save(new File([png], '图.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep', targetDir: 'news_uploads/2026-10/' });
  assert.equal(manual.url, 'news_uploads/2026-10/图.png', '手填历史素材目录: 不再被"必须以 image/ 开头"挡住');
  const cross = await save(new File([png], '图.png', { type: 'image/png' }),
    { purpose: 'cover', nameMode: 'keep', targetDir: 'video/x/' });
  assert.equal(cross.url, 'video/x/图.png', '跨入口也不再拦(代价: 素材库按 kind 列举, 可能列不出来)');

  // 非法目标路径: 拒绝且一个对象都不写(穿越 / 绝对路径 / 空段)
  const before = state.objects.size;
  for (const bad of ['image/../video/', '/image/x/', 'image//x/', 'image/./x/']) {
    const result = await save(new File([png], 'a.png', { type: 'image/png' }), { purpose: 'cover', targetDir: bad });
    assert.equal(result.ok, false, `${bad} 应被拒`);
  }
  assert.equal(state.objects.size, before, '被拒的请求不该写任何对象');
});

test('上传落目录(2.4.0): purpose=auto 按内容分流, 图片进 image/、视频进 video/', async () => {
  const { env, state } = makeAdminEnv({ role: 'super' });
  // 一个最小合法 PNG(嗅探只看头 4 字节)与一个 ISO-BMFF 视频头
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const imageFile = new File([png], 'a.png', { type: 'image/png' });
  const videoFile = new File([mp4], 'clip.mp4', { type: 'video/mp4' });

  const savedImage = await saveUpload(env, { file: imageFile, purpose: 'auto', nameMode: 'keep', relPath: 'sub/a.png' });
  assert.equal(savedImage.ok, true, JSON.stringify(savedImage));
  assert.equal(savedImage.url, 'image/sub/a.png', '图片进 image/ 且保留子目录');
  assert.equal(savedImage.kind, 'image');

  const savedVideo = await saveUpload(env, { file: videoFile, purpose: 'auto', nameMode: 'keep', relPath: 'sub/clip.mp4' });
  assert.equal(savedVideo.url, 'video/sub/clip.mp4', '视频进 video/');

  // 内容与扩展名不符时以**内容**为准(扩展名保留原名): 前端按扩展名预判会误伤 .mov/.mkv
  const oddVideo = await saveUpload(env, { file: new File([mp4], 'odd.png', { type: '' }), purpose: 'auto' });
  assert.equal(oddVideo.kind, 'video');
  assert.match(oddVideo.url, /^video\/video_\d+\.png$/, '目录按内容, 名字仍是原名扩展名');

  // 白名单之外的文件直接拒(哪怕是 auto 模式)
  const bad = await saveUpload(env, { file: new File([png], 'a.txt', { type: 'text/plain' }), purpose: 'auto' });
  assert.equal(bad.ok, false);

  // 两个都不像 → 拒绝
  const junk = await saveUpload(env, { file: new File([new Uint8Array([1, 2, 3, 4])], 'x.png'), purpose: 'auto' });
  assert.equal(junk.ok, false);
  assert.equal(state.puts.length, 3, '只有三次成功写入');
});

test('上传: 写入 R2 的 Content-Type 按扩展名定, 不采信客户端声明的 file.type', async () => {
  const { env, state } = makeAdminEnv({ role: 'super' });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // 浏览器可以把 type 报成任意值; 公开域会照 Content-Type 下发, 所以只能信嗅探 + 扩展名
  const saved = await saveUpload(env, { file: new File([png], 'a.png', { type: 'text/html' }), purpose: 'auto' });
  assert.equal(state.objects.get(saved.url).httpMetadata.contentType, 'image/png');
  assert.equal(mediaContentType('mp4'), 'video/mp4');
  assert.equal(mediaContentType('bin'), '', '认不出的扩展名不给类型(别乱猜)');
});

test('上传重名(2.4.0): 同名自动加 _1/_2, 绝不覆盖已有对象', async () => {
  const { env, state } = makeAdminEnv({ role: 'super', mediaHead: (key) => (state.objects.has(String(key)) ? { key } : null) });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  state.objects.set('image/sub/a.png', { size: 1, httpMetadata: {} });
  const first = await saveUpload(env, { file: new File([png], 'a.png'), purpose: 'auto', nameMode: 'keep', relPath: 'sub/a.png' });
  assert.equal(first.url, 'image/sub/a_1.png', '重名加 _1');
  const second = await saveUpload(env, { file: new File([png], 'a.png'), purpose: 'auto', nameMode: 'keep', relPath: 'sub/a.png' });
  assert.equal(second.url, 'image/sub/a_2.png', '再来一个加 _2');
});

test('富文本净化: 去脚本/事件属性/危险协议, 保留白名单标签', () => {
  const dirty = '<p onclick="x()">正常</p><script>alert(1)</script><img src="a.png" onerror="y()"><a href="javascript:z()">链接</a>';
  const clean = sanitizeHtml(dirty);
  assert.ok(!clean.includes('<script'));
  assert.ok(!clean.includes('onclick'));
  assert.ok(!clean.includes('onerror'));
  assert.ok(!clean.includes('javascript:'));
  assert.ok(clean.includes('<p>正常</p>'));
  assert.ok(clean.includes('<img src="a.png">'));
});

test('正文媒体改绝对地址: 图片 src 与视频封面 poster 都要拼上媒体域', () => {
  const env = { MEDIA_BASE: 'https://storage.250036.xyz/' };
  const html = sanitizeHtml('<p><img src="news_uploads/a.png"></p>'
    + '<wx-video src="video/v.mp4" poster="news_uploads/cover.jpg" controls="true"></wx-video>');
  const out = absolutizeMedia(env, html);
  assert.ok(out.includes('src="https://storage.250036.xyz/news_uploads/a.png"'), out);
  // 只补图片不补封面 → 小程序拿到站内相对地址, 未播放的视频会退回一片纯黑
  assert.ok(out.includes('poster="https://storage.250036.xyz/news_uploads/cover.jpg"'), out);
  // 视频自身的 src 与之前一样保持原样下发(小程序侧统一走 normalizeRemoteUrl), 这里顺带钉住, 免得以后误改口径
  assert.ok(out.includes('src="video/v.mp4"'), out);
});

test('口令: pepper 参与派生、老哈希照旧能验并需要升级、假哈希恒 false', async () => {
  const plainEnv = {};
  const pepperEnv = { ADMIN_PASSWORD_PEPPER: 'pepper-secret' };

  // 不带 pepper(老形态): 前缀无 p, 验得过, 参数一致时不需要重哈希
  const legacy = await hashPassword('password-12345', plainEnv);
  assert.match(legacy, /^pbkdf2_sha256\$\d+\$/);
  assert.equal(await verifyPassword('password-12345', legacy, plainEnv), true);
  assert.equal(await verifyPassword('wrong-password', legacy, plainEnv), false);
  assert.equal(needsRehash(legacy, plainEnv), false);

  // 带 pepper: 前缀区分形态, 口令对但 pepper 不对就验不过(证明 pepper 真的参与了派生)
  const peppered = await hashPassword('password-12345', pepperEnv);
  assert.match(peppered, /^pbkdf2_sha256p\$/);
  assert.equal(await verifyPassword('password-12345', peppered, pepperEnv), true);
  assert.equal(await verifyPassword('password-12345', peppered, plainEnv), false, '没配 pepper 时不能降级去验');
  assert.equal(await verifyPassword('password-12345', peppered, { ADMIN_PASSWORD_PEPPER: 'other' }), false);

  // 配了 pepper 之后: 老哈希照旧能验, 但要升级(登录时会重写成带 pepper 的)
  assert.equal(await verifyPassword('password-12345', legacy, pepperEnv), true);
  assert.equal(needsRehash(legacy, pepperEnv), true);

  // 假哈希: 与真校验同一开销, 永远 false(账号不存在时用它抹掉时间差)
  assert.equal(await verifyDummy('whatever', plainEnv), false);
  assert.equal(await verifyDummy('whatever', pepperEnv), false);
  assert.equal(needsRehash('garbage', plainEnv), true, '认不出的形态一律重写');
});

test('IN 分片: 按 D1 的 100 个绑定参数上限切批, 顺带去重与过滤', () => {
  assert.equal(IN_CHUNK_SIZE, 90);
  assert.deepEqual(chunkIds([1, 2, 3]), [[1, 2, 3]]);
  assert.deepEqual(chunkIds([1, 1, 2, 0, -3, 'x', 4]), [[1, 2, 4]], '去重 + 只留正整数');
  assert.deepEqual(chunkIds([]), []);
  assert.deepEqual(chunkIds(null), []);
  const chunks = chunkIds(Array.from({ length: 200 }, (item, index) => index + 1));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [90, 90, 20]);
  chunks.forEach((chunk) => assert.equal(marksOf(chunk), chunk.map(() => '?').join(',')));
});

test('路由表就是计划里的 34 条对外接口(静态页不计入)', () => {
  const expected = [
    '/user/login', '/user/get_user_info', '/user/update_profile', '/user/upload_avatar',
    '/user/delete_account', '/user/deleted_account_action', '/user/user_favorites',
    '/user/user_likes', '/user/user_view_history', '/user/apply_test',
    '/news/list', '/news/detail', '/news/like', '/news/favorite', '/news/share',
    '/news/add_comment', '/news/get_comments', '/news/check_user_action', '/news/check_user_like_batch',
    '/content/get_banners', '/content/get_outdoor', '/content/get_motorcycle', '/content/get_notices',
    '/content/get_notice_unread', '/content/notice_read',
    '/config/get_app_config',
    '/', '/test', '/index', '/info', '/apitest',
    '/health', '/health/ready', '/metrics'
  ];
  const paths = new Set(routeTable().filter((key) => !key.includes('/pages/')).map((key) => key.split(' ')[1]));
  assert.equal(expected.length, 34);
  const missing = expected.filter((path) => !paths.has(path));
  assert.deepEqual(missing, []);
});

test('限流配额与旧站一致', () => {
  assert.deepEqual(QUOTAS.like, { limit: 60, windowSec: 60 });
  assert.deepEqual(QUOTAS.favorite, { limit: 60, windowSec: 60 });
  assert.deepEqual(QUOTAS.share, { limit: 30, windowSec: 60 });
  assert.deepEqual(QUOTAS.comment, { limit: 20, windowSec: 60 });
  assert.deepEqual(QUOTAS.view_history, { limit: 120, windowSec: 60 });
  assert.deepEqual(QUOTAS.avatar, { limit: 5, windowSec: 60 });
});
