// 素材库管理(治理页, 仅超管) —— 逐条对齐旧站 app/admin/media_admin.py
//
// 旧站头注释点名的三条口径, 这里原样继承:
//   ① 这一页做的是**治理**(看占用 / 查引用 / 删无用文件), 不是"选素材" —— 选素材在字段旁的弹窗里;
//   ② **引用判定只有一个来源**: 列表列 /「查看引用」/ 删除前复查三处都调 scanReferences();
//      (旧站 v2.3.4 的 BUG 就是两处判定不一致: 等值比较 vs LIKE, 导致正文里的引用永远显示未引用)
//   ③ **引用检查必须包含回收站**: 软删除的笔记仍在库里、content 里仍写着路径,
//      否则会出现"删素材 → 恢复回收站 → 裂图"的静默事故。
//
// 平台差异(已在 README「已知差异」声明):
//   · 素材来源: 旧站 os.walk 本地目录 → 这里 R2 list(新目录 image//video/ + 历史目录 news_uploads/);
//   · 15 秒扫描短缓存: Worker 没有进程内状态, 不实现(每次真扫, 但对 R2 是读元信息, 成本低);
//   · 重命名: R2 没有 rename, 是"读→写→删"三步(见 core/storage.js 的 moveMediaFile);
//   · 批量删除: R2 的 delete 收数组(单次 ≤1000), 一批只花 1 次子请求 —— 但仍按 BATCH_MAX 分批,
//     因为引用扫描(9 条 D1) 要留在单请求的子请求预算内(免费套餐 50 次/请求)。
//
// 2.3.9 新增(全部复用既有接口与共用实现, 没有另造一套):
//   · 上传卡片 → 复用既有的 POST /admin/image_upload;
//   · 详情页 /admin/media_manage_detail(体积/类型/上传时间/Content-Type/引用明细 + 原图/视频预览);
//   · 改名/移动 /admin/media_manage_rename(改 key; 源或目标**任一有引用就拒绝**, 不擅自改写笔记内容);
//   · 删除扩成批量(同一个 /admin/media_manage_delete, 新增 `paths=` 逗号列表; 原来的 `path=` 仍兼容);
//   · 筛选新增"目录"与"引用状态"(前者复用共用的 searchSelect, 后者沿用 URL 参数 + 标签条那一套)。
//
// 2.4.0 变化:
//   · **缩略图(派生文件)整体移除** —— 列表不再探测/显示缩略图, 详情页直接用原图;
//     桶里历史遗留的 `<素材目录>_thumb/` 对象现在会作为普通素材出现在清单里(便于清理, 不自动删)。
//   · **上传升级** —— 文件/文件夹两种入口(文件夹保留内部子目录)、命名策略(自动生成 / 保留原名,
//     重名自动加 `_1` 绝不覆盖)、按内容分流到 image//video/、逐文件进度条 + 成功失败计数 + 失败重试/跳过。
//     前端用 XHR 的 upload.onprogress 拿进度(浏览器没有服务端进度), 一次请求一个文件、顺序上传。
//
// 2.6.5 三处修复(都不动上传的其它功能: 进度条/命名策略/目录结构保留一字未改):
//   · **引用误判** —— 根目录素材原先按"子串"判命中, 于是 `image/food/2017-2018.jpg` 会把根目录的
//     `2018.jpg` 判成"被引用"。现在按"整段路径相等"判(唯一实现在 core/storage.js 的 relPathsIn, 见那里的说明),
//     列表列/「查看引用」/详情/删除前复查仍共用 scanReferences 一处。
//   · **目标路径可选项** —— 原先只列"当前浏览层"的子目录, 站在 image/food/ 连 image/ 的兄弟目录都选不到;
//     2.6.5 改成扫全桶后又把各级目录全列出来(选项太长), 2.6.6 定为**只列桶根下的一级子目录**(列一层, 见 listPage)。
// 2.6.6 变化:
//   · 目标路径下拉只给桶根下的一级子目录(根目录选项、各入口默认项、手填入口都不变), 更深的目录仍用「其它（手动填写）」写;
//     少扫几十层目录, 素材库页也就少几十次 R2 子请求。
// 2.6.7 修复:
//   · 下拉原先另扫一份根层、还多一层"站内自有目录不进"的过滤, 与【存储桶根目录】后面那排按钮对不上(下拉少几个);
//     现在下拉直接用页面那份数据(根层) 或同参数的 listLevel(子目录时), 不再额外过滤。
//   · **目录按钮** —— 原先写死 存储桶根目录/image//video//news_uploads/ 五个; 现在跟着当前位置动态一层
//     (常态 = 存储桶根目录 + 根下子目录, 进了子目录就换成它的子目录), 返回上一层仍用面包屑或「上一级」。
import { escapeHtml } from '../../core/html.js';
import { settings } from '../../core/config.js';
import { all } from '../../core/db.js';
import { fmtBytes } from '../../core/overview.js';
import {
  CACHE_CONTROL_MEDIA, IMAGE_PREFIX, MEDIA_PREFIXES, VIDEO_PREFIX,
  checkObjectKey, copyObject, extOf, isRootTreePath, kindOfExt, listLevel, listUnder,
  mediaPrefixOf, moveObject, relPathsIn, removeObjects
} from '../../core/storage.js';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from '../lib/mediaUpload.js';
import { adminLayout } from '../lib/layout.js';
import {
  backButton, deleteConfirmCard, filterButtons, listFoot, listMeta, listToolbar, pageHeader,
  pagerScript, searchBar, searchInput, searchSelect, selectField, staticScript, textField
} from '../lib/partials.js';
import { PER_PAGE, auditLog, fmtDatetime, strOf, urlenc } from '../lib/utils.js';
import { json, redirect } from '../lib/http.js';

const LIST_URL = '/admin/media_manage';
const DELETE_URL = '/admin/media_manage_delete';
const REFS_URL = '/admin/media_manage_refs';
const DETAIL_URL = '/admin/media_manage_detail';
const RENAME_URL = '/admin/media_manage_rename';
//: 上传仍走既有端点(旧地址 /admin/news_image_upload 等价), 不新增上传接口
const UPLOAD_URL = '/admin/image_upload';

//: 一次批量最多几个: 一批 = 9 条引用扫描(D1, 并发) + 1 次 R2 批量删除;
//  免费套餐单请求子请求上限 50, 留余量给列表列举, 所以封在 20。
const BATCH_MAX = 20;
//: 列表里直接给原图预览的体积上限(缩略图移除后的折中): 小图直出看得见, 大图给占位,
//  否则一页 10 条几十 MB 的原图会拖慢治理页(详情页仍可看原图/视频)。
const PREVIEW_INLINE_MAX = 512 * 1024;

//: 根目录(存储桶最外层, 不带任何前缀)在**上传卡片**里的表示值:
//  空串已经被"没传 = 默认目录"占用, 所以另取一个哨兵值; 上传接口也认这个 `/`(见 lib/mediaUpload 的 safeTargetDir)。
const ROOT_DIR = '/';
const isRootDir = (value) => value === ROOT_DIR;


//: 类型筛选(按扩展名判定; 其它 = 既不是图片也不是视频)
const KIND_CHOICES = [['all', '全部类型'], ['image', '图片'], ['video', '视频'], ['other', '其它']];

//: 目录级移动一次最多几个对象: 每个对象 = head + get + put + delete(4 次 R2 子请求),
//  免费套餐单请求 50 次子请求, 10 个 = 40 次, 留余量给列举与引用扫描(超出会提示"还有 N 个, 可再次提交")。
const DIR_MOVE_MAX = 10;
//: 单层列举上限(R2 单次 list 上限就是 1000): 超过只列前 1000 个, 页面会提示用前缀缩小范围
const LEVEL_MAX = 1000;
//: 目录级操作(移动/删除)的确认与执行端点
const DIR_URL = '/admin/media_manage_dir';

//: 排序选项(与旧站 _SORT_CHOICES 同口径)
const SORT_CHOICES = [
  ['time_desc', '最新优先'],
  ['time_asc', '最早优先'],
  ['size_desc', '体积从大到小'],
  ['size_asc', '体积从小到大'],
  ['name_asc', '文件名 A→Z']
];

//: 其它引用来源(表, 列, 中文名) —— 只列"可能装素材相对路径的列"(与旧站 _OTHER_REF_SOURCES 一致)
const OTHER_REF_SOURCES = [
  ['banner_images', 'image_url', '轮播图'],
  ['motorcycle_trips', 'poster', '摩旅精选封面'],
  ['motorcycle_trips', 'videoUrl', '摩旅精选视频'],
  ['outdoor_activities', 'poster', '户外精选封面'],
  ['outdoor_activities', 'videoUrl', '户外精选视频'],
  ['app_home_sections', 'image_url', '首页板块图标'],
  ['app_featured_items', 'image_url', '首页精选图标']
];

function redirectTo(url) {
  return new Response(null, { status: 302, headers: { location: url } });
}

/** 返回地址收敛: 只接受本页地址(防开放重定向, 旧站 _safe_back 同口径)。 */
function safeBack(raw) {
  const value = strOf(raw);
  if (!value.startsWith(LIST_URL) || value.startsWith('//')) return LIST_URL;
  if (value.includes('\\') || value.includes('://')) return LIST_URL;
  const rest = value.slice(LIST_URL.length);
  if (rest && rest[0] !== '?' && rest[0] !== '#') return LIST_URL;
  return value;
}

function backWith(back, params) {
  // 返回地址自带查询串(类型/排序/关键词)时不能再拼 `?`, 否则第二个问号会变成参数值的一部分
  const search = new URLSearchParams();
  Object.keys(params || {}).forEach((key) => search.set(key, String(params[key])));
  const joiner = back.includes('?') ? '&' : '?';
  return `${back}${joiner}${search.toString()}`;
}

