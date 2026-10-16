// 桶浏览器的共用取数与渲染(2.7.1): 素材治理页(media_manage)与素材选择器(素材库弹窗)共用这一份,
// 不再各写一套"列素材"的逻辑。
//
// 为什么改成逐层浏览: 旧实现的选择器走 core/storage.js 的 listNewsMedia —— 一次全桶扫描(根目录树 +
// image/ + news_uploads/), 撞到 MAX_SCAN_OBJECTS(1000) 就**静默截断**, 于是"部分图片列不出来";
// 而且它只扫那几个目录, 把图片传进 video/(上传卡片的「目标路径」允许)就永远列不到。
// 现在一次只列**当前这一层**(前缀 + delimiter '/'), 类型/关键词/排序/分页都在本层内做, 翻页靠触底加载。
import { escapeHtml } from '../../core/html.js';
import { settings } from '../../core/config.js';
import { fmtBytes } from '../../core/overview.js';
import { checkObjectKey, extOf, INTERNAL_PREFIXES, kindOfExt, listLevel, publicUrl } from '../../core/storage.js';

//: 单层列举上限(R2 单次 list 就是 1000): 超过只列前 1000, 调用方必须把 truncated 说出来
export const LEVEL_MAX = 1000;
//: 列表里直接给原图预览的体积上限(派生缩略图 2.4.0 已整体移除, 一律用原图: 小图直出、大图给图标)
export const PREVIEW_INLINE_MAX = 512 * 1024;
//: 选择器每页几条: 弹窗一屏能放十几行, 用列表页的 10 要滚很多次; 加载机制本身与治理页同一套
export const PICK_PER_PAGE = 30;
//: 排序选项(与旧站 _SORT_CHOICES 同口径; 治理页的筛选下拉与选择器的 sort 参数共用, 顺序照治理页原样)
export const SORT_CHOICES = [
  ['time_desc', '最新优先'],
  ['time_asc', '最早优先'],
  ['size_desc', '体积从大到小'],
  ['size_asc', '体积从小到大'],
  ['name_asc', '文件名 A→Z']
];

/** 文件类型: 按扩展名判(image/video/other), 与素材口径一致(kindOfExt)。 */
export function kindOfFile(key) {
  return kindOfExt(extOf(String(key || ''))) || 'other';
}

/** 对象键的父目录(带尾斜杠; 桶根返回空串)。 */
export function parentOf(key) {
  const slash = String(key || '').lastIndexOf('/');
  return slash < 0 ? '' : String(key).slice(0, slash + 1);
}

/** 站内自有目录(2.4.5: 头像与站点图标)不是素材 —— 选择器要把它们挡在外面(治理页照旧能浏览)。 */
export function isInternalKey(key) {
  return INTERNAL_PREFIXES.some((prefix) => String(key || '').startsWith(prefix));
}

