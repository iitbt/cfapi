// 素材上传与素材库: 旧站的两个端点在这里等价实现
//   POST /admin/image_upload(旧地址 /admin/news_image_upload) —— 与静态脚本 image_upload.js 对接
//   GET  /admin/media_library(旧地址 /admin/media_videos)     —— 与静态脚本 media_library.js 对接
import { listMedia, saveUpload } from '../lib/mediaUpload.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

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
    // 目标路径(2.4.3): 只认本入口根目录及其子目录, 权威校验在 saveUpload 里
    targetDir: form.get('target_dir')
  });
  if (!result.ok) return json({ success: false, message: result.message });
  // 旧站返回的是 {success, message, url}, url 是相对记录值, 前端直接回填输入框
  return json({ success: true, message: result.message, url: result.url, kind: result.kind });
}

async function libraryHandler(ctx) {
  const kind = ctx.query.kind === 'video' ? 'video' : 'image';
  const listed = await listMedia(ctx.env, kind, ctx.query.q);
  if (!listed.success) return json(listed);
  // 2.4.0: 不再给 thumb —— 缩略图功能整体移除, 弹窗直接用 item.path 的原图(前端 onerror 会隐藏加载失败的图)
  return json({ success: true, kind: listed.kind, items: listed.items, total: listed.items.length, accept: listed.accept });
}

// 旧地址: 视频素材库(等价于 kind=video)
const videosHandler = (ctx) => libraryHandler({ query: Object.assign({}, ctx.query, { kind: 'video' }), env: ctx.env });

export const routes = [
  { methods: ['POST'], path: '/admin/image_upload', handler: uploadHandler },
  { methods: ['POST'], path: '/admin/news_image_upload', handler: uploadHandler },
  { methods: ['GET', 'HEAD'], path: '/admin/media_library', handler: libraryHandler },
  { methods: ['GET', 'HEAD'], path: '/admin/media_videos', handler: videosHandler }
];