//: 粗筛的取行上限: 命中上限只说明"可能没扫全", 必须按没扫全处理(拒绝删除/改名), 不能当成"没被引用"
const REF_SCAN_LIMIT = 2000;
const OTHER_REF_SCAN_LIMIT = 500;

/**
 * 全库引用扫描 —— **唯一判定实现**(列表列 /「查看引用」/ 删除前复查三处共用)。
 * only 传入时只保留这批路径(列表页用, 免得为几百条素材攒无用条目)。
 * 返回 { ok, refs, truncated }: ok=false 表示**没扫全**(有一条查询失败, 或命中取行上限) ——
 * 把"扫不到"当成"没被引用"就会删掉仍在使用的素材(2026-10-07 线上事故), 所以调用方必须据 ok 拒绝破坏性操作。
 */
export async function scanReferences(env, only = null) {
  const hits = {};
  let failed = false;
  const keep = only ? new Set(only) : null;
  // 根目录那一块的记录值(裸文件名或根下自定义目录里的路径)没有"前缀"可筛, 只能按候选名单精确命中;
  // 只收图片/视频(站内资源如 assets/app.js 笔记引用不到, 收进来只会多匹配)
  const rootNames = keep
    ? [...keep].filter((one) => isRootTreePath(one) && Boolean(kindOfExt(extOf(one))))
    : [];
  const record = (value, source, id, title, recycle) => {
    for (const rel of relPathsIn(value, rootNames)) {
      if (keep && !keep.has(rel)) continue;
      if (!hits[rel]) hits[rel] = [];
      hits[rel].push({ source, id, title, recycle: Boolean(recycle) });
    }
  };

  // 粗筛: 任一素材目录命中就取回(真正的判定在 relPathsIn 的归一化等值比较)。
  // ⚠️ 每个 LIKE 都要写全列名: 曾经拼成 "image LIKE ? OR LIKE ? OR LIKE ?"(后两个没有列名),
  //    SQLite 直接语法报错, 又被下面的 catch 吞成"零命中" → 引用列整列显示"未引用"、
  //    删除前复查也一起失效(2026-10-07 线上事故; 桩测试看不出语法错, 见 tests 里那条 SQL 形状检查)。
  //
  // 2.4.4 根目录素材: 记录值就是 `logo.png` 这种裸文件名, 没有前缀可筛 ——
  //   · 粗筛加一组"按扩展名"的 LIKE(`%.png` 等): 与根目录里有多少文件无关, 多取到的行由 relPathsIn 精确判定;
  //   · 只有在**本次要查的集合里真的有根目录素材**时才加这组条件(否则保持原来的扫描量)。
  // 注: 这组条件会多取一些行, LIMIT 2000/500 的口径不变(与原来"凡是含 image/ 的行都取回"是同一类取舍)。
  const wantRoot = keep ? rootNames.length > 0 : true;
  const ROOT_LIKE_SUFFIXES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.mp4', '.mov', '.m4v', '.webm'];
  function likeGroup(column) {
    const parts = MEDIA_PREFIXES.map(() => `${column} LIKE ?`);
    const args = MEDIA_PREFIXES.map((prefix) => `%${prefix}%`);
    if (wantRoot) {
      for (const suffix of ROOT_LIKE_SUFFIXES) {
        parts.push(`${column} LIKE ?`);
        args.push(`%${suffix}`);
      }
    }
    return { sql: `(${parts.join(' OR ')})`, args };
  }
  // 查询失败要能在日志里看见(静默 catch 正是上面的“零命中”藏了两周的原因); 同时记 failed,
  // 让调用方知道"这次没扫全", 而不是拿着半份结果去删素材
  const softFail = (what) => (error) => {
    console.error('引用扫描失败', what, error && error.message);
    failed = true;
    return [];
  };

  // 9 条查询互不依赖 → 一起发: 每条都是一次 D1 往返, 顺序发就是 9 × RTT(D1 在西欧时接近 2 秒)
  const newsGroups = ['image', 'video_url', 'content'].map((column) => likeGroup(column));
  const jobs = [
    all(env,
      'SELECT id,title,image,video_url,content,deleted_at FROM news '
      + `WHERE ${newsGroups.map((group) => group.sql).join(' OR ')} LIMIT ${REF_SCAN_LIMIT}`,
      ...newsGroups.flatMap((group) => group.args)).catch(softFail('笔记'))
  ].concat(OTHER_REF_SOURCES.map(([table, column, label]) => {
    const group = likeGroup(`"${column}"`);
    return all(env,
      `SELECT id, "${column}" AS value FROM "${table}" WHERE ${group.sql} LIMIT ${OTHER_REF_SCAN_LIMIT}`,
      ...group.args).catch(softFail(label));
  }));
  const [newsRows, ...otherRows] = await Promise.all(jobs);
  // 命中上限说明"可能还有更多没取回来" —— 与查询失败一样算没扫全
  const truncated = newsRows.length >= REF_SCAN_LIMIT
    || otherRows.some((rows) => rows.length >= OTHER_REF_SCAN_LIMIT);

  // 笔记: 三个来源列一起看(deleted_at 两种状态都算 —— 回收站里的笔记同样算引用)
  for (const row of newsRows) {
    const recycle = row.deleted_at !== null && row.deleted_at !== undefined && strOf(row.deleted_at) !== '';
    record(row.image, '笔记 · 封面', row.id, row.title, recycle);
    record(row.video_url, '笔记 · 视频地址', row.id, row.title, recycle);
    record(row.content, '笔记 · 正文', row.id, row.title, recycle);
  }
  OTHER_REF_SOURCES.forEach(([, , label], index) => {
    for (const row of otherRows[index] || []) record(row.value, label, row.id, '', false);
  });
  return { ok: !failed && !truncated, refs: hits, truncated };
}

function sortItems(items, sort) {
  const list = items.slice();
  if (sort === 'time_asc') list.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  else if (sort === 'size_desc') list.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  else if (sort === 'size_asc') list.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  else if (sort === 'name_asc') list.sort((a, b) => a.name.localeCompare(b.name));
  else list.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return list;
}

function isSuper(ctx) {
  return Boolean(ctx.session && ctx.session.isSuper);
}

function denied(ctx) {
  return redirectTo('/admin/dashboard?error=' + encodeURIComponent('该页面仅超级管理员可访问'));
}

function jsonOrForm(ctx) {
  return ctx.form && Object.keys(ctx.form).length ? ctx.form : ctx.body || {};
}

/**
 * 批量参数解析: `paths` 是 **JSON 数组**。
 * 为什么不用逗号分隔: 对象键里允许逗号, `image/a,b.png` 会被拆成两个键 —— 那就删错对象了。
 * 解析不出来就回空数组(调用方按"参数错误"处理), 绝不"尽力而为"地拆。
 */
function keysOf(rawPaths) {
  const text = strOf(rawPaths);
  if (!text) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.error('批量对象键不是合法 JSON, 已拒绝:', text.slice(0, 120));
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const list = [];
  for (const piece of parsed) {
    const checked = checkObjectKey(piece);
    if (checked.ok && !list.includes(checked.key)) list.push(checked.key);
  }
  return list;
}

/** 单条路径(旧地址 ?path= / 行内删除链接) → [键](不合法回空数组)。 */
function singleKeys(rawPath) {
  const checked = checkObjectKey(strOf(rawPath));
  return checked.ok ? [checked.key] : [];
}

/** 对象键的父目录(带尾斜杠; 桶根返回空串)。 */
function parentOf(key) {
  const slash = String(key || '').lastIndexOf('/');
  return slash < 0 ? '' : String(key).slice(0, slash + 1);
}

/** 文件类型: 按扩展名判(image/video/other), 与素材库口径一致(kindOfExt)。 */
function kindOfFile(key) {
  return kindOfExt(extOf(String(key || ''))) || 'other';
}

/**
 * 这个键是不是"素材"(决定要不要做引用扫描、以及引用列显示什么):
 *   · 素材目录下的(`image/`、`video/`、`news_uploads/`)一律算(历史目录里可能混着非媒体文件, 但仍按素材口径查);
 *   · 根目录树里的**必须带图片/视频扩展名**才算 —— `assets/app.js`、`images/site.png` 这类是站内资源,
 *     笔记引用不到它们, 白扫 9 条 D1 查询还会把"未引用"写得到处都是。
 */
function isMediaKey(key) {
  const text = String(key || '');
  if (mediaPrefixOf(text)) return true;
  return isRootTreePath(text) && Boolean(kindOfExt(extOf(text)));
}

