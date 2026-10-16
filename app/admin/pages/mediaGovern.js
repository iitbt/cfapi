// 素材库管理(治理页, 仅超管): 看占用 / 查引用 / 删无用文件; "选素材"在字段旁的弹窗里, 不是这一页。
// 引用判定只有一处 scanReferences(列表列 /「查看引用」/ 删除与改名前复查), 两处不一致就是"正文里的引用永远显示未引用"; 且引用必须含回收站。
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
import {
  LEVEL_MAX, SORT_CHOICES, browseLevel, fmtUploadTime, kindOfFile, mediaBaseOf, mediaUrlOf, metaCells,
  parentOf, previewCell
} from '../lib/mediaBrowse.js';
import { adminLayout } from '../lib/layout.js';
import {
  IMG_FALLBACK_ATTR, backButton, deleteConfirmCard, filterButtons, listFoot, listMeta, listToolbar, pageHeader,
  pagerScript, searchBar, searchInput, searchSelect, selectField, staticScript, textField
} from '../lib/partials.js';
import { PER_PAGE, auditLog, strOf, urlenc } from '../lib/utils.js';
import { json, redirect } from '../lib/http.js';

const LIST_URL = '/admin/media_manage';
const DELETE_URL = '/admin/media_manage_delete';
const REFS_URL = '/admin/media_manage_refs';
const DETAIL_URL = '/admin/media_manage_detail';
const RENAME_URL = '/admin/media_manage_rename';
//: 上传仍走既有端点(旧地址 /admin/news_image_upload 等价), 不新增上传接口
const UPLOAD_URL = '/admin/image_upload';

//: 批量删除上限: 一批 = 9 条引用扫描 + 1 次 R2 批量删除, 单请求子请求上限 50, 得留余量给列表列举
const BATCH_MAX = 20;

//: 上传卡片里表示"存储桶最外层"的哨兵值(空串已被"没传 = 默认目录"占用), 上传接口也认它
const ROOT_DIR = '/';
const isRootDir = (value) => value === ROOT_DIR;

//: 类型筛选(按扩展名判定; 其它 = 既不是图片也不是视频)
const KIND_CHOICES = [['all', '全部类型'], ['image', '图片'], ['video', '视频'], ['other', '其它']];

//: 一次移动几个: 每个对象 = head + get + put + delete(4 次 R2 子请求), 10 个已占掉 40 次子请求预算
const DIR_MOVE_MAX = 10;
//: 目录(或选中项)的移动与删除: 确认页(GET)与执行(POST)共用这个端点
const DIR_URL = '/admin/media_manage_dir';

//: 其它引用来源(表, 列, 中文名): 只列"可能装素材路径的列"
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

//: 返回地址收敛: 只接受本页地址(防开放重定向, 旧站 _safe_back 同口径)
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

