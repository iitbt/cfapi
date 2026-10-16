// 上传与素材库: 旧站把文件写到本地磁盘, 这里写到 R2(桶 lyjxxapp-r2, 公开域 storage.250036.xyz)
// 关键差异: Workers 没有 Pillow, 上传时**不生成缩略图** —— 列表按"有则用、无则回退原图"的口径自动降级
// 白名单与大小上限照旧站 core/storage.py: 图片 8MB / 视频 64MB, 并且**不看扩展名只看内容**(前端 accept 可绕过)
import { settings } from '../../core/config.js';
import {
  CACHE_CONTROL_MEDIA, IMAGE_PREFIX, VIDEO_PREFIX, mediaContentType, safeRelPath
} from '../../core/storage.js';

export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
export const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm'];
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

// 素材库能"列出来"的扩展名(比上传白名单宽: 历史素材里有 bmp/avi 这类)
export const LISTABLE_IMAGE_EXTS = IMAGE_EXTS.concat(['bmp']);
export const LISTABLE_VIDEO_EXTS = VIDEO_EXTS.concat(['mkv', 'ts', 'm3u8', '3gp', 'avi', 'flv', 'wmv', 'f4v']);

export function extOf(name) {
  const text = String(name || '').toLowerCase();
  const dot = text.lastIndexOf('.');
  return dot < 0 ? '' : text.slice(dot + 1);
}

export function kindOfExt(ext) {
  const value = String(ext || '').toLowerCase();
  if (LISTABLE_VIDEO_EXTS.includes(value)) return 'video';
  if (LISTABLE_IMAGE_EXTS.includes(value)) return 'image';
  return '';
}

// 内容嗅探: 图片看 RIFF/WEBP、JPEG、PNG、GIF8、BM
export function looksLikeImage(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const head = bytes;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;                     // JPEG
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true; // PNG
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return true; // GIF8
  if (head[0] === 0x42 && head[1] === 0x4d) return true;                                        // BM
  if (bytes.length >= 12
    && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46      // RIFF
    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return true; // WEBP
  return false;
}

// 内容嗅探: 视频看 ISO-BMFF(ftyp/moov/…)或 EBML(webm/mkv)
export function looksLikeVideo(bytes) {
  if (!bytes || bytes.length < 12) return false;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true; // EBML
  const brand = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  return ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide'].includes(brand);
}

function reject(message) {
  return { ok: false, message };
}

//: 单个 key 的重名重试上限(每次 head 都是一次 R2 子请求, 别无限试)
const MAX_KEY_TRIES = 20;

/**
 * 相对路径清洗(2.4.0 起, 文件夹上传用) —— 2.4.6 起实现搬到 `core/storage.js`(桶浏览器也要用, 而 core 不该依赖 admin):
 * 上面按普通模块成员导入, 这里**原样再导出**, 让 `mediaUpload.safeRelPath` 这个既有入口(测试与文档都按它写)继续可用。
 */
export { safeRelPath };

/**
 * 相对路径拆成"目录 + 文件名"(2.4.2): 目录结构要**在两种命名模式下都保留**,
 * 所以先把目录部分切出来, 文件名部分交给命名策略(保留原名 / 自动生成)。
 */
function splitRel(rel) {
  const slash = rel.lastIndexOf('/');
  return slash < 0
    ? { dir: '', name: rel }
    : { dir: rel.slice(0, slash + 1), name: rel.slice(slash + 1) };
}

/**
 * 目标目录校验(2.4.3, 素材库页的「目标路径」; 2.6.5 放宽):
 *   · `root` 现在只当**默认值**(不传或留空时用它), 不再限制"必须写在本入口素材根下":
 *     2.4.4 起存储桶最外层就能写, 手填的新目录也常常落在别处(如 `news_uploads/2026-10/`), 再强制前缀等于
 *     让「其它（手动填写）」只能填 `image/...`, 与"支持根目录上传"自相矛盾(线上报的就是这句文案)。
 *   · 该拦的照旧拦:`\` 归一成 `/`、补尾斜杠后必须与清洗结果**完全一致** —— 否则拒绝而不是静默改写
 *     (这样 `..`/绝对路径/空段/控制字符/`?#%`/盘符/超长都会被挡下, 用户看得见原因, 也不会"写到了别处")。
 *   · 传 `/` = **存储桶最外层**(2.4.4, 不带任何前缀); 图片与视频入口都允许。
 * 代价(2.6.5 明确写下): 写进"本站素材库不扫的目录"(如把图片写进 `video/`)时, 素材库列表与素材选择器按 kind
 * 只扫 `image/`+`news_uploads/` 或 `video/`+`news_uploads/`, 那些对象会**列不出来**(对象本身正常, 公开域直读没问题)。
 * 返回 `{ ok: true, dir }` 或 `{ ok: false, message }`。
 */
export function safeTargetDir(raw, root) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return { ok: true, dir: root };
  // 2.4.4: 表示"存储桶最外层"(根目录)的**唯一提交值就是 `/`** —— 空串已经被"没传=默认根目录"占用, 不能再用。
  // 根目录对图片与视频入口都允许(不带前缀), key 就是文件名/相对路径本身。
  if (text.replace(/\\/g, '/') === '/') return { ok: true, dir: '' };
  const full = `${text.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  // `//`、`///` 这类"只剩斜杠"的写法不是根目录(根目录的唯一提交值是单个 `/`), 与其它非法路径一起拒
  if (full === '/' || `${safeRelPath(full)}/` !== full) {
    return { ok: false, message: '目标路径不合法（不能有 .. / 绝对路径 / 空段 / 特殊字符，且不能超过 300 字符）' };
  }
  return { ok: true, dir: full };
}