/** 本层里的对象排序(2.4.6): 与旧的 sortItems 同口径, 只是数据换成 {key,name,size,mtime}。 */
function sortFiles(items, sort) {
  const list = items.slice();
  if (sort === 'time_asc') list.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  else if (sort === 'time_desc') list.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  else if (sort === 'size_desc') list.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  else if (sort === 'size_asc') list.sort((a, b) => a.size - b.size || a.name.localeCompare(b.name));
  else list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

/** 面包屑 + 「上一级」(2.4.6): 每一段都可点回该层; 根目录就是存储桶本身。 */
function crumbsHtml(prefix) {
  const pieces = String(prefix || '').split('/').filter(Boolean);
  const links = [`<a href="${LIST_URL}">存储桶</a>`];
  let walked = '';
  pieces.forEach((piece) => {
    walked += `${piece}/`;
    links.push(`<a href="${LIST_URL}?prefix=${urlenc(walked)}">${escapeHtml(piece)}</a>`);
  });
  const up = pieces.length
    ? `<a class="btn btn-sm btn-outline-secondary" href="${LIST_URL}?prefix=${urlenc(parentOf(prefix))}">`
      + '<i class="bi bi-arrow-up" aria-hidden="true"></i> 上一级</a>'
    : '';
  return `<div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      <nav aria-label="所在目录" class="small">${links.join(' <span class="text-muted">/</span> ')}</nav>
      ${up}
    </div>`;
}

function mbOf(bytes) {
  return `${Math.floor(Number(bytes) / 1024 / 1024)} MB`;
}

/**
 * 引用明细区块(详情页与改名确认页共用): 逐条给出中文来源 + 跳转, 笔记直接链到编辑页。
 * ok=false 表示这次扫描没扫全(见 scanReferences 的返回值): 必须先警告"结果可能不全", 不能说"没有任何引用"。
 */
function refsBlock(refs, ok = true) {
  const incomplete = ok
    ? ''
    : '<div class="alert alert-warning py-2">引用扫描未完成（查询失败或超出取行上限），下面只是已扫到的部分；'
      + '改名与删除都会被拒绝，请稍后重试。</div>';
  if (!refs.length) {
    return ok ? '<div class="alert alert-success py-2 mb-0">没有任何引用，可以安全改名或删除。</div>' : incomplete;
  }
  const rows = refs.map((ref) => {
    const link = ref.source.startsWith('笔记')
      ? `<a href="/admin/news_edit?id=${encodeURIComponent(ref.id)}" target="_blank" rel="noopener">笔记 #${escapeHtml(ref.id)}</a>`
      : `<span class="text-muted">#${escapeHtml(ref.id)}</span>`;
    return `<li>${escapeHtml(ref.source)} ${link}${ref.title ? ` · ${escapeHtml(ref.title)}` : ''}`
      + `${ref.recycle ? ' <span class="badge text-bg-warning">回收站</span>' : ''}</li>`;
  }).join('');
  return `${incomplete}<div class="alert alert-warning py-2">这个素材被 <b>${refs.length}</b> 处引用（含回收站）：</div>
    <ul class="mb-0">${rows}</ul>`;
}

//: 引用扫描没扫全时的统一拒绝文案(确认页与提交处共用, 免得两处口径不一致)
const REF_SCAN_INCOMPLETE = '引用扫描未完成（查询失败或超出取行上限），已拒绝本次操作，请稍后重试';

/**
 * 上传卡片(2.4.1 拆分入口 + 2.4.2 文案与目录保留):
 *   · 图片与视频分成两个入口, 类型由入口决定(图片→image/、视频→video/), 服务端仍按文件头校验内容。
 *   · 每个入口两个按钮:「选择文件」= 多选文件、「选择文件夹」= 整个文件夹(含子目录)。
 *     原生 file 控件的按钮文字由浏览器决定(webkitdirectory 在 Chrome 里也只显示"选择文件"),
 *     所以这里把 input 隐藏(visually-hidden, 仍可被键盘聚焦与触发), 用 label 按钮显示我们自己的文案。
 *   · 文件夹上传会把**整棵目录树**带上(含选中的那层文件夹名), 两种命名模式都保留目录(见 send() 与 lib/mediaUpload)。
 */
function uploadCard(dirs = []) {
  // 两个入口共用同一段结构(2.4.1 是两段逐字复制的标记, 文案与属性很容易改漏一处)
  // 2.4.3: 每个入口多一个「目标路径」下拉 —— 原生 select 给"桶里已存在的目录", 也可以手填新目录。
  const pickers = ({ tab, title, icon, dir, purpose, accept, limit, unit }) => {
    const root = `${dir}/`;
    // 可选项(2.6.7): 根目录 → 本入口根目录(默认) → 桶根下的一级子目录(与【存储桶根目录】后面那排按钮同一份数据) → 「其它（手动填写）」兜底。
    // 只给一级子目录是刻意的: 更深层级用「其它」手填(下拉选项太多反而难选), 见 listPage 处的说明。
    // 不再额外过滤任何目录(2.6.7 删掉了原来的"站内自有目录不进下拉"): 下拉与桶页那排按钮必须逐字一致, 否则就是"显示不全"。
    const others = dirs.filter((one) => one !== root);
    const options = [[ROOT_DIR, '根目录（存储桶最外层）'], [root, `${root}（默认）`]]
      .concat(others.map((one) => [one, one]))
      .map(([value, text]) => `<option value="${escapeHtml(value)}"${value === root ? ' selected' : ''}>`
        + `${escapeHtml(text)}</option>`)
      .join('');
    return `<div class="col-lg-6">
        <span class="form-label d-block" id="mediaUpload${tab}Label">
          <i class="bi ${icon}" aria-hidden="true"></i> ${title}上传 → <code>${root}</code>
        </span>
        <div class="d-flex gap-2 mb-2" role="group" aria-labelledby="mediaUpload${tab}Label">
          <label class="btn btn-sm btn-outline-secondary mb-0" for="mediaUpload${tab}Files">选择文件</label>
          <label class="btn btn-sm btn-outline-secondary mb-0" for="mediaUpload${tab}Folder">选择文件夹</label>
        </div>
        <input class="visually-hidden" type="file" id="mediaUpload${tab}Files" data-purpose="${purpose}"
               multiple accept="${accept}" aria-label="选择${title}文件（可多选）">
        <input class="visually-hidden" type="file" id="mediaUpload${tab}Folder" data-purpose="${purpose}"
               webkitdirectory directory multiple aria-label="选择${title}文件夹（含子目录）">
        <div class="form-text">上：${title}文件（可多选）；下：整个文件夹。${unit} ≤ ${limit}。</div>
        <label class="form-label mt-2 mb-1" for="mediaUpload${tab}Dir">目标路径</label>
        <select class="form-select form-select-sm" id="mediaUpload${tab}Dir"
                data-root="${escapeHtml(root)}" data-manual="mediaUpload${tab}DirManual"
                aria-label="${title}上传的目标路径（默认 ${escapeHtml(root)}）">
          ${options}
          <option value="__manual">其它（手动填写）</option>
        </select>
        <input class="form-control form-control-sm mt-1 d-none" type="text" id="mediaUpload${tab}DirManual"
               placeholder="如 ${escapeHtml(root)}2026-10/" aria-label="手动填写${title}上传的目标路径">
        <div class="form-text">默认 <code>${root}</code>；下拉里是根目录 + 桶根下的一级子目录，要归档到更深层或新目录就选「其它」手填（
          相对目录即可，不能有 <code>..</code> 或以 <code>/</code> 开头）。</div>
      </div>`;
  };
  return `<div class="card mb-3"><div class="card-body">
    <h6 class="mb-2">上传素材</h6>
    <div class="row g-3">
      ${pickers({
    tab: 'Image', title: '图片', icon: 'bi-image', dir: 'image', purpose: 'cover',
    accept: 'image/*', limit: mbOf(MAX_IMAGE_BYTES), unit: '单张'
  })}
      ${pickers({
    tab: 'Video', title: '视频', icon: 'bi-film', dir: 'video', purpose: 'video',
    accept: 'video/*', limit: mbOf(MAX_VIDEO_BYTES), unit: '单个'
  })}
      <div class="col-12">
        <div class="alert alert-secondary py-2 mb-0 small">
          选文件夹会把<strong>整棵目录树</strong>一起传上去（含你选中的那层文件夹名）：图片入口拼到
          <code>image/</code> 后面、视频入口拼到 <code>video/</code> 后面 —— 例如选文件夹「素材」里有
          <code>相册/图.png</code> 与 <code>根目录图.png</code>，则落成 <code>image/素材/相册/图.png</code> 与
          <code>image/素材/根目录图.png</code>。<strong>两种命名模式都保留目录</strong>：「保留原名」文件名也不变，
          「自动生成」只把文件名换成 <code>&lt;用途&gt;_时间戳.ext</code>。空文件夹不会被保留（R2 没有目录，浏览器也不会把空目录列出来）。
          <br><strong>目标路径</strong>默认就是各入口的 <code>image/</code> 与 <code>video/</code>，下拉里可选的还有
          <strong>根目录</strong>（存储桶最外层，不带任何前缀；选文件夹时目录结构会直接铺在根下，如
          <code>素材/子/图.png</code> —— 这些内容素材库列表与素材选择器同样能看到，列表里「目录」列显示"根目录"）与桶根下的一级子目录；
          要归档到更深层或新目录就选「其它」手填（如 <code>image/2026-10/</code>）。
          <strong>2.6.5 起手填目录不再要求以 <code>image/</code> 或 <code>video/</code> 开头</strong>，只要是干净的相对目录就行
          （不能有 <code>..</code>、不能以 <code>/</code> 开头）；代价是写进"素材库不扫的目录"（比如把图片写进 <code>video/</code>）时，
          那些对象在素材库列表与素材选择器里列不出来（公开域直读不受影响）。文件落在该路径下面，文件夹结构也在它下面继续保留。
        </div>
      </div>
      <div class="col-12 d-flex flex-wrap align-items-center gap-3">
        <span class="form-label mb-0">命名</span>
        <div class="form-check form-check-inline mb-0">
          <input class="form-check-input" type="radio" name="mediaNameMode" id="mediaNameAuto" value="auto" checked>
          <label class="form-check-label" for="mediaNameAuto">自动生成（<code>&lt;用途&gt;_时间戳.ext</code>）</label>
        </div>
        <div class="form-check form-check-inline mb-0">
          <input class="form-check-input" type="radio" name="mediaNameMode" id="mediaNameKeep" value="keep">
          <label class="form-check-label" for="mediaNameKeep">保留原名（重名自动加 <code>_1</code>）</label>
        </div>
        <button class="btn btn-sm btn-primary" type="button" id="mediaUploadStart" disabled>开始上传</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" id="mediaUploadClear">清空</button>
      </div>
      <div class="col-12">
        <div class="progress" role="progressbar" aria-label="整体上传进度" style="height:1rem">
          <div class="progress-bar" id="mediaUploadBar" style="width:0%">0%</div>
        </div>
        <div class="small text-muted mt-1" id="mediaUploadOverall" role="status" aria-live="polite">等待选择文件…</div>
        <div class="small text-muted" id="mediaUploadCurrent"></div>
        <ul class="list-unstyled small mt-2 mb-0" id="mediaUploadFailed"></ul>
        <div class="mt-2" id="mediaUploadDone"></div>
      </div>
    </div>
  </div></div>`;
}

//: 页面脚本已搬到 static/js/media_govern.js(2.5.0): 放在模板字符串里改一处极易整段崩坏
//: (反斜杠会被求值吃掉、反引号会截断脚本)。这里只保留它需要的两个常量, 通过 window 注入。
const MEDIA_GOVERN_CFG = `<script>window.__mediaGovernCfg = ${JSON.stringify({
  batchMax: BATCH_MAX, uploadUrl: UPLOAD_URL
})};</script>`;

//: 触底加载的行片段端点(只给**路径**, 查询参数由前端按 location.search 拼 —— 带筛选翻页才不丢条件)
const ROWS_URL = '/admin/media_manage_rows';

/**
 * 目录浏览取数(2.4.6, 取代 2.4.1~2.4.5 的"全桶素材清单"):
 *   · **一次列举当前这一层**(前缀 + `delimiter: '/'`): 拿到子目录与直接对象 —— 按需加载, 不再全桶扫描;
 *   · 过滤(类型/关键词)、排序、分页都在**本层**内做(语义就是"当前目录里的这些对象");
 *   · 引用: 只有本层确实含素材键时才扫(素材目录里或根目录树里), 默认只查**本页**那几条(省 9 条 D1 查询);
 *     带"引用状态"筛选时才查本层全部(否则没法分页);
 *   · `truncated` = 这一层超过 LEVEL_MAX(1000) 个, 页面会提示用前缀/关键词缩小范围。
 */
async function browseQuery(ctx) {
  const rawPrefix = strOf(ctx.query.prefix);
  const prefixCheck = rawPrefix === '' ? { ok: true, key: '' } : checkObjectKey(rawPrefix, { asDir: true });
  const prefix = prefixCheck.ok ? prefixCheck.key : '';
  const q = strOf(ctx.query.q).toLowerCase();
  const kind = KIND_CHOICES.some(([value]) => value === strOf(ctx.query.kind)) ? strOf(ctx.query.kind) : 'all';
  const sort = SORT_CHOICES.some(([value]) => value === strOf(ctx.query.sort)) ? strOf(ctx.query.sort) : 'name_asc';
  const ref = strOf(ctx.query.ref) === 'used' ? 'used' : strOf(ctx.query.ref) === 'unused' ? 'unused' : '';
  const wantsPage = Math.max(1, Number(strOf(ctx.query.page)) || 1);

  const level = await listLevel(ctx.env, prefix, { limit: LEVEL_MAX });
  let files = level.objects;
  if (kind !== 'all') files = files.filter((one) => kindOfFile(one.key) === kind);
  if (q) files = files.filter((one) => one.key.toLowerCase().includes(q));
  // 浏览 avatar/、站点资源这类目录时不做引用扫描(白花 9 条 D1 查询)
  const mediaish = files.some((one) => isMediaKey(one.key));
  let refs = {};
  let refsOk = true;
  if (mediaish && ref) {
    const scan = await scanReferences(ctx.env, files.map((one) => one.key));
    refs = scan.refs;
    refsOk = scan.ok;
  }
  const sorted = sortFiles(files, sort);
  // 没扫全时不做"已引用/未引用"筛选: 那会把整层都当成"未引用", 比不筛更误导
  const filtered = ref && refsOk
    ? sorted.filter((one) => (ref === 'used' ? (refs[one.key] || []).length > 0 : (refs[one.key] || []).length === 0))
    : sorted;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const page = Math.min(wantsPage, totalPages);
  const pageItems = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  if (mediaish && !ref) {
    const scan = await scanReferences(ctx.env, pageItems.map((one) => one.key));
    refs = scan.refs;
    refsOk = scan.ok;
  }
  return {
    prefix, q, kind, sort, ref, folders: level.folders, filtered, totalPages, page, pageItems, refs, refsOk,
    truncated: level.truncated, levelCount: level.objects.length, mediaish,
    base: String(settings(ctx.env).mediaBase || '').replace(/\/+$/, ''),
    currentUrl: ctx.url.pathname + ctx.url.search
  };
}

//: 文件行 HTML(首屏与触底加载共用): 必须一处渲染, 否则两处的列/文案会各走各的
function levelRows(files, data) {
  return files.map((item) => {
    const itemRefs = data.refs[item.key] || [];
    const recycle = itemRefs.some((ref) => ref.recycle);
    const kind = kindOfFile(item.key);
    const refCell = !data.mediaish
      ? '<span class="text-muted">—</span>'
      : (data.refsOk === false
        // 没扫全时不敢说"未引用": 说"未引用"会让人放心去删, 而删除入口自己还会再复查一次(那里会直接拒绝)
        ? '<span class="text-muted" title="引用扫描未完成（查询失败或超出取行上限），这次不做引用判断">扫描未完成</span>'
        : (itemRefs.length
          ? `<a href="${REFS_URL}?path=${urlenc(item.key)}" target="_blank" rel="noopener">${itemRefs.length} 处</a>${recycle ? ' <span class="badge text-bg-warning">含回收站</span>' : ''}`
          : '<span class="text-muted">未引用</span>'));
    const url = data.base ? `${data.base}/${item.key}` : '';
    // 2.4.0: 缩略图没了 —— 小图(≤512KB)直接给原图预览, 其它给图标;
    // 免得"打开治理页顺带下几十 MB 原图"; 要看原图/视频点「详情」。
    const thumb = kind === 'image' && item.size <= PREVIEW_INLINE_MAX && url
      ? `<img src="${escapeHtml(url)}" class="cover-thumb" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
      : `<span class="text-muted small"><i class="bi ${kind === 'video' ? 'bi-camera-video' : (kind === 'image' ? 'bi-image' : 'bi-file-earmark')}" aria-hidden="true"></i> ${kind === 'image' ? '无预览' : (kind === 'video' ? '视频' : '文件')}</span>`;
    const open = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(item.key)}</a>`
      : escapeHtml(item.key);
    const back = urlenc(data.currentUrl);
    return `<tr data-media-row>
      <td><input type="checkbox" class="form-check-input" data-media-pick value="${escapeHtml(item.key)}" aria-label="选择 ${escapeHtml(item.key)}"></td>
      <td>${thumb}</td>
      <td class="cell-title"><div class="text-truncate" title="${escapeHtml(item.key)}">${open}</div></td>
      <td class="text-nowrap">${kind === 'image' ? '图片' : (kind === 'video' ? '视频' : '<span class="text-muted">其它</span>')}</td>
      <td class="text-nowrap">${fmtBytes(item.size)}</td>
      <td class="text-nowrap">${escapeHtml(fmtDatetime(item.uploaded ? new Date(item.mtime) : ''))}</td>
      <td class="text-nowrap"><code class="small">${escapeHtml(String(item.etag || '').slice(0, 10))}</code></td>
      <td>${refCell}</td>
      <td class="text-end text-nowrap">
        <a class="btn btn-sm btn-outline-secondary" href="${DETAIL_URL}?path=${urlenc(item.key)}&amp;back=${back}">详情</a>
        <a class="btn btn-sm btn-outline-secondary" href="${RENAME_URL}?path=${urlenc(item.key)}&amp;back=${back}">改名/移动</a>
        <a class="btn btn-sm btn-outline-secondary" href="${RENAME_URL}?copy=1&amp;path=${urlenc(item.key)}&amp;back=${back}">复制</a>
        <a class="btn btn-sm btn-outline-danger" href="${DELETE_URL}?path=${urlenc(item.key)}&amp;back=${back}">删除</a>
      </td>
    </tr>`;
  }).join('');
}

//: 目录行(只在首屏渲染; 触底加载追加的是文件行): 进入 / 移动 / 删除
function folderRows(folders, currentUrl) {
  const back = urlenc(currentUrl);
  return folders.map((folder) => `<tr class="table-light">
      <td></td>
      <td><i class="bi bi-folder2-open" aria-hidden="true"></i></td>
      <td class="cell-title"><div class="text-truncate" title="${escapeHtml(folder.key)}"><a href="${LIST_URL}?prefix=${urlenc(folder.key)}">${escapeHtml(folder.name)}/</a></div></td>
      <td class="text-nowrap text-muted">目录</td>
      <td class="text-muted">—</td><td class="text-muted">—</td><td class="text-muted">—</td><td class="text-muted">—</td>
      <td class="text-end text-nowrap">
        <a class="btn btn-sm btn-outline-primary" href="${LIST_URL}?prefix=${urlenc(folder.key)}">进入</a>
        <a class="btn btn-sm btn-outline-secondary" href="${DIR_URL}?action=move&amp;prefix=${urlenc(folder.key)}&amp;back=${back}">移动</a>
        <a class="btn btn-sm btn-outline-danger" href="${DIR_URL}?action=delete&amp;prefix=${urlenc(folder.key)}&amp;back=${back}">删除</a>
      </td>
    </tr>`).join('');
}

async function listPage(ctx) {
  if (!isSuper(ctx)) return denied(ctx);
  // 目标路径下拉必须与【存储桶根目录】后面那排目录一致(2.6.7): 站在根目录就直接复用页面这份数据(零额外列举),
  // 站在子目录时才补一次**同参数**的根层列举 —— 两处始终出自 listLevel, 不再各扫一份、各有各的过滤
  const data = await browseQuery(ctx);
  const rootLevel = data.prefix === '' ? data : await listLevel(ctx.env, '', { limit: LEVEL_MAX });
  const dirs = rootLevel.folders.map((one) => one.key);
  const rows = folderRows(data.folders, data.currentUrl) + levelRows(data.pageItems, data);

  // 筛选组: 与留言管理页同一套(共用 filterButtons); 切筛选/切目录都回到第 1 页(不带页码)
  const filterBar = filterButtons({
    baseUrl: LIST_URL, param: 'kind', active: data.kind, label: '按类型筛选',
    extra: { prefix: data.prefix, q: strOf(ctx.query.q), sort: data.sort, ref: data.ref },
    items: KIND_CHOICES
  });
  const search = searchBar({
    action: LIST_URL,
    hidden: `<input type="hidden" name="prefix" value="${escapeHtml(data.prefix)}">`
      + `<input type="hidden" name="kind" value="${escapeHtml(data.kind === 'all' ? '' : data.kind)}">`,
    body: searchSelect({ name: 'sort', value: data.sort, items: SORT_CHOICES, autoSubmit: true })
      + searchSelect({ name: 'ref', value: data.ref, items: [['', '全部引用状态'], ['used', '已引用'], ['unused', '未引用']] })
      + searchInput({ name: 'q', value: strOf(ctx.query.q), placeholder: '按对象键搜索（本层）' })
  });
  // 目录按钮(2.6.5): 跟着当前位置动 —— 常态是「存储桶根目录」(在根时高亮) + 根下的子目录;
  // 进了某个子目录就换成该子目录下的子目录。原先写死的 image/ / video/ / news_uploads/ 三个按钮已并入这一层
  // (它们本来就是根目录的子目录), 不再单独占位。返回上一层用上面的面包屑或「上一级」。
  const quick = [`<a class="btn btn-sm ${data.prefix === '' ? 'btn-primary' : 'btn-outline-secondary'}"`
    + ` href="${LIST_URL}">存储桶根目录</a>`]
    .concat(data.folders.map((folder) => `<a class="btn btn-sm btn-outline-secondary"`
      + ` href="${LIST_URL}?prefix=${urlenc(folder.key)}">${escapeHtml(folder.name)}/</a>`))
    .join('');

  const content = `${pageHeader({ icon: 'bi-hdd-stack', title: '存储桶资源管理' })}
${uploadCard(dirs)}
 <div class="card mb-3"><div class="card-body">
    ${crumbsHtml(data.prefix)}
    <div class="d-flex flex-wrap gap-2 mb-2">${quick}</div>
    ${listToolbar({ filters: filterBar, search })}
    <div class="small text-muted">
      ${listMeta({
    total: data.filtered.length, perPage: PER_PAGE, loadedPage: data.page, totalPages: data.totalPages,
    unit: '个对象', hintId: 'mediaLoadedHint'
  })}
      · 本层列到 ${data.levelCount} 个对象、${data.folders.length} 个子目录${data.truncated
    ? '，<span class="text-danger">已到单层 1000 上限（R2 单次列举上限），请用前缀/关键词缩小范围</span>' : ''}
    </div>
  </div></div>
  <div class="card"><div class="card-body">
    <form method="get" action="${DELETE_URL}" id="mediaBatchForm" class="d-flex flex-wrap align-items-center gap-2 mb-2">
      <input type="hidden" name="paths" id="mediaBatchPaths">
      <input type="hidden" name="back" value="${escapeHtml(data.currentUrl)}">
      <span class="small text-muted">删除不可恢复；素材路径（含根目录树）仍做引用检查，有一个被引用就整批拒绝（一次最多 ${BATCH_MAX} 个）。</span>
      <button class="btn btn-sm btn-outline-danger" type="submit" id="mediaBatchDelete" disabled>删除所选</button>
      <span class="small" id="mediaBatchCount">已选 0 个</span>
    </form>
    <div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
      <thead><tr>
        <th><input type="checkbox" class="form-check-input" id="mediaPickAll" aria-label="全选已加载的文件"></th>
        <th>预览</th><th>对象键</th><th>类型</th><th>大小</th><th>修改时间</th><th>ETag</th><th>引用</th><th></th>
      </tr></thead>
      <tbody id="mediaTbody">${rows || `<tr><td colspan="9" class="text-muted">这个目录下没有内容（对象存储里没有"空的目录"，换个前缀或先上传一个文件）</td></tr>`}</tbody>
    </table></div>
    ${listFoot({
    sentinelId: 'mediaLoadMore', textId: 'mediaLoadMoreText',
    currentPage: data.page, totalPages: data.totalPages, total: data.filtered.length, unit: '个对象',
    backTopId: 'mediaBackTopBtn',
    // 与笔记管理页一致: 滚动加载下不提供「跳至 N 页」(跳过去只会看到那一页的行)
    jump: false
  })}
    <div class="small text-muted mt-3">
      · 列表只列<strong>当前这一层</strong>（前缀 + 分隔符 <code>/</code>）：进子目录点上面的目录按钮（跟着当前位置换一层）、行内「进入」或面包屑，
      返回上一层用面包屑里点任意一段或「上一级」；对象键就是完整路径，
      公开地址 = <code>${escapeHtml(data.base || '（未配置 MEDIA_BASE）')}</code>/对象键（R2 公开域直读，不经 Worker）。
      <br>· <strong>目录不是实体</strong>：R2 里只有对象键，<code>/</code> 只是名字的一部分 —— 所以"新建目录"= 上传时把目标路径写成它（上传卡片的「目标路径」就支持），
      "空目录"也不存在（没有对象的目录自然消失）。
      <br>· 移动 / 复制 / 删除都<strong>绝不覆盖已有对象</strong>（目标已存在就拒绝）；素材路径（<code>image/</code>、<code>video/</code>、<code>news_uploads/</code> 与根目录树）仍受引用检查保护：
      有引用就整批拒绝，且<strong>不擅自改写笔记里的引用</strong>（要先在笔记里改地址）。
      <br>· 缩略图（派生文件）已按 2.4.0 移除，列表/详情/预览一律用原图；新上传对象带
      <code>Cache-Control: ${escapeHtml(CACHE_CONTROL_MEDIA)}</code>。全桶媒体占用统计在「系统信息」页（这里不再全桶扫描，只列举当前层）。
    </div>
  </div></div>
`;

  return adminLayout(Object.assign({}, ctx, {
    title: '存储桶资源管理', currentPage: 'media_manage', content,
    // 触底加载与回到顶部全部走共用的 infinite_scroll.js(与笔记/用户/留言等页同一实现)
    // rowsUrl 只给端点路径: 参数由 AdminListLoader 按 location.search 拼, 带 prefix/kind/ref/q 翻页都不会串
    scripts: pagerScript({
      tbodyId: 'mediaTbody', sentinelId: 'mediaLoadMore', textId: 'mediaLoadMoreText',
      rowsUrl: ROWS_URL, currentPage: data.page, totalPages: data.totalPages, total: data.filtered.length,
      perPage: PER_PAGE, unit: '个对象', hintId: 'mediaLoadedHint', announceLabel: '目录内容',
      backTopId: 'mediaBackTopBtn', jump: false, rowMarker: 'data-media-row', version: ctx.version
    }) + MEDIA_GOVERN_CFG + staticScript('js/media_govern.js', ctx.version)
  }));
}

//: 触底加载的行片段: 与首屏同一套取数(browseQuery)与渲染(levelRows), 只回传文件行 <tr>
async function rowsFragment(ctx) {
  if (!isSuper(ctx)) return json({ success: false, message: '该页面仅超级管理员可访问' });
  let data = null;
  try {
    data = await browseQuery(ctx);
  } catch (error) {
    console.error('目录分页失败', error && error.message);
    return json({ success: false, message: '加载失败，请稍后重试' });
  }
  // 越界/没有数据时回空串: 前端据此判"到底了"并停止加载(返回一行"暂无"会被当成数据继续翻页)
  if (!data.pageItems.length) return json({ success: true, rows: '', has_more: false });
  return json({ success: true, rows: levelRows(data.pageItems, data), has_more: data.page < data.totalPages });
}

async function refsJson(ctx) {
  if (!isSuper(ctx)) return json({ success: false, message: '该页面仅超级管理员可访问' });
  const checked = checkObjectKey(strOf(ctx.query.path));
  if (!checked.ok) return json({ success: false, message: '参数错误' });
  const path = checked.key;
  // 非素材路径(站点资源等)笔记引用不到, 直接回空, 不做 9 条 D1 查询
  if (!isMediaKey(path)) return json({ success: true, path, total: 0, items: [] });
  const scan = await scanReferences(ctx.env, [path]);
  if (!scan.ok) return json({ success: false, message: REF_SCAN_INCOMPLETE });
  const items = scan.refs[path] || [];
  return json({ success: true, path, total: items.length, items });
}

async function deleteGet(ctx) {
  if (!isSuper(ctx)) return denied(ctx);
  const keys = strOf(ctx.query.paths) ? keysOf(ctx.query.paths) : singleKeys(ctx.query.path);
  const back = safeBack(ctx.query.back);
  if (!keys.length) return redirectTo(backWith(LIST_URL, { error: '参数错误' }));
  if (keys.length > BATCH_MAX) {
    return redirectTo(backWith(back, { error: `一次最多删除 ${BATCH_MAX} 个对象，请分次操作` }));
  }
  // 引用检查只对**素材路径**有意义(image/、video/、news_uploads/ 与根目录树); 站点资源(images/、avatar/)不会被笔记引用, 不做扫描
  const mediaKeys = keys.filter((key) => isMediaKey(key));
  const scan = mediaKeys.length ? await scanReferences(ctx.env, mediaKeys) : { ok: true, refs: {} };
  // 没扫全就不给确认页: 否则页面会摆出一份"看着没引用"的清单, 而提交处还会再拒一次
  if (!scan.ok) return redirectTo(backWith(back, { error: REF_SCAN_INCOMPLETE }));
  const refs = scan.refs;
  const blocked = mediaKeys.filter((path) => (refs[path] || []).length > 0);

  // 只要有一个还被引用就整批拒绝(部分成功最容易让人以为"都删了") —— 删了不可恢复。
  // 单条走原来那句文案(与旧站一致), 批量才用"整批拒绝"的说法。
  const body = blocked.length
    ? (keys.length === 1
      ? `<div class="alert alert-warning mb-3">这个素材还被 ${(refs[keys[0]] || []).length} 处引用，<b>不能删除</b>。请先改掉引用（或清理回收站）再来。</div>
         <ul class="mb-3">${(refs[keys[0]] || []).map((ref) => `<li>${escapeHtml(ref.source)} · #${escapeHtml(ref.id)}${ref.title ? ` · ${escapeHtml(ref.title)}` : ''}${ref.recycle ? ' <span class="badge text-bg-warning">回收站</span>' : ''}</li>`).join('')}</ul>
         <div class="d-flex gap-2">${backButton(back, '返回资源列表')}<a class="btn btn-sm btn-outline-secondary" href="${REFS_URL}?path=${urlenc(keys[0])}" target="_blank" rel="noopener">查看引用明细</a></div>`
      : `<div class="alert alert-warning mb-3">选中的 ${keys.length} 个对象里有 <b>${blocked.length}</b> 个还被引用，<b>整批拒绝</b>（一个都没删）。</div>
         <ul class="mb-3">${blocked.map((path) => `<li><code>${escapeHtml(path)}</code>：${(refs[path] || []).length} 处引用
           <a class="ms-2" href="${REFS_URL}?path=${urlenc(path)}" target="_blank" rel="noopener">看引用</a></li>`).join('')}</ul>
         <div class="d-flex gap-2">${backButton(back, '返回资源列表')}</div>`)
    : `<div class="alert alert-secondary">即将删除 ${keys.length} 个对象：
         <ul class="mb-0 mt-2">${keys.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join('')}</ul>
       </div>
       ${deleteConfirmCard({
      title: '删除对象',
      impact: [['待删除对象', keys.length]],
      totalImpact: keys.length,
      submitAction: DELETE_URL,
      hiddenFields: [['paths', JSON.stringify(keys)], ['back', back], ['confirm', '1']],
      backUrl: back,
      recoverable: false,
      tip: 'R2 上的对象删除后不可恢复（没有回收站）；提交前会再复查一次引用，有一个被引用就整批不删。'
        + `公开域上的旧副本可能仍被边缘缓存命中最长 ${CACHE_CONTROL_MEDIA} 的时长。`
    })}`;

  const content = `${pageHeader({ icon: 'bi-trash3', title: '删除对象', actions: backButton(back) })}
  <div class="card"><div class="card-body">${body}</div></div>`;
  return adminLayout(Object.assign({}, ctx, { title: '删除对象', currentPage: 'media_manage', content }));
}

/** 对象详情页(2.4.6 泛化到任意对象键): 对象键/所在目录/大小/类型/时间/ETag/Content-Type/缓存口径 + 引用明细 + 原图或视频预览。 */
async function detailPage(ctx) {
  if (!isSuper(ctx)) return denied(ctx);
  const checked = checkObjectKey(strOf(ctx.query.path));
  if (!checked.ok) return redirectTo(backWith(LIST_URL, { error: '参数错误' }));
  const key = checked.key;
  const back = safeBack(ctx.query.back);
  const head = await settings(ctx.env).storage.head(key).catch(() => null);
  if (!head) return redirectTo(backWith(back, { error: '文件不存在（可能已被删除）' }));

  const media = isMediaKey(key);
  const scan = media ? await scanReferences(ctx.env, [key]) : { ok: true, refs: {} };
  const refs = scan.refs[key] || [];
  const meta = head.httpMetadata || {};
  const base = String(settings(ctx.env).mediaBase || '').replace(/\/+$/, '');
  const url = base ? `${base}/${key}` : '';
  const kind = kindOfFile(key);
  const parent = parentOf(key);
  // 2.4.0: 缩略图功能整体移除, 预览直接用原图(不再探测 <目录>_thumb/)
  const preview = kind === 'video'
    ? (url ? `<video class="media-preview" controls preload="metadata" src="${escapeHtml(url)}"></video>` : '（未配置 MEDIA_BASE，无法预览）')
    : (kind === 'image' && url
      ? `<img class="cover-detail" src="${escapeHtml(url)}" alt="" loading="lazy">`
      : '（不是图片/视频，或未配置 MEDIA_BASE，无法预览）');
  const rows = [
    ['对象键', `<code>${escapeHtml(key)}</code>`],
    ['所在层', `${parent
      ? `<a href="${LIST_URL}?prefix=${urlenc(parent)}"><code>${escapeHtml(parent)}</code></a>`
      : '<span class="text-muted">存储桶根目录</span>'}
      <a class="btn btn-sm btn-outline-secondary ms-2" href="${LIST_URL}?prefix=${urlenc(parent)}">去这一层</a>`],
    ['类型', kind === 'image' ? '图片' : (kind === 'video' ? '视频' : '<span class="text-muted">其它（不是图片/视频）</span>')],
    ['大小', fmtBytes(head.size)],
    ['修改时间', escapeHtml(fmtDatetime(head.uploaded ? new Date(head.uploaded) : ''))],
    ['Content-Type', escapeHtml(String(meta.contentType || '（对象没记类型）'))],
    ['缓存口径', `<code>${escapeHtml(String(meta.cacheControl || '（未设置，用公开域默认值）'))}</code>`],
    ['ETag', `<code>${escapeHtml(String(head.etag || ''))}</code>`],
    ['公开地址', url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>` : '（未配置 MEDIA_BASE）']
  ];

  const content = `${pageHeader({
    icon: 'bi-info-circle',
    title: '对象详情',
    actions: backButton(back, '返回列表')
  })}
  <div class="card mb-3"><div class="card-body">
    ${preview}
    <div class="table-responsive mt-3"><table class="table table-sm align-middle mb-0">
      <tbody>${rows.map(([label, value]) => `<tr><th scope="row" class="th-rowlabel">${escapeHtml(label)}</th><td>${value}</td></tr>`).join('')}</tbody>
    </table></div>
  </div></div>
  <div class="card mb-3"><div class="card-body">
    <h6 class="mb-2">引用情况</h6>
    ${media ? refsBlock(refs, scan.ok) : '<div class="alert alert-secondary py-2 mb-0">这个对象不在素材路径下（不是 <code>image/</code>、<code>video/</code>、<code>news_uploads/</code>，也不在根目录树里），笔记引用不到它，所以不做引用检查。</div>'}
  </div></div>
  <div class="card"><div class="card-body d-flex flex-wrap gap-2">
    <a class="btn btn-outline-secondary" href="${RENAME_URL}?path=${urlenc(key)}&amp;back=${urlenc(back)}">改名 / 移动</a>
    <a class="btn btn-outline-secondary" href="${RENAME_URL}?copy=1&amp;path=${urlenc(key)}&amp;back=${urlenc(back)}">复制一份</a>
    <a class="btn btn-outline-danger" href="${DELETE_URL}?path=${urlenc(key)}&amp;back=${urlenc(back)}">删除这个对象</a>
    ${media ? `<a class="btn btn-outline-secondary" href="${REFS_URL}?path=${urlenc(key)}" target="_blank" rel="noopener">查看引用（JSON）</a>` : ''}
  </div></div>`;

  return adminLayout(Object.assign({}, ctx, { title: '对象详情', currentPage: 'media_manage', content }));
}