/** 本层里的对象排序: 同值时按名字。 */
export function sortFiles(items, sort) {
  const list = items.slice();
  if (sort === 'time_asc') list.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  else if (sort === 'time_desc') list.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  else if (sort === 'size_desc') list.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  else if (sort === 'size_asc') list.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  else list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

/** 媒体域地址(唯一拼法在 core/storage.js 的 publicUrl, 这里只负责去掉尾斜杠)。 */
export function mediaBaseOf(env) {
  return String(settings(env).mediaBase || '').replace(/\/+$/, '');
}

export function mediaUrlOf(base, key) {
  return publicUrl(base, key);
}

/**
 * 预览格(治理页与选择器共用这一处判定): 图片 + 体积不过阈值 + 有公开地址才直出原图, 其它给图标。
 * 地址一律走**媒体公开域**(不能拼站点根路径: Worker 只直出 image//video//news_uploads/ 三个前缀,
 * 根目录素材与 images/ 那些对象拼 `/key` 会 404 —— 这就是"部分缩略图显示不出来"的根因)。
 */
export function previewCell(base, item, thumbClass = 'media-thumb') {
  const kind = kindOfFile(item.key);
  const url = mediaUrlOf(base, item.key);
  if (kind === 'image' && item.size <= PREVIEW_INLINE_MAX && url) {
    return `<img src="${escapeHtml(url)}" class="${escapeHtml(thumbClass)}" alt="" loading="lazy"`
      + ` onerror="this.style.visibility='hidden'">`;
  }
  const icon = kind === 'video' ? 'bi-camera-video' : (kind === 'image' ? 'bi-image' : 'bi-file-earmark');
  const label = kind === 'image' ? '无预览' : (kind === 'video' ? '视频' : '文件');
  return `<span class="text-muted small"><i class="bi ${icon}" aria-hidden="true"></i> ${label}</span>`;
}

/** 类型 / 大小 / 修改时间三格(两个页面共用, 列的顺序与口径才不会各走各的)。 */
export function metaCells(item) {
  const kind = kindOfFile(item.key);
  const label = kind === 'image' ? '图片' : (kind === 'video' ? '视频' : '<span class="text-muted">其它</span>');
  return `<td class="text-nowrap">${label}</td>`
    + `<td class="text-nowrap">${escapeHtml(fmtBytes(item.size))}</td>`
    + `<td class="text-nowrap">${escapeHtml(fmtUploadTime(item))}</td>`;
}

/**
 * 上传时间: R2 回的 uploaded 是 UTC 的 ISO 串, 后台一律按北京时间显示 ——
 * 用"+8 小时后的 ISO 前 16 位", 不依赖运行环境的时区(Worker 是 UTC, 本机测试是东八区, 两边结果一致)。
 */
export function fmtUploadTime(item) {
  const ms = Number(item.mtime) || (item.uploaded ? Date.parse(item.uploaded) : 0);
  if (!ms) return '';
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}


/**
 * 取"当前这一层"的内容(治理页与选择器唯一入口)。
 * options:
 *   prefix          当前前缀(目录形态, 空串 = 存储桶最外层)
 *   kind            all | image | video | other
 *   q               关键词(按对象键在本层内过滤)
 *   sort            SORT_CHOICES 里的值, 默认 name_asc
 *   page / perPage  分页(页码从 1 起)
 *   hideInternal    true = 选择器口径: 排除站内自有目录(头像/站点图标)整棵子树
 *   prepare         (可选)async(排序后的本层文件) => 分页前的最后一道加工 —— 治理页用它做引用扫描与
 *                   "已引用/未引用"筛选(必须赶在切片之前, 否则按引用筛选就没法分页); 选择器不传。
 * 返回: { prefix, prefixOk, blocked, folders, files(本层全部命中), pageItems(本页), page, totalPages,
 *         total, perPage, levelCount, truncated, base, kind, q, sort }
 */
export async function browseLevel(env, options = {}) {
  const rawPrefix = options.prefix === undefined || options.prefix === null ? '' : String(options.prefix);
  const prefixCheck = rawPrefix === '' ? { ok: true, key: '' } : checkObjectKey(rawPrefix, { asDir: true });
  const prefix = prefixCheck.ok ? prefixCheck.key : '';
  const hideInternal = Boolean(options.hideInternal);
  // 选择器不能被"手填 URL"绕进站内自有目录: 撞上就直接回空层
  const blocked = hideInternal && isInternalKey(prefix);
  const kind = ['image', 'video', 'other'].includes(options.kind) ? options.kind : 'all';
  const q = String(options.q === undefined || options.q === null ? '' : options.q).trim().toLowerCase();
  const sort = SORT_CHOICES.some(([value]) => value === options.sort) ? options.sort : 'name_asc';
  const perPage = Math.min(200, Math.max(1, Number(options.perPage) || PICK_PER_PAGE));
  const wantsPage = Math.max(1, Number(options.page) || 1);

  const level = blocked ? { folders: [], objects: [], truncated: false } : await listLevel(env, prefix, { limit: LEVEL_MAX });
  let files = level.objects;
  if (kind !== 'all') files = files.filter((one) => kindOfFile(one.key) === kind);
  if (q) files = files.filter((one) => one.key.toLowerCase().includes(q));
  const sorted = sortFiles(files, sort);
  const prepared = typeof options.prepare === 'function' ? await options.prepare(sorted) : sorted;
  const totalPages = Math.max(1, Math.ceil(prepared.length / perPage));
  const page = Math.min(wantsPage, totalPages);
  const pageItems = prepared.slice((page - 1) * perPage, page * perPage);
  const folders = hideInternal ? level.folders.filter((one) => !isInternalKey(one.key)) : level.folders;
  return {
    prefix, prefixOk: prefixCheck.ok, prefixMessage: prefixCheck.message || '', blocked,
    folders, files: prepared, pageItems, page, totalPages, total: prepared.length, perPage,
    levelCount: level.objects.length, truncated: level.truncated,
    base: mediaBaseOf(env), kind, q, sort
  };
}
