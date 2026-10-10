// 素材存储(R2) —— 对照旧站 app/core/storage.py
//
// 旧站 storage.py 管三件事: 目录扫描(素材清单)、删除文件、路径归一化; 素材治理页与素材库弹窗都调它,
// 所以"素材清单只有一份实现"是旧站的硬约定(media_admin.py 头注释: 引用判定也只有一个来源)。
// Cloudflare 侧对应关系:
//   os.walk(目录)      → R2 桶 list({ prefix, cursor })
//   os.remove(文件)    → R2 桶 delete(key)
//   文件 mtime/size    → 对象 uploaded/size
import { settings } from './config.js';
import { MAX_SCAN_OBJECTS } from './overview.js';

//: 素材目录(真值只在这里): 新上传按类型分开, 历史素材留在旧目录继续读, 不搬动已有对象
export const IMAGE_PREFIX = 'image/';
export const VIDEO_PREFIX = 'video/';
export const AVATAR_PREFIX = 'avatar/';
export const LEGACY_PREFIX = 'news_uploads/';
export const LEGACY_AVATAR_PREFIX = 'avatar_uploads/';

//: 素材(图片/视频)目录清单: 新目录 + 旧目录(列举与引用判定都要覆盖两者, 否则历史素材会"消失")
export const MEDIA_PREFIXES = [IMAGE_PREFIX, VIDEO_PREFIX, LEGACY_PREFIX];

//: Worker 直出的路径前缀(页面与小程序拿到的地址都落在这里; 含历史目录, 老数据不用迁)
export const SERVED_PREFIXES = ['/images/', '/avatar/', '/avatar_uploads/', ...MEDIA_PREFIXES.map((prefix) => `/${prefix}`)];

/** 某一类素材该扫哪些目录(新目录按类型分开, 历史素材都混放在旧目录)。 */
export function mediaPrefixesFor(kind) {
  return kind === 'video' ? [VIDEO_PREFIX, LEGACY_PREFIX] : [IMAGE_PREFIX, LEGACY_PREFIX];
}

/** 取相对路径所在的素材目录(不在任何素材目录下就返回空串)。 */
export function mediaPrefixOf(relativePath) {
  const text = String(relativePath || '');
  return MEDIA_PREFIXES.find((prefix) => text.startsWith(prefix)) || '';
}

/**
 * 相对路径清洗(2.4.0 起; 2.4.6 从 admin/lib/mediaUpload 挪到 core —— 桶浏览器也要用它, 而 core 不该依赖 admin):
 * 只允许"目录/文件名"形态 —— 分隔符归一(反斜杠→`/`)、去掉空段与 `.`/`..`(防路径穿越)、剥掉控制字符、每段与总长限长。
 * 2.4.2 补三处: ① URL 会打断链接的 `?`/`#`/`%` 换成 `_`(公开域是 `${MEDIA_BASE}/${路径}` 直拼,
 * 名字里带 `#` 会把后半截当锚点、带 `%` 会被当百分号转义 → 上传成功但点开是坏的);
 * ② 剥掉 Windows 盘符段(`C:`); ③ 中文/空格/括号等正常字符**保留**(R2 key 与公开域都支持)。
 */