/**
 * 改名 / 移动 / 复制(GET = 确认页; 2.4.6 起目标目录可填**任意前缀**, 并多了「复制」开关):
 * **素材路径的源或目标任一有引用就拒绝** —— 本站不做"引用同步改写"(那要重写笔记正文, 风险最高),
 * 也不允许把已被引用的路径覆盖掉。非素材对象(站点资源等)不做引用检查(笔记引用不到)。
 * 被引用而想留副本时, 页面直接给出"改为复制"的入口(复制不动原对象, 因此不受这条限制)。
 */
async function renameGet(ctx) {
  if (!isSuper(ctx)) return denied(ctx);
  const checked = checkObjectKey(strOf(ctx.query.path));
  if (!checked.ok) return redirectTo(backWith(LIST_URL, { error: '参数错误' }));
  const key = checked.key;
  const back = safeBack(ctx.query.back);
  const copy = strOf(ctx.query.copy) === '1';
  const head = await settings(ctx.env).storage.head(key).catch(() => null);
  if (!head) return redirectTo(backWith(back, { error: '文件不存在（可能已被删除）' }));
  const media = isMediaKey(key);
  // 没扫全时也把"确认改名"页收起来: 页面不能一边说"可以安全改名"一边在提交处拒绝
  const scan = media ? await scanReferences(ctx.env, [key]) : { ok: true, refs: {} };
  const refs = scan.refs[key] || [];
  const dir = parentOf(key);
  const name = key.slice(dir.length);
  const blocked = media && refs.length > 0;

  const body = blocked
    ? `${refsBlock(refs)}
       <div class="alert alert-warning mb-3">改名/移动会让这些引用指向不存在的文件（本站**不会**自动改写笔记内容），所以这里直接拒绝。
       需要换位置时请先在笔记里换成新地址，或者删掉那些引用后再来。<br>
       <strong>只想留一份副本</strong>的话用「复制」—— 复制不动原对象，所以不受这条限制。</div>
       <div class="d-flex flex-wrap gap-2">${backButton(back, '返回列表')}
       <a class="btn btn-outline-secondary" href="${RENAME_URL}?copy=1&amp;path=${urlenc(key)}&amp;back=${urlenc(back)}">改为复制</a>
       <a class="btn btn-outline-secondary" href="${REFS_URL}?path=${urlenc(key)}" target="_blank" rel="noopener">查看引用明细</a></div>`
    : `<div class="alert alert-secondary">即将${copy ? '复制' : '改名 / 移动'}：<code>${escapeHtml(key)}</code>（${fmtBytes(head.size)}）</div>
       <form method="post" action="${RENAME_URL}" class="row g-3">
         <input type="hidden" name="path" value="${escapeHtml(key)}">
         <input type="hidden" name="back" value="${escapeHtml(back)}">
         <div class="col-lg-6">${textField({
      name: 'dir', label: '目标目录（前缀）', value: dir,
      placeholder: '如 image/2026-10/ ；留空 = 存储桶根目录',
      hint: '任何前缀都行（不必是素材目录）；留空表示放在存储桶最外层。目录不需要预先存在 —— R2 里目录只是键名的一部分。'
    })}</div>
         <div class="col-lg-6">${textField({
      name: 'name', label: '新文件名', value: name, required: true,
      placeholder: '如 outdoor_cover.png',
      hint: '只填文件名（不能带斜杠）；要换位置就改上面的「目标目录」。'
    })}</div>
         <div class="col-12">
           <div class="form-check">
             <input class="form-check-input" type="checkbox" name="copy" value="1" id="renameCopy"${copy ? ' checked' : ''}>
             <label class="form-check-label" for="renameCopy">复制（保留原对象，另存一份到目标路径）</label>
           </div>
         </div>
         <div class="col-12 d-grid gap-2">
           <button class="btn btn-primary" type="submit"><i class="bi bi-check-lg" aria-hidden="true"></i> 确认${copy ? '复制' : '改名 / 移动'}</button>
           ${backButton(back, '返回列表')}
         </div>
       </form>
       <div class="small text-muted mt-3">
         · R2 没有 rename：${copy ? '复制 = 读原对象 → 写新 key（2 次 R2 操作）' : '移动 = 读原对象 → 写新 key → 删旧 key（3 次 R2 操作）'}，流式处理、不整份读进内存；
         <br>· <strong>绝不覆盖</strong>：目标键已存在就拒绝（本站所有写入口都是这个口径）；
         <br>· 目标若不在素材路径下（不是 <code>image/</code>、<code>video/</code>、<code>news_uploads/</code>、也不是根目录树），素材库与小程序就看不到它了；公开域上的旧地址缓存最长还会保留 ${escapeHtml(CACHE_CONTROL_MEDIA)} 的时长。
       </div>`;

  const title = copy ? '复制对象' : (blocked ? '改名 / 移动被拒' : '改名 / 移动对象');
  const content = `${pageHeader({ icon: 'bi-pencil-square', title, actions: backButton(back) })}
  <div class="card"><div class="card-body">${body}</div></div>`;
  return adminLayout(Object.assign({}, ctx, { title, currentPage: 'media_manage', content }));
}

