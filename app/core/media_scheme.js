// 素材地址: 库里只存相对路径, 下发时拼绝对地址; 素材本体走 R2 公开域(storage.250036.xyz)
//
// 2.4.0: **缩略图(派生文件)相关的实现全部移除** —— 原来这里的 thumbKey / hasThumb /
// previewThumbUrl / previewBodyThumbs / existingThumbs 与两个宽度常量(NEWS_COVER_THUMB_WIDTH、
// PREVIEW_BODY_THUMB_WIDTH)都删掉了, 现在一律直接用原图地址:
//   · 后端列表/详情/预览页 → assetUrl() 的原图;
//   · 对外接口 /news/list  → 不再下发 image_thumb(小程序本来就"没有这个键就回退原图");
//   · 站内预览页的正文配图也不再换成 800px 缩略图(大图加载会慢一点, 但地址与库里一致)。
// 存量桶里的历史缩略图对象没有动, 清理方案见 README 第 38 条。
import { settings } from './config.js';
import { CACHE_CONTROL_MEDIA } from './storage.js';

export function mediaBase(env) {
  return settings(env).mediaBase.replace(/\/+$/, '');
}

// 与旧站 asset_url 同口径: 空→default; http(s) 原样; 其它协议(wxfile://, data:) 原样; 相对路径拼媒体域
export function assetUrl(env, value, fallback = '') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return fallback;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  const base = mediaBase(env);
  if (!base) return text;
  return `${base}/${text.replace(/^\/+/, '')}`;
}

// 菜单/精选图标: /images/ 开头的是包内资源, 原样下发
export function iconAssetUrl(env, value, fallback = '') {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text.startsWith('/images/')) return text;
  return assetUrl(env, text, fallback);
}

// R2 上传: 头像与后台图片统一走这里(cacheControl 口径见 core/storage.js)
export async function putObject(env, key, body, contentType) {
  await settings(env).storage.put(key, body, {
    httpMetadata: { contentType, cacheControl: CACHE_CONTROL_MEDIA }
  });
  return key;
}