export function safeRelPath(raw) {
  const segments = String(raw === undefined || raw === null ? '' : raw)
    .replace(/\\/g, '/')
    .split('/')
    // eslint-disable-next-line no-control-regex
    .map((piece) => piece.trim().replace(/[\u0000-\u001f\u007f]/g, ''))
    .map((piece) => piece.replace(/[?#%]/g, '_'))
    .filter((piece) => piece && piece !== '.' && piece !== '..' && !/^[a-z]:$/i.test(piece))
    .map((piece) => piece.slice(0, 120));
  const text = segments.join('/');
  // R2 key 上限 1024 字节; 这里按 300 字符封顶(留足余量与目录前缀), 超长时保留尾部(丢最外层目录)
  return text.length > 300 ? text.slice(text.length - 300).replace(/^[^/]*\//, '') : text;
}

/**
 * 对象键 / 目录前缀校验(2.4.6, 桶浏览器用): 与上传那套清洗同源, 但**不做静默改写** ——
 * 清洗结果必须与输入完全一致, 否则拒绝并说明原因(用户看得见 `..`/空段/特殊字符/超长在哪一步被挡)。
 * `asDir` 为真时按目录形态(补尾斜杠)比对。返回 `{ ok: true, key }` 或 `{ ok: false, message }`。
 */
export function checkObjectKey(raw, options = {}) {
  const asDir = Boolean(options.asDir);
  const text = String(raw === undefined || raw === null ? '' : raw).replace(/\\/g, '/');
  if (!text) return { ok: false, message: asDir ? '目录不能为空' : '对象键不能为空' };
  const full = asDir && !text.endsWith('/') ? `${text}/` : text;
  if (full.length > 300) return { ok: false, message: '路径过长（最多 300 字符）' };
  if (`${safeRelPath(full)}${asDir ? '/' : ''}` !== full) {
    return { ok: false, message: '路径不合法（不能有 ..、空段、控制字符、?#% 或盘符）' };
  }
  return { ok: true, key: full };
}

/**
 * 列某个前缀**下面的对象**(不折叠目录, 最多 limit 个): 目录级批量操作(移动/删除)要先知道里面有什么。
 * 一次 R2 列举(上限 1000), `truncated` 为真说明这个前缀下的对象超过 1000 个。
 */
export async function listUnder(env, prefix, options = {}) {
  const limit = Math.min(1000, Math.max(1, Number(options.limit) || 1000));
  const base = String(prefix || '');
  const listed = await settings(env).storage.list({ prefix: base, limit });
  const objects = [];
  for (const object of (listed && listed.objects) || []) {
    const key = String(object.key || '');
    if (!key || key === base || !key.startsWith(base)) continue;
    objects.push({ key, size: Number(object.size) || 0, etag: String(object.etag || ''), uploaded: object.uploaded || '' });
  }
  return { objects, truncated: Boolean(listed && listed.truncated) };
}

/**
 * 列一个"目录层"(2.4.6 桶浏览器): 一次 R2 列举拿到该前缀下的**子目录**(delimitedPrefixes, 带尾斜杠)
 * 与**直接对象**(不带 delimiter 的话整个桶都会被回给我们)。`truncated` 为真表示这一层超过 limit(上限 1000)。
 * 只列一层, 不递归 —— 页面按需进入下一层(R2 的前缀/分隔符语义, 见 README 第 45 条)。
 */
export async function listLevel(env, prefix = '', options = {}) {
  const limit = Math.min(1000, Math.max(1, Number(options.limit) || 1000));
  const listed = await settings(env).storage.list({ prefix, delimiter: '/', limit });
  const base = String(prefix || '');
  const objects = [];
  for (const object of (listed && listed.objects) || []) {
    const key = String(object.key || '');
    if (!key || !key.startsWith(base) || key === base) continue;
    objects.push({
      key,
      name: key.slice(base.length),
      size: Number(object.size) || 0,
      etag: String(object.etag || ''),
      uploaded: object.uploaded || '',
      // mtime 给页面排序/展示用(list 返回的是 uploaded 时间戳)
      mtime: object.uploaded ? new Date(object.uploaded).getTime() : 0
    });
  }
  const folders = ((listed && listed.delimitedPrefixes) || []).map((one) => ({
    key: String(one),
    name: String(one).slice(base.length).replace(/\/$/, '')
  })).filter((one) => one.name);
  return { folders, objects, truncated: Boolean(listed && listed.truncated) };
}

//: 站内自有目录(2.4.5): Worker 直出的站点图标与用户头像, **不是素材** —— 它们既不该进素材库清单,
//  也不该被当成"根目录素材"(否则根目录那一档会被头像/图标刷满)
export const INTERNAL_PREFIXES = [AVATAR_PREFIX, LEGACY_AVATAR_PREFIX, 'images/'];

/**
 * 根目录素材(2.4.4 起; 2.4.5 起覆盖"根下自定义目录"):
 * 用户在素材库页可以把文件传到**存储桶最外层**(不带 `image/`、`video/` 前缀) —— 传单个文件时记录值就是
 * `logo.png`, 选文件夹时会带出目录(如 `素材/子/图.png`)。这里只回答"这条记录值是不是根目录那块的内容":
 *   · 不在任何素材目录(`image/`、`video/`、`news_uploads/`)下;
 *   · 也不在站内自有目录(`avatar/`、`avatar_uploads/`、`images/`)下;
 *   · 没有空段与 `.`/`..`(防路径穿越)。
 * **是否算素材还要再看扩展名**(`kindOfExt`) —— 调用方都要带这条, 否则 `index.html` 之类会变成万能删除入口。
 */
export function isRootTreePath(relativePath) {
  const text = String(relativePath || '');
  if (!text || text.includes('..')) return false;
  const known = MEDIA_PREFIXES.concat(INTERNAL_PREFIXES);
  if (known.some((prefix) => text.startsWith(prefix))) return false;
  return text.split('/').every((piece) => Boolean(piece) && piece !== '.');
}

// 缩略图(2.1.8 的"目录随原图走"派生文件规则)已按 2.4.0 要求整体移除 —— 见 README 第 38 条:
// 生成的工具在旧站(离线), 存储与引用逻辑原来在本文件与 core/media_scheme.js, 现已删除;
// 前端一律直接用原图(列表/详情/预览/小程序接口都是原图地址)。桶里**历史遗留**的
// <素材目录>_thumb/<宽>/ 对象没有擅自批量删除, 它们现在会作为普通素材出现在素材库页的清单里,
// 可用"目录"筛选 + 批量删除清理(方案见 README 第 38 条, 也可用 wrangler/rclone 一次性删)。

//: 可列举的图片/视频扩展名(与旧站 storage.LISTABLE_*_EXTS 同口径)
export const LISTABLE_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
export const LISTABLE_VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'ts', 'm3u8', '3gp', 'avi', 'flv', 'wmv', 'f4v'];

export function extOf(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  return dot < 0 ? '' : text.slice(dot + 1).toLowerCase();
}

/** 扩展名 → 'video' | 'image' | ''(与旧站 kind 判定一致, 顺序: 先视频)。 */
export function kindOfExt(ext) {
  const value = String(ext || '').toLowerCase();
  if (LISTABLE_VIDEO_EXTS.includes(value)) return 'video';
  if (LISTABLE_IMAGE_EXTS.includes(value)) return 'image';
  return '';
}

/** 枚举 kind 对应的扩展名白名单(素材库弹窗的 accept 用)。 */
export function listableExts(kind) {
  return kind === 'video' ? LISTABLE_VIDEO_EXTS : LISTABLE_IMAGE_EXTS;
}

/**
 * 素材清单: 列该类型的文件, 按修改时间倒序。
 *
 * 为什么分页: R2 单次 list 上限 1000; 旧站扫描也有 _MAX_SCAN_FILES 上限, 两边都只"尽量数清",
 * 数不清时返回 truncated=true 让页面标注"至少这么多", 不编数字。
 * 2.4.0: 不再跳过 `_thumb/` 前缀 —— 派生的缩略图规则已移除, 桶里历史遗留的缩略图对象
 * 现在就是普通素材(出现在清单里才能被看见与清理)。
 */
export async function listNewsMedia(env, kind = 'image', options = {}) {
  const max = options.max || MAX_SCAN_OBJECTS;
  const wanted = kind === 'video' ? 'video' : 'image';
  const items = [];
  // 同一个 key 只收一次: 根目录那块的"根下对象"与"根下目录"两趟列举在真 R2 上不会重叠,
  // 但桩 R2 忽略 delimiter(会把整个桶回给我们), 不兜一道就会出现重复行
  const seen = new Set();
  let truncated = false;
  try {
    // 2.4.5 修: 根目录那一块要**整棵树**都列进来。
    // 2.4.4 只列"根下不带斜杠的文件", 于是"根目录 + 选文件夹"传上去的对象(键形如 `素材/子/图.png`)
    // 既不属于任何素材前缀、又被"不含斜杠"挡掉 → 传成功了却在页面上看不见(线上反馈的就是这个)。
    // 做法: 先按 `delimiter: '/'` 看根下有哪些顶层目录(很省: 只回根下的对象与目录名),
    // 把**已知前缀**(素材目录 + 站内自有目录)排除掉, 剩下的每个目录整棵树各扫一趟 —— 那才是"用户的根目录素材"。
    const stored = settings(env).storage;
    const roots = await stored.list({ prefix: '', delimiter: '/', limit: 1000 });
    const rootObjects = (roots && roots.objects) || [];
    const folders = new Set((roots && roots.delimitedPrefixes) || []);
    // 桩 R2 不实现 delimiter(会把整桶都回给我们) → 从对象里补出顶层目录名, 两种实现都能跑
    for (const object of rootObjects) {
      const key = String(object.key || '');
      const slash = key.indexOf('/');
      if (slash > 0) folders.add(key.slice(0, slash + 1));
    }
    const known = MEDIA_PREFIXES.concat(INTERNAL_PREFIXES);
    const rootScans = [{ prefix: '', objects: rootObjects }]
      .concat(Array.from(folders).filter((one) => !known.includes(one)).map((prefix) => ({ prefix })));
    for (const scan of rootScans) {
      let cursor;
      for (let round = 0; round < 5; round += 1) {
        const listed = scan.objects ? { objects: scan.objects } : await stored.list({ prefix: scan.prefix, limit: 1000, cursor });
        for (const object of (listed && listed.objects) || []) {
          const key = String(object.key || '');
          if (!key || !isRootTreePath(key) || seen.has(key)) continue;
          if (kindOfExt(extOf(key)) !== wanted) continue;
          seen.add(key);
          items.push({
            path: key,
            name: key,
            dir: '',
            kind: wanted,
            size: Number(object.size) || 0,
            mtime: object.uploaded ? new Date(object.uploaded).getTime() : 0,
            uploaded: object.uploaded || ''
          });
        }
        cursor = listed && listed.truncated ? listed.cursor : undefined;
        if (!cursor || items.length > max) break;
      }
      if (items.length > max) break;
    }
    // 逐目录逐页拉取: 单次 1000 上限, 直到取够 max+1 或没有 next 游标
    for (const prefix of mediaPrefixesFor(wanted)) {
      let cursor;
      for (let round = 0; round < 5; round += 1) {
        const listed = await settings(env).storage.list({ prefix, limit: 1000, cursor });
        const objects = (listed && listed.objects) || [];
        for (const object of objects) {
          const key = String(object.key || '');
          if (!key || !key.startsWith(prefix) || seen.has(key)) continue;
          if (kindOfExt(extOf(key)) !== wanted) continue;
          seen.add(key);
          items.push({
            path: key,
            name: key.slice(prefix.length),
            dir: prefix.replace(/\/$/, ''),
            kind: wanted,
            size: Number(object.size) || 0,
            mtime: object.uploaded ? new Date(object.uploaded).getTime() : 0,
            uploaded: object.uploaded || ''
          });
        }
        cursor = listed && listed.truncated ? listed.cursor : undefined;
        if (!cursor || items.length > max) break;
      }
      if (items.length > max) break;
    }
  } catch (error) {
    console.error('列举素材失败', error && error.message);
    return { items: [], total: 0, truncated: false, failed: true };
  }
  items.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  truncated = items.length > max;
  const used = truncated ? items.slice(0, max) : items;
  return { items: used, total: used.length, truncated, failed: false };
}

/** R2 素材占用(与系统信息/素材治理页共用一个口径)。 */
export async function mediaUsage(env) {
  // 两个目录各自是一串 R2 列举, 互不依赖 → 并发(素材治理页与系统信息页都调它, 少等一半往返)
  const [listed, videos] = await Promise.all([listNewsMedia(env, 'image'), listNewsMedia(env, 'video')]);
  if (listed.failed && videos.failed) {
    return { count: 0, bytes: 0, truncated: false, failed: true };
  }
  const all = listed.items.concat(videos.items);
  let bytes = 0;
  for (const item of all) bytes += Number(item.size) || 0;
  return {
    count: all.length,
    bytes,
    truncated: Boolean(listed.truncated || videos.truncated),
    failed: false
  };
}

//: 新写入对象的缓存口径(2.3.9): key 里带时间戳、从不覆盖写, 所以可以长缓存 ——
//  改了内容就会换一个新 key, 因此 immutable 是安全的; 由公开域(R2 自定义域)直接下发。
//  ⚠️ 代价: 删除/改名后, 公开域上的旧副本最长要等这个 TTL 过期才彻底消失(见 README「R2 用法」)。
export const CACHE_CONTROL_MEDIA = 'public, max-age=604800, immutable';    // 原图 7 天(与旧站口径一致)

/**
 * 批量删除(2.3.9; 2.4.6 泛化到任意对象键): R2 的 `delete` 支持一次传 key 数组(单次上限 1000),
 * 所以**一批只花 1 次子请求**(逐个 delete 会把单请求的 50 次子请求额度很快打穿)。
 * 调用方负责引用检查与批量上限。传进来的键必须已经校验过(见 checkObjectKey)。
 */
export async function removeObjects(env, keys) {
  const list = [];
  for (const value of keys || []) {
    const key = String(value === undefined || value === null ? '' : value);
    if (!key || key.includes('..') || list.includes(key)) continue;
    list.push(key);
  }
  if (!list.length) return 0;
  await settings(env).storage.delete(list);
  return list.length;
}

/** 素材路径版本的批量删除(素材库页与旧的调用方用): 先按素材口径归一, 再走上面的同一实现。 */
export async function removeMediaFiles(env, relativePaths) {
  const keys = [];
  for (const value of relativePaths || []) {
    const key = normRel(value);
    if (key) keys.push(key);
  }
  return removeObjects(env, keys);
}

/**
 * 移动 / 改名(2.4.6 从 moveMediaFile 泛化到**任意对象键**, 桶浏览器要能整理整个桶):
 * R2 **没有** rename, 只能"读原对象 → 写新 key → 删旧 key"(3 次 R2 操作), 外加 1 次 `head` 查重 ——
 * 所以单次批量移动的对象数必须很小(页面按批 10 个, 见 README 第 45 条的子请求预算)。
 * 用 `get().body` 直传 `put()`(流式), 不把对象整份读进内存; `httpMetadata` 原样带走(缓存头/类型不丢)。
 * 不做的事(有意): 不改写任何笔记里的引用(调用方必须先确认无引用)。
 */
export async function moveObject(env, from, to) {
  const source = String(from === undefined || from === null ? '' : from);
  const target = String(to === undefined || to === null ? '' : to);
  if (!source || !target || source === target || target.includes('..') || !checkObjectKey(target).ok) {
    return { ok: false, reason: '参数错误' };
  }
  const bucket = settings(env).storage;
  try {
    if (await bucket.head(target)) return { ok: false, reason: '目标路径已存在' };
    const object = await bucket.get(source);
    if (!object) return { ok: false, reason: '原文件不存在' };
    await bucket.put(target, object.body, { httpMetadata: object.httpMetadata || {} });
    await bucket.delete(source);
    return { ok: true, from: source, to: target, size: Number(object.size) || 0 };
  } catch (error) {
    console.error('移动/改名对象失败', source, '→', target, error && error.message);
    return { ok: false, reason: '操作失败，请稍后重试' };
  }
}

/** 复制对象(2.4.6): "读→写"(2 次 R2 操作) + 1 次 `head` 查重; 同样绝不覆盖已有键。 */
export async function copyObject(env, from, to) {
  const source = String(from === undefined || from === null ? '' : from);
  const target = String(to === undefined || to === null ? '' : to);
  if (!source || !target || source === target || target.includes('..') || !checkObjectKey(target).ok) {
    return { ok: false, reason: '参数错误' };
  }
  const bucket = settings(env).storage;
  try {
    if (await bucket.head(target)) return { ok: false, reason: '目标路径已存在' };
    const object = await bucket.get(source);
    if (!object) return { ok: false, reason: '原文件不存在' };
    await bucket.put(target, object.body, { httpMetadata: object.httpMetadata || {} });
    return { ok: true, from: source, to: target, size: Number(object.size) || 0 };
  } catch (error) {
    console.error('复制对象失败', source, '→', target, error && error.message);
    return { ok: false, reason: '操作失败，请稍后重试' };
  }
}

/** 素材口径的移动/改名(旧调用方与素材库页用): 先按素材路径归一, 再走 moveObject。 */
export async function moveMediaFile(env, fromValue, toValue) {
  const from = normRel(fromValue);
  const to = normRel(toValue);
  if (!from || !to) return { ok: false, reason: '参数错误' };
  return moveObject(env, from, to);
}

/**
 * 把"可能装着素材路径的字符串"规整成库内相对记录值; 不是素材则返回空串。
 *
 * 库里同一个素材有几种历史形态, **必须先归一化再比较**(旧站 storage/media_admin 同口径):
 *   news_uploads/a.png / /news_uploads/a.png / https://host/news_uploads/a.png /
 *   <wx-video src="news_uploads/a.mp4">…(富文本里的一段)
 */
export function normRel(value) {
  let text = String(value === undefined || value === null ? '' : value).trim().replace(/^["']|["']$/g, '');
  if (!text) return '';
  text = text.split('?')[0].split('#')[0].replace(/\\/g, '/');
  // 可能整串是绝对地址, 也可能是富文本里的一段: 从最早出现的那个素材目录开始截
  const offsets = MEDIA_PREFIXES.map((prefix) => text.indexOf(prefix)).filter((at) => at > 0);
  if (offsets.length) text = text.slice(Math.min(...offsets));
  text = text.replace(/^\/+/, '');
  if (text.includes('..')) return '';
  if (mediaPrefixOf(text)) return text;
  // 2.4.4/2.4.5: 根目录素材(裸文件名或根下自定义目录里的路径) —— 必须带图片/视频扩展名, 见 isRootTreePath
  return isRootTreePath(text) && kindOfExt(extOf(text)) ? text : '';
}

//: 从富文本 HTML 里抽素材路径: 认全部素材目录、到引号/空白/尖括号/括号为止的一段
const RICH_PATH_RE = new RegExp(`(?:${MEDIA_PREFIXES.join('|')})[^\\s"'<>()[\\]{},;]+`, 'gi');

/** 从一个字段值里抽出**所有**素材相对记录值(富文本可能引用多个)。 */
export function relPathsIn(value, rootNames = null) {
  const text = String(value === undefined || value === null ? '' : value);
  const out = [];
  if (text && MEDIA_PREFIXES.some((prefix) => text.includes(prefix))) {
    const found = (text.includes('<') || text.includes('>'))
      ? RICH_PATH_RE_SAFE(text).map(normRel).filter(Boolean)
      : [normRel(text)];
    for (const one of found) if (one && !out.includes(one)) out.push(one);
  }
  // 2.4.4: 根目录素材只有文件名(没有前缀可认) —— 由调用方给出候选名单, 字段里出现即算引用。
  // 只能"按名单查", 不做"从任意文本里猜文件名": 猜出来的裸名(如正文里提到 a.png)没有边界, 误判率太高。
  for (const name of rootNames || []) {
    if (name && text.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

// 每次调用重置 lastIndex, 避免全局正则跨次匹配出现漏项
function RICH_PATH_RE_SAFE(text) {
  RICH_PATH_RE.lastIndex = 0;
  return Array.from(text.matchAll(RICH_PATH_RE), (match) => match[0]);
}

/** 预览/下载用的绝对地址由 media_scheme 负责, 这里只做 key 到公开 URL 的拼接(公开域)。 */
export function publicUrl(mediaBase, relativePath) {
  const base = String(mediaBase || '').replace(/\/+$/, '');
  const key = String(relativePath || '').replace(/^\/+/, '');
  if (!base || !key) return '';
  return `${base}/${key}`;
}