async function renamePost(ctx) {
  if (!isSuper(ctx)) return json({ success: false, message: '该操作仅超级管理员可执行' }, 403);
  const body = jsonOrForm(ctx);
  const back = safeBack(body.back);
  const checkedFrom = checkObjectKey(strOf(body.path));
  if (!checkedFrom.ok) return redirectTo(backWith(back, { error: '参数错误' }));
  const from = checkedFrom.key;
  const copy = strOf(body.copy) === '1';

  // 目标目录(2.4.6): 任意前缀; 留空或 `/` = 存储桶根目录。清洗后必须与输入一致(不静默改写)
  const rawDir = strOf(body.dir).trim();
  const dirCheck = (rawDir === '' || isRootDir(rawDir)) ? { ok: true, key: '' } : checkObjectKey(rawDir, { asDir: true });
  if (!dirCheck.ok) return redirectTo(backWith(back, { error: dirCheck.message }));
  const dir = dirCheck.key;
  const name = strOf(body.name).trim().replace(/^\/+/, '');
  if (!name || name.includes('/')) {
    return redirectTo(backWith(back, { error: '文件名不能为空，也不能带斜杠（要换位置就改「目标目录」）' }));
  }
  const to = `${dir}${name}`;
  const checkedTo = checkObjectKey(to);
  if (!checkedTo.ok) return redirectTo(backWith(back, { error: checkedTo.message }));
  if (to === from) return redirectTo(backWith(back, { error: '新旧路径相同' }));

  // 素材目录仍要求"目录与扩展名一致": 素材库按目录分组、小程序与列表按扩展名判类型, 不一致会互相打架
  const targetMedia = mediaPrefixOf(to);
  const kind = kindOfExt(extOf(to));
  if ((targetMedia === IMAGE_PREFIX && kind !== 'image') || (targetMedia === VIDEO_PREFIX && kind !== 'video')) {
    return redirectTo(backWith(back, { error: '目录与扩展名不匹配：图片放 image/，视频放 video/（历史目录 news_uploads/ 两者都收）' }));
  }

  // 引用检查: 源或目标**只要有一个落在素材路径上**就查; 两边都不是素材路径时跳过(笔记引用不到)
  const refKeys = [from, to].filter((one) => isMediaKey(one));
  const scan = refKeys.length ? await scanReferences(ctx.env, refKeys) : { ok: true, refs: {} };
  if (!scan.ok) {
    auditLog('admin.media_manage_rename', { username: ctx.session.username, from, to, ok: false, reason: 'ref_scan_incomplete' });
    return redirectTo(backWith(back, { error: REF_SCAN_INCOMPLETE }));
  }
  const refs = scan.refs;
  if (!copy && (refs[from] || []).length) {
    auditLog('admin.media_manage_rename', { username: ctx.session.username, from, to, ok: false, refs: refs[from].length });
    return redirectTo(backWith(back, { error: `该素材仍有 ${refs[from].length} 处引用，已拒绝改名（不会自动改写笔记内容）` }));
  }
  if ((refs[to] || []).length) {
    auditLog('admin.media_manage_rename', { username: ctx.session.username, from, to, ok: false, reason: 'target_referenced' });
    return redirectTo(backWith(back, { error: '目标路径已被笔记引用，请换一个文件名' }));
  }
  const result = copy ? await copyObject(ctx.env, from, to) : await moveObject(ctx.env, from, to);
  if (!result.ok) {
    auditLog('admin.media_manage_rename', { username: ctx.session.username, from, to, copy, ok: false, reason: result.reason });
    return redirectTo(backWith(back, { error: result.reason }));
  }
  auditLog('admin.media_manage_rename', { username: ctx.session.username, from, to, copy, ok: true });
  return redirectTo(backWith(back, { message: `${copy ? '已复制为' : '已改为'} ${to}` }));
}