//: 全库引用扫描 —— 唯一判定实现(列表列 /「查看引用」/ 删除与改名前复查三处共用); only 传入时只保留这批路径。
//: ok=false 表示没扫全(查询失败或命中取行上限), 此时"扫不到"不等于"没被引用"(2026-10-07 事故), 调用方必须拒绝。
export async function scanReferences(env, only = null) {
  const hits = {};
  let failed = false;
  const keep = only ? new Set(only) : null;
  // 根目录素材的记录值是裸文件名, 没有前缀可筛, 只能按候选名单精确命中; 只收图片/视频
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

  // ⚠️ 每个 LIKE 都要写全列名: 曾拼成 "image LIKE ? OR LIKE ?" → SQLite 语法错被 catch 吞成"零命中" → 引用列整列"未引用"、删除前复查一起失效(2026-10-07 事故, 桩测试看不出语法错)。
  // 根目录素材再补一组"按扩展名"的 LIKE(%.png 等), 多取的行由 relPathsIn 精确判定; 只有本次确实要查根目录素材时才加。
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
  // 失败要在日志里看得见并置 failed: 静默 catch 正是"零命中"藏了两周的原因
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

//: 批量参数 paths 是 JSON 数组 —— 对象键里允许逗号, 逗号分隔会拆错键(那就删错对象了); 解析不出来回空数组
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

//: 单条路径(?path= 或行内删除链接) → [键], 不合法回空数组
function singleKeys(rawPath) {
  const checked = checkObjectKey(strOf(rawPath));
  return checked.ok ? [checked.key] : [];
}

//: 这个键算不算"素材"(决定要不要做引用扫描): 素材目录下的一律算; 根目录树里的必须带图片/视频扩展名(站内资源笔记引用不到, 白扫 9 条 D1)。
function isMediaKey(key) {
  const text = String(key || '');
  if (mediaPrefixOf(text)) return true;
  return isRootTreePath(text) && Boolean(kindOfExt(extOf(text)));
}

//: 面包屑 + 「上一级」: 每一段都可点回该层, 根目录就是存储桶本身
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

//: 引用明细(详情页与改名确认页共用): 没扫全(ok=false)时必须说"结果可能不全", 不能说"没有任何引用"
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

//: 扫描没扫全时的统一拒绝文案(确认页与提交处共用, 免得两处口径不一致)
const REF_SCAN_INCOMPLETE = '引用扫描未完成（查询失败或超出取行上限），已拒绝本次操作，请稍后重试';

//: 上传卡片: 图片/视频两个入口(类型由入口决定, 服务端仍按文件头校验); 原生 file 控件按钮文字由浏览器决定, 所以藏起 input 只借行为; 文件夹上传带整棵目录树。
function uploadCard(dirs = []) {
  // 两个入口共用同一段结构: 逐字复制两份时文案与属性很容易改漏一处
  const pickers = ({ tab, title, icon, dir, purpose, accept, limit, unit }) => {
    const root = `${dir}/`;
    // 选项 = 根目录 → 本入口根目录(默认) → 桶根下的一级子目录 → 「其它（手动填写）」; 只列一级是刻意的, 候选必须与桶根那排按钮同源
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
          <code>image/素材/根目录图.png</code>。<strong>两种命名模式都保留目录</strong>：「保留原名」（<strong>2.6.8 起为默认</strong>）
          文件名也不变、同目录重名自动加 <code>_1</code>，「自动生成」只把文件名换成 <code>&lt;用途&gt;_时间戳.ext</code>。
          空文件夹不会被保留（R2 没有目录，浏览器也不会把空目录列出来）。
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
          <input class="form-check-input" type="radio" name="mediaNameMode" id="mediaNameKeep" value="keep" checked>
          <label class="form-check-label" for="mediaNameKeep">保留原名（默认；重名自动加 <code>_1</code>/<code>_2</code>）</label>
        </div>
        <div class="form-check form-check-inline mb-0">
          <input class="form-check-input" type="radio" name="mediaNameMode" id="mediaNameAuto" value="auto">
          <label class="form-check-label" for="mediaNameAuto">自动生成（<code>&lt;用途&gt;_时间戳.ext</code>）</label>
        </div>
        <button class="btn btn-sm btn-primary" type="button" id="mediaUploadStart" disabled>开始上传</button>
        <button class="btn btn-sm btn-outline-secondary" type="button" id="mediaUploadClear">清空</button>
      </div>
      <div class="col-12">
        <div class="form-text mb-2">默认「保留原名」：同一目录里同名文件自动顺延 <code>_1</code>、<code>_2</code>…（扩展名不变）；
          不同子目录各自独立计数，互不影响。要按用途+时间戳重命名就切到「自动生成」（两种模式都保留文件夹结构）。</div>
        <div class="progress" role="progressbar" aria-label="整体上传进度" style="height:1rem">
          <div class="progress-bar" id="mediaUploadBar" style="width:0%">0%</div>
        </div>
        <div class="small text-muted mt-1" id="mediaUploadOverall" role="status" aria-live="polite">等待选择文件…</div>
        <div class="small text-muted" id="mediaUploadCurrent"></div>
        <!-- 待上传清单: 一行一个文件(缩略图 + 相对路径 + 大小/类型/状态), 与进度条联动; 列表可滚动, 多层级不会撑长页面 -->
        <div class="upload-list mt-2 d-none" id="mediaUploadListBox">
          <ul class="list-unstyled mb-0" id="mediaUploadList"></ul>
        </div>
        <div class="mt-2" id="mediaUploadDone"></div>
      </div>
    </div>
  </div></div>`;
}

//: 脚本要的常量由页面注入(脚本已搬到 static/js/media_govern.js: 写在模板字符串里会被求值吃掉反斜杠、被反引号截断)
const MEDIA_GOVERN_CFG = `<script>window.__mediaGovernCfg = ${JSON.stringify({
  batchMax: BATCH_MAX, moveMax: DIR_MOVE_MAX, uploadUrl: UPLOAD_URL, moveUrl: DIR_URL
})};</script>`;

//: 触底加载的行片段端点(只给**路径**, 查询参数由前端按 location.search 拼 —— 带筛选翻页才不丢条件)
const ROWS_URL = '/admin/media_manage_rows';

//: 目录浏览取数(逐层列举 + 过滤/排序/分页都走 lib/mediaBrowse.js 的 browseLevel, 与素材选择器同一份): 只有本层含素材键才扫引用, 不带"引用状态"筛选时只扫本页(省 9 条 D1)。
async function browseQuery(ctx) {
  const ref = strOf(ctx.query.ref) === 'used' ? 'used' : strOf(ctx.query.ref) === 'unused' ? 'unused' : '';
  // 引用扫描的结果由 prepare 里回填(见下), 页面与行片段都要用, 所以放在这个作用域
  let mediaish = false;
  let refs = {};
  let refsOk = true;
  const data = await browseLevel(ctx.env, {
    prefix: strOf(ctx.query.prefix),
    q: strOf(ctx.query.q),
    kind: KIND_CHOICES.some(([value]) => value === strOf(ctx.query.kind)) ? strOf(ctx.query.kind) : 'all',
    sort: strOf(ctx.query.sort),
    page: strOf(ctx.query.page),
    perPage: PER_PAGE,
    // 引用扫描必须赶在切片之前, 否则"按引用筛选"就没法分页(浏览 avatar/ 这类非素材目录则整层不扫)
    prepare: async (files) => {
      mediaish = files.some((one) => isMediaKey(one.key));
      if (!mediaish || !ref) return files;
      const scan = await scanReferences(ctx.env, files.map((one) => one.key));
      refs = scan.refs;
      refsOk = scan.ok;
      // 没扫全时不做筛选: 那会把整层都当成"未引用", 比不筛更误导
      if (!refsOk) return files;
      return files.filter((one) => (ref === 'used'
        ? (refs[one.key] || []).length > 0
        : (refs[one.key] || []).length === 0));
    }
  });
  const { pageItems } = data;
  if (mediaish && !ref) {
    const scan = await scanReferences(ctx.env, pageItems.map((one) => one.key));
    refs = scan.refs;
    refsOk = scan.ok;
  }
  return Object.assign({}, data, {
    ref, refs, refsOk, mediaish,
    // 行渲染仍按"过滤后的本层"取数(listPage 的统计条与全选都以它为准)
    filtered: data.files,
    currentUrl: ctx.url.pathname + ctx.url.search
  });
}

//: 文件行 HTML(首屏与触底加载共用): 必须一处渲染, 否则两处的列/文案会各走各的
function levelRows(files, data) {
  return files.map((item) => {
    const itemRefs = data.refs[item.key] || [];
    const recycle = itemRefs.some((ref) => ref.recycle);
    const refCell = !data.mediaish
      ? '<span class="text-muted">—</span>'
      : (data.refsOk === false
        // 没扫全时不敢说"未引用": 说"未引用"会让人放心去删, 而删除入口自己还会再复查一次(那里会直接拒绝)
        ? '<span class="text-muted" title="引用扫描未完成（查询失败或超出取行上限），这次不做引用判断">扫描未完成</span>'
        : (itemRefs.length
          ? `<a href="${REFS_URL}?path=${urlenc(item.key)}" target="_blank" rel="noopener">${itemRefs.length} 处</a>${recycle ? ' <span class="badge text-bg-warning">含回收站</span>' : ''}`
          : '<span class="text-muted">未引用</span>'));
    // 预览格与类型/大小/修改时间三格走共用实现(2.7.1): 地址一律媒体公开域, 展示项与选择器逐字一致
    const url = mediaUrlOf(data.base, item.key);
    const thumb = previewCell(data.base, item, 'cover-thumb');
    const open = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(item.key)}</a>`
      : escapeHtml(item.key);
    const back = urlenc(data.currentUrl);
    return `<tr data-media-row>
      <td><input type="checkbox" class="form-check-input" data-media-pick value="${escapeHtml(item.key)}" aria-label="选择 ${escapeHtml(item.key)}"></td>
      <td>${thumb}</td>
      <td class="cell-title"><div class="text-truncate" title="${escapeHtml(item.key)}">${open}</div></td>
      ${metaCells(item)}
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
  // 目标路径下拉必须与【存储桶根目录】那排按钮同源: 站根时直接复用本页数据(零额外列举), 站子目录才补一次同参数的根层列举
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
  // 目录按钮跟着当前位置动一层: 在根时高亮「存储桶根目录」+ 列根下子目录, 进了子目录就换成它的子目录(返回上一层走面包屑或「上一级」)
  const quick = [`<a class="btn btn-sm ${data.prefix === '' ? 'btn-primary' : 'btn-outline-secondary'}"`
    + ` href="${LIST_URL}">存储桶根目录</a>`]
    .concat(data.folders.map((folder) => `<a class="btn btn-sm btn-outline-secondary"`
      + ` href="${LIST_URL}?prefix=${urlenc(folder.key)}">${escapeHtml(folder.name)}/</a>`))
    .join('');

  // 空状态要分清"这层本来就没东西"和"被筛选筛没了", 否则用户会以为文件丢了
  const filtered = Boolean(strOf(ctx.query.q) || data.kind !== 'all' || data.ref);
  const emptyHint = filtered
    ? '这一层没有符合筛选条件的对象（关键词 / 类型 / 引用状态），清空筛选或换一层再看'
    : '此目录暂无文件（对象存储里没有"空的目录"；换个前缀看看，或用上面的上传卡片传一个）';

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
      <span class="small text-muted">删除不可恢复；移动会换掉对象键（笔记里的引用不会自动改写）。两者都做引用检查，有一个被引用就整批拒绝（删除一次最多 ${BATCH_MAX} 个、移动 ${DIR_MOVE_MAX} 个）。</span>
      <button class="btn btn-sm btn-outline-danger" type="submit" id="mediaBatchDelete" disabled>删除所选</button>
      <button class="btn btn-sm btn-outline-secondary" type="button" id="mediaBatchMove"
              title="把选中的对象搬到同一个目标前缀（文件名不变）" disabled>移动所选…</button>
      <span class="small" id="mediaBatchCount">已选 0 个</span>
    </form>
    <div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
      <thead><tr>
        <th><input type="checkbox" class="form-check-input" id="mediaPickAll" aria-label="全选已加载的文件"></th>
        <th>预览</th><th>对象键</th><th>类型</th><th>大小</th><th>修改时间</th><th>ETag</th><th>引用</th><th></th>
      </tr></thead>
      <tbody id="mediaTbody">${rows || `<tr><td colspan="9" class="text-muted">${emptyHint}</td></tr>`}</tbody>
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
      <br>· <strong>「移动所选…」</strong>把勾选的对象搬到同一个目标前缀下（文件名不变）：与删除一样先出确认页，被引用一样整批拒绝。
      <br>· 缩略图（派生文件）已按 2.4.0 移除，列表/详情/预览一律用原图；新上传对象带
      <code>Cache-Control: ${escapeHtml(CACHE_CONTROL_MEDIA)}</code>。全桶媒体占用统计在「系统信息」页（这里不再全桶扫描，只列举当前层）。
    </div>
  </div></div>
`;

  return adminLayout(Object.assign({}, ctx, {
    title: '存储桶资源管理', currentPage: 'media_manage', content,
    // 触底加载与回到顶部走共用的 infinite_scroll.js; rowsUrl 只给端点路径(参数由 AdminListLoader 按 location.search 拼)
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

  // 只要有一个还被引用就整批拒绝(部分成功最容易让人以为"都删了"); 单条用原句文案, 批量才用"整批拒绝"
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

//: 对象详情页: 对象键/所在层/大小/类型/时间/ETag/Content-Type/缓存口径 + 引用明细 + 原图或视频预览
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
  const base = mediaBaseOf(ctx.env);
  const url = mediaUrlOf(base, key);
  const kind = kindOfFile(key);
  const parent = parentOf(key);
  // 预览一律用原图(派生缩略图已移除); 图片挂共用的兜底属性, 加载失败换 /lucky.jpg
  const preview = kind === 'video'
    ? (url ? `<video class="media-preview" controls preload="metadata" src="${escapeHtml(url)}"></video>` : '（未配置 MEDIA_BASE，无法预览）')
    : (kind === 'image' && url
      ? `<img class="cover-detail" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" ${IMG_FALLBACK_ATTR}>`
      : '（不是图片/视频，或未配置 MEDIA_BASE，无法预览）');
  const rows = [
    ['对象键', `<code>${escapeHtml(key)}</code>`],
    ['所在层', `${parent
      ? `<a href="${LIST_URL}?prefix=${urlenc(parent)}"><code>${escapeHtml(parent)}</code></a>`
      : '<span class="text-muted">存储桶根目录</span>'}
      <a class="btn btn-sm btn-outline-secondary ms-2" href="${LIST_URL}?prefix=${urlenc(parent)}">去这一层</a>`],
    ['类型', kind === 'image' ? '图片' : (kind === 'video' ? '视频' : '<span class="text-muted">其它（不是图片/视频）</span>')],
    ['大小', fmtBytes(head.size)],
    ['修改时间', escapeHtml(fmtUploadTime({ uploaded: head.uploaded }))],
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

//: 改名 / 移动 / 复制(目标目录可填任意前缀): 素材路径的源或目标任一有引用就拒绝(本站不改写笔记正文); 想留副本就用「复制」, 它不动原对象。
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

//: 目录级(或勾选项)的移动/删除确认页: "移动目录"就是对前缀下的对象分批做(移动 10 个 / 删除 20 个), 剩下的提示可再次提交, 被引用就整批拒绝。
//: paths 形式只做移动: 列表页勾选的若干个对象, 文件名不变、搬到同一个目标前缀。
async function dirPage(ctx) {
  if (!isSuper(ctx)) return denied(ctx);
  const action = strOf(ctx.query.action) === 'delete' ? 'delete' : 'move';
  const back = safeBack(ctx.query.back);
  const limit = action === 'delete' ? BATCH_MAX : DIR_MOVE_MAX;
  const picked = strOf(ctx.query.paths) ? keysOf(ctx.query.paths) : [];
  if (picked.length && action === 'delete') {
    return redirectTo(backWith(back, { error: '批量删除请从列表页的「删除所选」走确认页' }));
  }
  const byPicked = picked.length > 0;
  let prefix = '';
  let take = [];
  let totalBytes = 0;
  let totalCount = 0;
  let remaining = 0;
  if (byPicked) {
    take = picked.slice(0, DIR_MOVE_MAX).map((key) => ({ key }));
    totalCount = picked.length;
    remaining = Math.max(0, picked.length - take.length);
  } else {
    const checked = checkObjectKey(strOf(ctx.query.prefix), { asDir: true });
    if (!checked.ok || !checked.key) return redirectTo(backWith(LIST_URL, { error: '参数错误' }));
    prefix = checked.key;
    const under = await listUnder(ctx.env, prefix, { limit: LEVEL_MAX });
    if (!under.objects.length) {
      return redirectTo(backWith(back, { error: '这个前缀下已经没有对象了（对象存储里没有"空目录"）' }));
    }
    take = under.objects.slice(0, limit);
    totalBytes = under.objects.reduce((sum, one) => sum + Number(one.size || 0), 0);
    totalCount = under.objects.length;
    remaining = totalCount - take.length;
  }
  const mediaKeys = take.map((one) => one.key).filter((one) => isMediaKey(one));
  const scan = mediaKeys.length ? await scanReferences(ctx.env, mediaKeys) : { ok: true, refs: {} };
  if (!scan.ok) return redirectTo(backWith(back, { error: REF_SCAN_INCOMPLETE }));
  const refs = scan.refs;
  const blocked = mediaKeys.filter((one) => (refs[one] || []).length > 0);

  const body = blocked.length
    ? `<div class="alert alert-warning mb-3">这一批里有 <b>${blocked.length}</b> 个仍被引用，<b>整批拒绝</b>（一个都不动）。请先在笔记里改掉引用。</div>
       <ul class="mb-3">${blocked.map((key) => `<li><code>${escapeHtml(key)}</code>：${(refs[key] || []).length} 处引用</li>`).join('')}</ul>
       <div class="d-flex gap-2">${backButton(back, '返回列表')}</div>`
    : `${action === 'delete'
      ? `<div class="alert alert-danger">即将删除 <b>${take.length}</b> 个对象（不可恢复），这一前缀下共 ${totalCount} 个、合计 ${fmtBytes(totalBytes)}。</div>`
      : `<div class="alert alert-secondary">即将移动 <b>${take.length}</b> 个对象${byPicked
        ? '（文件名不变，搬到同一个目标前缀）'
        : `（这一前缀下共 ${totalCount} 个、合计 ${fmtBytes(totalBytes)}）`}。</div>`}
       <ul class="small mb-3">${take.map((one) => `<li><code>${escapeHtml(one.key)}</code>${one.size ? ` · ${fmtBytes(one.size)}` : ''}</li>`).join('')}
       ${remaining > 0 ? `<li class="text-muted">……还有 ${remaining} 个（一次最多 ${limit} 个，提交后可再来一次）</li>` : ''}</ul>
       <form method="post" action="${DIR_URL}" class="row g-3">
         <input type="hidden" name="action" value="${action}">
         <input type="hidden" name="${byPicked ? 'paths' : 'prefix'}" value="${escapeHtml(byPicked ? JSON.stringify(take.map((one) => one.key)) : prefix)}">
         <input type="hidden" name="back" value="${escapeHtml(back)}">
         <input type="hidden" name="confirm" value="1">
         ${action === 'move'
        ? `<div class="col-lg-6">${textField({
          name: 'dir', label: '移动到（目标前缀）', value: byPicked ? parentOf(take[0].key) : prefix,
          placeholder: '如 image/2026-10/ ；留空 = 存储桶根目录',
          hint: byPicked
            ? '选中的对象文件名不变，都搬到这个前缀下；留空 = 存储桶最外层（不会覆盖同名对象）。'
            : '该前缀下的相对结构会原样保留（原键去掉本前缀后拼到目标前缀后面）。'
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
         ${byPicked
        ? `· 选中的对象只换目录、文件名不变；移动 = 每个对象"读 → 写 → 删"（3 次 R2 操作），所以一次只处理 ${DIR_MOVE_MAX} 个；`
        : `· 目录不是实体：R2 里只有对象键，"删除目录"就是删掉这些键，删完前缀自然消失；
         <br>· 移动 = 每个对象"读 → 写 → 删"（3 次 R2 操作），所以一次只处理 ${DIR_MOVE_MAX} 个；删除是 1 次 R2 调用删掉一批（单次上限 1000，这里按 ${BATCH_MAX} 个一批走引用复查）；`}
         <br>· **绝不覆盖**：目标键已存在时该对象会失败并列出来（不会动原对象）。
       </div>`;

  const title = action === 'delete' ? `删除目录内容：${prefix}` : (byPicked ? '移动所选对象' : `移动目录内容：${prefix}`);
  const content = `${pageHeader({ icon: action === 'delete' ? 'bi-trash3' : 'bi-arrows-move', title, actions: backButton(back) })}
  <div class="card"><div class="card-body">${body}</div></div>`;
  return adminLayout(Object.assign({}, ctx, { title: action === 'delete' ? '删除目录内容' : '移动目录内容', currentPage: 'media_manage', content }));
}

async function dirPost(ctx) {
  if (!isSuper(ctx)) return json({ success: false, message: '该操作仅超级管理员可执行' }, 403);
  const body = jsonOrForm(ctx);
  const back = safeBack(body.back);
  const action = strOf(body.action) === 'delete' ? 'delete' : 'move';
  const limit = action === 'delete' ? BATCH_MAX : DIR_MOVE_MAX;
  // paths = 列表页勾选的若干个对象(只做移动); 没有就走目录形式(prefix 下的对象)
  const picked = strOf(body.paths) ? keysOf(body.paths) : [];
  const byPicked = picked.length > 0;
  let prefix = '';
  let take = [];
  let remaining = 0;
  if (byPicked) {
    if (action !== 'move') return redirectTo(backWith(back, { error: '批量删除请从列表页的「删除所选」走确认页' }));
    take = picked.slice(0, DIR_MOVE_MAX);
    remaining = Math.max(0, picked.length - take.length);
  } else {
    const checked = checkObjectKey(strOf(body.prefix), { asDir: true });
    if (!checked.ok || !checked.key) return redirectTo(backWith(back, { error: '参数错误' }));
    prefix = checked.key;
    const under = await listUnder(ctx.env, prefix, { limit: LEVEL_MAX });
    if (!under.objects.length) return redirectTo(backWith(back, { error: '这个前缀下已经没有对象了' }));
    take = under.objects.slice(0, limit).map((one) => one.key);
    remaining = under.objects.length - take.length;
  }

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

  // 移动: 目录形式保留相对结构(原键去掉本前缀), 勾选形式只换目录、文件名不变
  const rawDir = strOf(body.dir).trim();
  const dirCheck = (rawDir === '' || isRootDir(rawDir)) ? { ok: true, key: '' } : checkObjectKey(rawDir, { asDir: true });
  if (!dirCheck.ok) return redirectTo(backWith(back, { error: dirCheck.message }));
  const dir = dirCheck.key;
  if (!byPicked && dir === prefix) return redirectTo(backWith(back, { error: '目标前缀和原前缀相同' }));
  let moved = 0;
  const failures = [];
  for (const key of take) {
    const to = `${dir}${byPicked ? key.slice(key.lastIndexOf('/') + 1) : key.slice(prefix.length)}`;
    const result = await moveObject(ctx.env, key, to);   // 每个对象 head + get + put + delete
    if (result.ok) moved += 1;
    else failures.push(`${key}（${result.reason}）`);
  }
  auditLog('admin.media_manage_dir', {
    username: ctx.session.username, action, prefix, dir, count: take.length, moved, failed: failures.length, ok: true
  });
  const parts = [`移动完成：成功 ${moved} 项、失败 ${failures.length} 项（目标：${dir || '存储桶根目录'}）`];
  if (failures.length) parts.push(`失败详情：${failures.slice(0, 3).join('；')}`);
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

  // 删除前复查引用: 从打开确认页到点提交之间可能刚好有人加了引用(含回收站); 只查素材路径, 非素材对象引用不到
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