/**
 * key 去重: R2 没有"create if not exists", 所以先 head 探测; 重名就加 `_1`/`_2`…
 * **绝不覆盖已有对象**(改名页的 moveMediaFile 也是同一口径: 目标存在就拒绝)。
 */
async function uniqueKey(bucket, key) {
  const dot = key.lastIndexOf('.');
  const stem = dot > 0 ? key.slice(0, dot) : key;
  const ext = dot > 0 ? key.slice(dot) : '';
  for (let index = 0; index <= MAX_KEY_TRIES; index += 1) {
    const candidate = index === 0 ? `${stem}${ext}` : `${stem}_${index}${ext}`;
    const found = await bucket.head(candidate).catch(() => null);
    if (!found) return candidate;
  }
  return '';
}

// 保存一次上传。返回 { ok, url, kind, message }; url 是**相对记录值**(如 image/cover_123.png),
// 与旧站一致, 可直接写进数据库字段(下发时再拼媒体域)
//
// 2.4.0 新增三个可选入参(其它调用方不传 = 完全原来的行为):
//   · purpose='auto'  → 按**内容**分流目录: 图片落 image/、视频落 video/(前端不必先判类型)
//   · nameMode='keep' → 保留原名; 'auto' 或不传 = <用途>_<时间戳>.<ext>
//   · relPath         → 相对路径(如 `素材/子目录/a.png`), 会做安全清洗
// 2.4.2: relPath 的**目录部分在两种命名模式下都保留**(只换文件名), 且不再剥掉顶层文件夹名;
//        不传 relPath 的调用方(编辑页/弹窗)行为完全不变 —— keep 模式仍回退到 `file.name`(纯文件名, 无目录)。
// 2.4.3 新增一个可选入参:
//   · targetDir → 目标目录(素材库页的「目标路径」), 缺省仍是按类型落 `image/`、`video/`;
//                 2.6.5 起只要"干净的相对目录"就收(不再只认本入口素材根), 见 safeTargetDir; 它与 relPath(文件夹结构)**叠加**:
//                 key = `<targetDir>/<relPath 的目录部分>/<文件名>`。
export async function saveUpload(env, options) {
  const file = options.file;
  const purpose = String(options.purpose || 'cover');
  const auto = purpose === 'auto';
  const nameMode = options.nameMode === 'keep' ? 'keep' : 'auto';
  if (!file || typeof file.arrayBuffer !== 'function') return reject('未收到文件');
  const isVideoPurpose = purpose === 'video';
  const ext = extOf(file.name);
  const size = Number(file.size) || 0;
  if (!size) return reject('文件是空的，已跳过');

  const allowed = auto ? IMAGE_EXTS.concat(VIDEO_EXTS) : (isVideoPurpose ? VIDEO_EXTS : IMAGE_EXTS);
  if (!ext || !allowed.includes(ext)) {
    if (auto) return reject('只支持图片（jpg/jpeg/png/gif/webp）与视频（mp4/mov/m4v/webm），其它文件请先转换');
    return reject(isVideoPurpose
      ? '该字段只能上传视频（支持 mp4 / mov / m4v / webm）'
      : '该字段只能上传图片，视频请改用「视频素材库」或正文区的「本地上传」');
  }
  // auto 模式还不知道是图还是视频, 先按视频上限粗筛, 嗅探后再按各自上限判一次
  const limit = auto ? MAX_VIDEO_BYTES : (isVideoPurpose ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES);
  if (size > limit) return reject(`文件过大，最大允许 ${Math.floor(limit / 1024 / 1024)} MB`);

  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    return reject('文件读取失败，请重新上传');
  }
  const fitsImage = looksLikeImage(bytes);
  const fitsVideo = looksLikeVideo(bytes);
  let kind;
  if (auto) {
    // 只看内容不看扩展名: 有些导出的 .mov/.mkv 前端给的 mime 是空的, 按扩展名预判会误伤
    kind = fitsVideo && !fitsImage ? 'video' : (fitsImage && !fitsVideo ? 'image' : '');
    if (!kind) return reject('文件内容既不像图片也不像视频，已跳过');
    if (size > (kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) {
      return reject(`文件过大，最大允许 ${Math.floor((kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES) / 1024 / 1024)} MB`);
    }
  } else {
    if (isVideoPurpose ? !fitsVideo : !fitsImage) {
      return reject(isVideoPurpose ? '文件内容不是有效视频，请重新上传' : '文件内容不是有效图片，请重新上传');
    }
    kind = isVideoPurpose ? 'video' : 'image';
  }

  // 图片落 image/, 视频落 video/(历史素材仍在 news_uploads/, 两边都能直出与列举)
  // 2.4.3: 素材库页可以改"目标路径"; 2.6.5 起不再限制"必须在本入口素材根下面"(校验见 safeTargetDir)
  const target = safeTargetDir(options.targetDir, kind === 'video' ? VIDEO_PREFIX : IMAGE_PREFIX);
  if (!target.ok) return reject(target.message);
  const dir = target.dir;
  // 2.4.2: 目录结构两种模式都保留 —— 只有文件名部分跟着命名策略走。
  // keep 模式不传 relPath 时回退 `file.name`(纯文件名), 与 2.4.0 之前的编辑页/弹窗行为一致。
  const rel = safeRelPath(nameMode === 'keep' && !options.relPath ? file.name : (options.relPath || ''));
  const { dir: relDir, name: relName } = splitRel(rel);
  let desired;
  if (nameMode === 'keep') {
    desired = `${dir}${relDir}${relName || `upload.${ext}`}`;
    // 防御: 相对路径没带扩展名(或带错)时以真实文件的扩展名为准
    if (extOf(desired) !== ext) desired = `${desired}.${ext}`;
  } else {
    const prefix = kind === 'video' ? 'video' : ({ cover: 'cover', content: 'content' }[purpose] || 'img');
    // 自动生成只换文件名: 目录照带(同一批文件夹上传在 R2 里仍是同一棵树)
    desired = `${dir}${relDir}${prefix}_${Date.now()}.${ext}`;
  }

  const bucket = settings(env).storage;
  const key = await uniqueKey(bucket, desired);
  if (!key) return reject(`同名文件太多（已重试 ${MAX_KEY_TRIES} 次），请改名后再传或改用"自动生成"`);
  try {
    await bucket.put(key, bytes, {
      // cacheControl: 新对象不覆盖写 → 长缓存安全(2.3.9/2.4.0, 口径见 core/storage.js)
      httpMetadata: {
        // Content-Type 按"嗅探出来的类型 + 扩展名"定, 不采信客户端声明的 file.type
        // (公开域会照 Content-Type 下发, 采信客户端等于把 MIME 交给上传者)
        contentType: mediaContentType(ext, kind),
        cacheControl: CACHE_CONTROL_MEDIA
      }
    });
  } catch (error) {
    console.error('上传写 R2 失败', error && error.message);
    return reject('保存失败，请稍后重试');
  }
  return { ok: true, url: key, kind, message: '上传成功' };
}

// 2.7.1: 原来的 listMedia(全桶扫描的素材清单)已删除 —— 素材选择器与治理页一起改走
// lib/mediaBrowse.js 的逐层浏览, 不再有第二条"列素材"的实现(全桶扫描留给 core/storage.js 的
// listNewsMedia: 占用统计还在用它)。
// 2.4.0: 缩略图相关的导出(thumbKeyOf 转发、thumbUrlOf)已删除 —— 素材库与弹窗直接用原图。