/**
 * 目录级操作(2.4.6): 「移动」/「删除」某个前缀下的对象。
 * R2 没有目录实体, 所以这两件事都是"对该前缀下的对象批量做"; 受单请求子请求预算限制,
 * 一次只处理一小批(移动 10 个 / 删除 20 个), 剩下的提示"可再次提交"。
 * 批量里只要有一个仍被引用就**整批拒绝**(与单条删除同一口径), 且不改写任何笔记。
 */
async function dirPage(ctx) {
  if (!isSuper(ctx)) return denied(ctx);
  const action = strOf(ctx.query.action) === 'delete' ? 'delete' : 'move';
  const back = safeBack(ctx.query.back);
  const checked = checkObjectKey(strOf(ctx.query.prefix), { asDir: true });
  if (!checked.ok || !checked.key) return redirectTo(backWith(LIST_URL, { error: '参数错误' }));
  const prefix = checked.key;
  const under = await listUnder(ctx.env, prefix, { limit: LEVEL_MAX });
  if (!under.objects.length) {
    return redirectTo(backWith(back, { error: '这个前缀下已经没有对象了（对象存储里没有"空目录"）' }));
  }
  const limit = action === 'delete' ? BATCH_MAX : DIR_MOVE_MAX;
  const take = under.objects.slice(0, limit);
  const mediaKeys = take.map((one) => one.key).filter((one) => isMediaKey(one));
  const scan = mediaKeys.length ? await scanReferences(ctx.env, mediaKeys) : { ok: true, refs: {} };
  if (!scan.ok) return redirectTo(backWith(back, { error: REF_SCAN_INCOMPLETE }));
  const refs = scan.refs;
  const blocked = mediaKeys.filter((one) => (refs[one] || []).length > 0);
  const totalBytes = under.objects.reduce((sum, one) => sum + Number(one.size || 0), 0);
  const remaining = under.objects.length - take.length;

  const body = blocked.length
    ? `<div class="alert alert-warning mb-3">这一批里有 <b>${blocked.length}</b> 个仍被引用，<b>整批拒绝</b>（一个都不动）。请先在笔记里改掉引用。</div>
       <ul class="mb-3">${blocked.map((key) => `<li><code>${escapeHtml(key)}</code>：${(refs[key] || []).length} 处引用</li>`).join('')}</ul>
       <div class="d-flex gap-2">${backButton(back, '返回列表')}</div>`
    : `${action === 'delete'
      ? `<div class="alert alert-danger">即将删除 <b>${take.length}</b> 个对象（不可恢复），这一前缀下共 ${under.objects.length} 个、合计 ${fmtBytes(totalBytes)}。</div>`
      : `<div class="alert alert-secondary">即将移动 <b>${take.length}</b> 个对象（这一前缀下共 ${under.objects.length} 个、合计 ${fmtBytes(totalBytes)}）。</div>`}
       <ul class="small mb-3">${take.map((one) => `<li><code>${escapeHtml(one.key)}</code> · ${fmtBytes(one.size)}</li>`).join('')}
       ${remaining > 0 ? `<li class="text-muted">……还有 ${remaining} 个（一次最多 ${limit} 个，提交后可再来一次）</li>` : ''}</ul>
       <form method="post" action="${DIR_URL}" class="row g-3">
         <input type="hidden" name="action" value="${action}">
         <input type="hidden" name="prefix" value="${escapeHtml(prefix)}">
         <input type="hidden" name="back" value="${escapeHtml(back)}">
         <input type="hidden" name="confirm" value="1">
         ${action === 'move'
        ? `<div class="col-lg-6">${textField({
          name: 'dir', label: '移动到（目标前缀）', value: prefix,
          placeholder: '如 image/2026-10/ ；留空 = 存储桶根目录',
          hint: '该前缀下的相对结构会原样保留（原键去掉本前缀后拼到目标前缀后面）。'
        })}</div>`
        : ''}
         <div class="col-12 d-grid gap-2">
           <button class="btn ${action === 'delete' ? 'btn-danger' : 'btn-primary'}" type="submit">
             <i class="bi bi-check-lg" aria-hidden="true"></i> 确认${action === 'delete' ? `删除这 ${take.length} 个对象` : `移动这 ${take.length} 个对象`}
           </button>
           ${backButton(back, '返回列表')}
         </div>
       </form>
       <div class="small text-muted mt-3">
         · 目录不是实体：R2 里只有对象键，"删除目录"就是删掉这些键，删完前缀自然消失；
         <br>· 移动 = 每个对象"读 → 写 → 删"（3 次 R2 操作），所以一次只处理 ${DIR_MOVE_MAX} 个；删除是 1 次 R2 调用删掉一批（单次上限 1000，这里按 ${BATCH_MAX} 个一批走引用复查）；
         <br>· **绝不覆盖**：目标键已存在时该对象会失败并列出来（不会动原对象）。
       </div>`;

  const title = action === 'delete' ? `删除目录内容：${prefix}` : `移动目录内容：${prefix}`;
  const content = `${pageHeader({ icon: action === 'delete' ? 'bi-trash3' : 'bi-arrows-move', title, actions: backButton(back) })}
  <div class="card"><div class="card-body">${body}</div></div>`;
  return adminLayout(Object.assign({}, ctx, { title: action === 'delete' ? '删除目录内容' : '移动目录内容', currentPage: 'media_manage', content }));
}

