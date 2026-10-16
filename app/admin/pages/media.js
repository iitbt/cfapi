// 素材上传与素材库: 旧站的两个端点在这里等价实现
//   POST /admin/image_upload(旧地址 /admin/news_image_upload) —— 与静态脚本 image_upload.js 对接
//   GET  /admin/media_library(旧地址 /admin/media_videos)     —— 与静态脚本 media_library.js 对接
//
// 2.7.1: media_library 从"全桶素材清单"改成**逐层浏览** —— 取数/过滤/排序/分页与预览、类型、大小、
// 修改时间这些格子全部复用 lib/mediaBrowse.js(素材治理页同一份), 这里只负责拼 JSON 与选择器那两列动作。
// 参数新增 prefix/q/page(都可选, 只带 kind 的老调用照旧可用), 返回体多了 prefix/folders/base/rows/page 等。
// 2.7.3: 目录口径与治理页**逐字一致** —— 不再过滤站内自有目录(原先少列 avatar/、avatar_uploads/、images/,
// 表现为"文件夹显示不全"); 桶里有什么目录就列什么, 点进去也能浏览。
import { escapeHtml } from '../../core/html.js';
import { listableExts } from '../../core/storage.js';
import { PICK_PER_PAGE, browseLevel, kindOfFile, metaCells, previewCell } from '../lib/mediaBrowse.js';
import { saveUpload } from '../lib/mediaUpload.js';
import { json } from '../lib/http.js';

// multipart 只解析一次: 字段名 file 或 image 都收(旧站两种都认)
async function uploadHandler(ctx) {
  let form = null;
  try {
    form = await ctx.request.formData();
  } catch (error) {
    return json({ success: false, message: '未收到文件' });
  }
  const file = form.get('file') || form.get('image');
  // 2.4.0/2.4.2/2.4.3: 多收几个可选参数(素材库页的"命名策略 / 保留子目录 / 目标路径"), 不传就是原来的行为
  const result = await saveUpload(ctx.env, {
    file,
    purpose: form.get('purpose'),
    nameMode: form.get('name_mode'),
    relPath: form.get('rel_path'),
    // 目标路径(2.4.3; 2.6.5 起任意干净相对目录都收): 权威校验在 saveUpload → safeTargetDir 一处
    targetDir: form.get('target_dir')
  });
  if (!result.ok) return json({ success: false, message: result.message });
  // 旧站返回的是 {success, message, url}, url 是相对记录值, 前端直接回填输入框
  return json({ success: true, message: result.message, url: result.url, kind: result.kind });
}

/**
 * 文件行(选择器专用): 预览 / 文件名 / 类型 / 大小 / 修改时间 + 「选择」「预览」两个动作。
 * 治理列(引用/ETag/详情/改名/删除)不属于选择器, 所以这里只拼"公共格子"再加选择那两列。
 */
function pickRows(items, base) {
  return items.map((item) => {
    const url = base ? `${base}/${item.key}` : '';
    const view = url
      ? `<a class="btn btn-sm btn-outline-secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener">预览</a>`
      : '';
    return `<tr data-media-row data-media-pick-key="${escapeHtml(item.key)}" data-media-pick-kind="${kindOfFile(item.key)}">
      <td>${previewCell(base, item)}</td>
      <td class="cell-title"><div class="text-truncate" title="${escapeHtml(item.key)}">${escapeHtml(item.name)}</div></td>
      ${metaCells(item)}
      <td class="text-end text-nowrap">
        <button type="button" class="btn btn-sm btn-primary" data-media-choose>选择</button>${view ? ` ${view}` : ''}
      </td>
    </tr>`;
  }).join('');
}

async function libraryHandler(ctx) {
  const kind = ctx.query.kind === 'video' ? 'video' : 'image';
  let data = null;
  try {
    data = await browseLevel(ctx.env, {
      prefix: ctx.query.prefix, q: ctx.query.q, kind, page: ctx.query.page,
      perPage: PICK_PER_PAGE
    });
  } catch (error) {
    console.error('读取素材目录失败', error && error.message);
    return json({ success: false, message: '读取素材失败，请稍后重试' });
  }
  if (!data.prefixOk) return json({ success: false, message: data.prefixMessage || '目录参数不合法' });
  return json({
    success: true,
    kind,
    prefix: data.prefix,
    base: data.base,
    // 子目录交给前端画成一排按钮(弹窗里比表格行省地方)
    folders: data.folders.map((one) => ({ key: one.key, name: one.name })),
    rows: pickRows(data.pageItems, data.base),
    page: data.page,
    totalPages: data.totalPages,
    total: data.total,
    levelCount: data.levelCount,
    perPage: data.perPage,
    hasMore: data.page < data.totalPages,
    // 单层超过 R2 单次列举上限(1000)时提示缩小范围, 不再像旧实现那样静默截断
    truncated: data.truncated,
    accept: listableExts(kind)
  });
}

// 旧地址: 视频素材库(等价于 kind=video)
const videosHandler = (ctx) => libraryHandler({ query: Object.assign({}, ctx.query, { kind: 'video' }), env: ctx.env });

export const routes = [
  { methods: ['POST'], path: '/admin/image_upload', handler: uploadHandler },
  { methods: ['POST'], path: '/admin/news_image_upload', handler: uploadHandler },
  { methods: ['GET', 'HEAD'], path: '/admin/media_library', handler: libraryHandler },
  { methods: ['GET', 'HEAD'], path: '/admin/media_videos', handler: videosHandler }
];