async function dirPost(ctx) {
  if (!isSuper(ctx)) return json({ success: false, message: '该操作仅超级管理员可执行' }, 403);
  const body = jsonOrForm(ctx);
  const back = safeBack(body.back);
  const action = strOf(body.action) === 'delete' ? 'delete' : 'move';
  const checked = checkObjectKey(strOf(body.prefix), { asDir: true });
  if (!checked.ok || !checked.key) return redirectTo(backWith(back, { error: '参数错误' }));
  const prefix = checked.key;
  const under = await listUnder(ctx.env, prefix, { limit: LEVEL_MAX });
  if (!under.objects.length) return redirectTo(backWith(back, { error: '这个前缀下已经没有对象了' }));
  const limit = action === 'delete' ? BATCH_MAX : DIR_MOVE_MAX;
  const take = under.objects.slice(0, limit).map((one) => one.key);
  const remaining = under.objects.length - take.length;

  // 服务端确认: 页面上那条"确认删除/移动"只是给人看的, 真正拦的是这里
  if (strOf(body.confirm) !== '1') {
    return redirectTo(backWith(back, { error: '请从确认页提交（缺少确认标记）' }));
  }

  // 提交前**复查**引用(与单条删除同一口径): 有一个仍被引用就整批拒绝
  const mediaKeys = take.filter((one) => isMediaKey(one));
  const scan = mediaKeys.length ? await scanReferences(ctx.env, mediaKeys) : { ok: true, refs: {} };
  if (!scan.ok) {
    auditLog('admin.media_manage_dir', { username: ctx.session.username, action, prefix, ok: false, reason: 'ref_scan_incomplete' });
    return redirectTo(backWith(back, { error: REF_SCAN_INCOMPLETE }));
  }
  const refs = scan.refs;
  const blocked = mediaKeys.filter((one) => (refs[one] || []).length > 0);
  if (blocked.length) {
    auditLog('admin.media_manage_dir', { username: ctx.session.username, action, prefix, count: take.length, blocked: blocked.length, ok: false });
    return redirectTo(backWith(back, { error: `这一批里有 ${blocked.length} 个仍被引用，已整批拒绝（一个都没动）` }));
  }

  if (action === 'delete') {
    let removed = 0;
    try {
      removed = await removeObjects(ctx.env, take);   // 一批 1 次 R2 调用
    } catch (error) {
      auditLog('admin.media_manage_dir', { username: ctx.session.username, action, prefix, ok: false, reason: error && error.message });
      return redirectTo(backWith(back, { error: '删除失败，请稍后重试' }));
    }
    auditLog('admin.media_manage_dir', { username: ctx.session.username, action, prefix, count: removed, ok: true });
    return redirectTo(backWith(back, {
      message: `已删除 ${removed} 个对象${remaining > 0 ? `；还有 ${remaining} 个，可再次提交` : ''}`
    }));
  }

  // 移动: 目标前缀 + 原键去掉本前缀后的部分(结构原样保留)
  const rawDir = strOf(body.dir).trim();
  const dirCheck = (rawDir === '' || isRootDir(rawDir)) ? { ok: true, key: '' } : checkObjectKey(rawDir, { asDir: true });
  if (!dirCheck.ok) return redirectTo(backWith(back, { error: dirCheck.message }));
  const dir = dirCheck.key;
  if (dir === prefix) return redirectTo(backWith(back, { error: '目标前缀和原前缀相同' }));
  let moved = 0;
  const failures = [];
  for (const key of take) {
    const to = `${dir}${key.slice(prefix.length)}`;
    const result = await moveObject(ctx.env, key, to);   // 每个对象 head + get + put + delete
    if (result.ok) moved += 1;
    else failures.push(`${key}（${result.reason}）`);
  }
  auditLog('admin.media_manage_dir', {
    username: ctx.session.username, action, prefix, dir, moved, failed: failures.length, ok: true
  });
  const parts = [`已移动 ${moved} 个对象到 ${dir || '（存储桶根目录）'}`];
  if (failures.length) parts.push(`失败 ${failures.length} 个：${failures.slice(0, 3).join('；')}`);
  if (remaining > 0) parts.push(`还有 ${remaining} 个，可再次提交`);
  return redirectTo(backWith(back, { message: parts.join('；') }));
}

async function deletePost(ctx) {
  if (!isSuper(ctx)) return json({ success: false, message: '该操作仅超级管理员可执行' }, 403);
  const body = jsonOrForm(ctx);
  const keys = strOf(body.paths) ? keysOf(body.paths) : singleKeys(body.path);
  const back = safeBack(body.back);
  if (!keys.length) return redirectTo(backWith(back, { error: '参数错误' }));
  if (keys.length > BATCH_MAX) {
    return redirectTo(backWith(back, { error: `一次最多删除 ${BATCH_MAX} 个对象，请分次操作` }));
  }
  // 服务端确认: 确认页里的 confirm=1 必须带上 —— 只靠页面上的按钮拦不住直接构造的 POST
  if (strOf(body.confirm) !== '1') {
    return redirectTo(backWith(back, { error: '请从确认页提交（缺少确认标记）' }));
  }

  // 删除前**复查**引用: 从打开确认页到点提交之间, 可能刚好有人加了一条引用(含回收站)。
  // 只查素材路径(非素材对象笔记引用不到)。
  const mediaKeys = keys.filter((key) => isMediaKey(key));
  const scan = mediaKeys.length ? await scanReferences(ctx.env, mediaKeys) : { ok: true, refs: {} };
  if (!scan.ok) {
    auditLog('admin.media_manage_delete', {
      username: ctx.session.username, count: keys.length, ok: false, reason: 'ref_scan_incomplete'
    });
    return redirectTo(backWith(back, { error: REF_SCAN_INCOMPLETE }));
  }
  const refs = scan.refs;
  const blocked = mediaKeys.filter((key) => (refs[key] || []).length > 0);
  if (blocked.length) {
    auditLog('admin.media_manage_delete', {
      username: ctx.session.username, count: keys.length, blocked: blocked.length, ok: false
    });
    return redirectTo(backWith(back, { error: `选中的对象里有 ${blocked.length} 个仍被引用，已整批拒绝（一个都没删）` }));
  }
  let removed = 0;
  try {
    // 一批只花 1 次 R2 子请求(delete 收数组, 单次上限 1000)
    removed = await removeObjects(ctx.env, keys);
  } catch (error) {
    auditLog('admin.media_manage_delete', {
      username: ctx.session.username, count: keys.length, ok: false, reason: error && error.message
    });
    return redirectTo(backWith(back, { error: '删除失败，请稍后重试' }));
  }
  auditLog('admin.media_manage_delete', {
    username: ctx.session.username, count: removed, paths: keys.slice(0, 5), ok: true
  });
  return redirectTo(backWith(back, { message: removed > 1 ? `已删除 ${removed} 个对象` : `已删除 ${keys[0]}` }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: LIST_URL, handler: listPage },
  { methods: ['GET', 'HEAD'], path: ROWS_URL, handler: rowsFragment },
  { methods: ['GET', 'HEAD'], path: REFS_URL, handler: refsJson },
  { methods: ['GET', 'HEAD'], path: DETAIL_URL, handler: detailPage },
  { methods: ['GET', 'HEAD'], path: DELETE_URL, handler: deleteGet },
  { methods: ['POST'], path: DELETE_URL, handler: deletePost },
  { methods: ['GET', 'HEAD'], path: RENAME_URL, handler: renameGet },
  { methods: ['POST'], path: RENAME_URL, handler: renamePost },
  // 2.4.6: 目录级移动 / 删除(GET = 确认页, POST = 执行; 一次一小批, 见 DIR_MOVE_MAX/BATCH_MAX)
  { methods: ['GET', 'HEAD'], path: DIR_URL, handler: dirPage },
  { methods: ['POST'], path: DIR_URL, handler: dirPost }
];
