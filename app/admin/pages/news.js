// 笔记管理: 列表(搜索/筛选/批量) / 行片段 / 发布编辑 / 预览 / 软删除 / 复制 / 回收站 / 恢复 / 彻底删除
// 逐条对齐旧站 fastapi/app/admin/news_admin.py + news_edit.py + news_recycle.py
import { escapeHtml } from '../../core/html.js';
import { json, redirect } from '../lib/http.js';
import { all, chunkIds, marksOf, one, run } from '../../core/db.js';
import { assetUrl, mediaBase } from '../../core/media_scheme.js';
import { sanitizeHtml } from '../../core/sanitize.js';
import { beijingNow } from '../../core/timeutil.js';
import { adminLayout } from '../lib/layout.js';
import { getNameMap, nameFor, optionsForSelect } from '../lib/categorySource.js';
import { imagesForStorage, plainDesc, videoForBrowser, videoForEditor, videoForStorage } from '../lib/newsContent.js';
import {
  IMAGE_FALLBACK_SRC, IMG_FALLBACK_ATTR, addButton, backButton, emptyRow, filterButtons, imageTag, imageUploadField,
  imageUploadModal, listShell, mediaLibraryModal,
  pagerScript, searchBar, searchInput, searchSelect, selectField, staticScript, switchField, textareaField, textField,
  videoPreview
} from '../lib/partials.js';
import { statusButtons, statusCell, statusKind, statusLabel } from '../lib/status.js';
import { listController } from '../lib/listPage.js';
import {
  PER_PAGE, auditLog, buildListUrl, clampPage, datetimeLocalValue, invalidateEntityCache,
  intOr, normalizeDatetime, nowLocalMinute, onceOrError, positiveId, strOf
} from '../lib/utils.js';

const MANAGE_URL = '/admin/news_manage';
const RECYCLE_URL = '/admin/news_recycle';
const PURGE_EXPIRED_URL = '/admin/news_purge_expired';
const RECYCLE_LIMIT = 100;
const RECYCLE_RETENTION_DAYS = 30;
const BATCH_MAX = 200;

// 列表只取展示真正用到的列: 别把每行 20KB 的正文也拉回来(旧站为此改过一版)
const LIST_COLUMNS = 'id, title, "desc", category, image, publish_time, status, type, view_count, likes, favorites';
const RECYCLE_COLUMNS = 'id, title, category, image, status, type, publish_time, deleted_at';
// 首列是批量操作的"全选"复选框: 走 listShell 的 { html: true } 列, 否则会被转义成源码文本
const COLUMNS = [
  { label: '<input type="checkbox" id="rowCheckAll" aria-label="全选">', html: true },
  'ID', '标题', '分类', '封面', '状态', '浏览/点赞/收藏', '发布时间', '操作'
];
const RECYCLE_COLUMNS_HEAD = ['ID', '封面', '标题', '来源', '分类', '删除时间', '操作'];

function listWhere(query) {
  const clauses = ["type = 'admin_users'", 'deleted_at IS NULL'];
  const args = [];
  const category = strOf(query.category);
  if (category && category !== 'all') {
    clauses.push('category = ?');
    args.push(category);
  }
  const status = strOf(query.status);
  if (status && status !== 'all') {
    clauses.push('status = ?');
    args.push(status);
  }
  const keyword = strOf(query.keyword);
  if (keyword) {
    clauses.push('(title LIKE ? OR "desc" LIKE ?)');
    args.push(`%${keyword}%`, `%${keyword}%`);
  }
  return { sql: ` WHERE ${clauses.join(' AND ')}`, args };
}

function actionsCell(ctx, row) {
  const page = clampPage(ctx.query.page, null);
  const buttons = statusButtons('news', row);
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="/admin/news_edit?id=${row.id}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    <a class="btn btn-sm btn-outline-secondary" href="/admin/news_preview?id=${row.id}" target="_blank" rel="noopener"><i class="bi bi-eye" aria-hidden="true"></i> 预览</a>
    <form method="post" action="/admin/news_copy" class="d-inline">
      <input type="hidden" name="id" value="${row.id}">
      <input type="hidden" name="page" value="${page}">
      <button class="btn btn-sm btn-outline-secondary" type="submit" onclick="return confirm('复制该笔记为待审核副本？')"><i class="bi bi-copy" aria-hidden="true"></i> 复制</button>
    </form>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=news_row&amp;id=${row.id}&amp;page=${page}&amp;back=${encodeURIComponent(MANAGE_URL)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

function renderRows(ctx, rows) {
  if (!rows || !rows.length) return emptyRow(COLUMNS, '没有符合条件的笔记');
  return rows.map((row) => {
    const image = strOf(row.image);
    const cover = image ? imageTag(ctx.env, image) : '-';   // 2.6.9: 封面加载失败换兜底图(唯一实现在 lib/partials.js)
    const subtitle = strOf(row.desc)
      ? `<div class="small text-muted text-truncate" title="${escapeHtml(strOf(row.desc))}">${escapeHtml(strOf(row.desc))}</div>` : '';
    return `<tr>
  <td><input type="checkbox" class="form-check-input rowCheck" value="${row.id}" aria-label="选择笔记 ${row.id}"></td>
  <td class="text-nowrap">${row.id}</td>
  <td class="cell-title">
    <div class="text-truncate" title="${escapeHtml(strOf(row.title) || '(无标题)')}"><a href="/admin/news_preview?id=${row.id}" target="_blank" rel="noopener">${escapeHtml(strOf(row.title) || '(无标题)')}</a></div>
    ${subtitle}
  </td>
  <td class="text-nowrap">${escapeHtml(nameFor(ctx.nameMap || {}, row.category, strOf(row.category) || '-'))}</td>
  <td>${cover}</td>
  <td class="text-nowrap">${statusCell('news', row)}</td>
  <td class="text-nowrap small">${intOr(row.view_count, 0)} / ${intOr(row.likes, 0)} / ${intOr(row.favorites, 0)}</td>
  <td class="text-nowrap small">${escapeHtml(strOf(row.publish_time).slice(0, 16))}</td>
  <td class="text-nowrap">${actionsCell(ctx, row)}</td>
</tr>`;
  }).join('');
}

// 批量区: 勾选后按 action 提交(approve/pending/delete), 同时把筛选与页码带回
function batchBar(ctx) {
  const query = ctx.query;
  return `<form method="post" action="/admin/news_batch_action" id="batchForm" class="d-flex flex-wrap align-items-center gap-2 mb-3 border rounded p-2">
  <input type="hidden" name="ids" id="batchIds">
  <input type="hidden" name="action" id="batchAction">
  <input type="hidden" name="category" value="${escapeHtml(strOf(query.category) || 'all')}">
  <input type="hidden" name="status" value="${escapeHtml(strOf(query.status) || 'all')}">
  <input type="hidden" name="keyword" value="${escapeHtml(strOf(query.keyword))}">
  <input type="hidden" name="page" value="${clampPage(query.page, null)}">
  <span class="small text-muted">批量操作</span>
  <button class="btn btn-sm btn-outline-success" type="button" data-batch="approve">设为显示</button>
  <button class="btn btn-sm btn-outline-warning" type="button" data-batch="pending">设为待审核</button>
  <button class="btn btn-sm btn-outline-danger" type="button" data-batch="delete">移入回收站</button>
</form>`;
}

// 批量操作脚本已搬到 static/js/news_batch.js(2.5.0): 模板字符串里改脚本容易整段坏掉, 搬出去才有语法检查

async function managePage(ctx) {
  const where = listWhere(ctx.query);
  // 分类筛选: 走共用的筛选按钮组(与留言管理页同一套), 参数仍是 ?category=xxx, 值取库里的分类
  const currentCategory = strOf(ctx.query.category);
  // COUNT、取行、分类下拉三条互不依赖 → 由 listController 一次并发发出(见 lib/listPage.js)
  const { total, totalPages, page, rows, extra, error } = await listController(ctx, {
    table: 'news', where, columns: LIST_COLUMNS, orderBy: 'publish_time DESC, id DESC',
    label: '获取笔记列表',
    parallel: () => optionsForSelect(ctx.env, currentCategory === 'all' ? '' : currentCategory)
  });
  const categoryOptions = extra || [];
  // 「分类」列要显示中文名称: 直接用上面那条分类查询的结果(key→名称)做映射, 不额外发语句;
  // 已删除/未登记的标识由 nameFor 回退成标识本身(便于在页面上发现历史脏数据)
  ctx.nameMap = Object.fromEntries(categoryOptions);
  const categoryFilter = filterButtons({
    baseUrl: MANAGE_URL, param: 'category', active: currentCategory || 'all', label: '按分类筛选',
    // 状态与关键词跟着一起切(与改前同一个表单提交的效果一致); 不带页码 → 切分类回到第 1 页
    extra: { status: strOf(ctx.query.status), keyword: strOf(ctx.query.keyword) },
    items: [['all', '全部分类']].concat(categoryOptions)
  });
  // 分类换成按钮组后, 本表单要把它带过去(与专题页 hidden topic 同一手法)
  // 搜索条: 与全站共用同一套结构/样式(searchBar), 参数名与取值不变; 隐藏字段把当前分类带过去
  const categoryForm = searchBar({
    action: MANAGE_URL,
    hidden: `<input type="hidden" name="category" value="${escapeHtml(currentCategory || 'all')}">`,
    body: searchSelect({
      name: 'status', value: strOf(ctx.query.status),
      items: [['all', '全部状态'], ['approved', '显示'], ['pending', '待审核'], ['rejected', '已拒绝']]
    }) + searchInput({ name: 'keyword', value: strOf(ctx.query.keyword), placeholder: '搜索标题/摘要' })
  });
  const content = batchBar(ctx) + listShell({
    title: '笔记', columns: COLUMNS, rows: renderRows(ctx, rows),
    // 2.3.3 三行结构: ① 发布笔记 + 回收站 ② 分类标签条 ③ 搜索表单(状态 + 关键字)
    actions: addButton('/admin/news_edit?id=0', '发布笔记')
      + `<a class="btn btn-outline-secondary" href="${RECYCLE_URL}"><i class="bi bi-trash3" aria-hidden="true"></i> 回收站</a>`,
    filters: categoryFilter,
    search: categoryForm,
    // 本页按 status 筛选: 就地切换状态后, 不再匹配当前筛选的行由 status-toggle.js 就地隐藏(与旧站同款)
    tableAttrs: ' data-status-filter-param="status"',
    tbodyId: 'newsTbody', sentinelId: 'newsLoadMore', textId: 'newsLoadMoreText',
    hintId: 'newsLoadedHint', total, perPage: PER_PAGE, currentPage: page, totalPages,
    unit: '条', backTopId: 'newsBackTopBtn',
    // 2.4.1: 去掉「跳至 N 页 / 跳转」—— 滚动加载下跳到第 N 页只会看到第 N 页的行,
    // 前面的行没加载出来, 看起来像丢数据; 只保留滚动加载 + 回到顶部。
    jump: false
  });
  return adminLayout({
    title: '笔记管理', currentPage: 'news_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content,
    scripts: pagerScript({
      tbodyId: 'newsTbody', sentinelId: 'newsLoadMore', textId: 'newsLoadMoreText',
      // 只给端点路径: 筛选参数由 AdminListLoader 按 location.search 拼(带 ?category= 时翻页才不丢筛选)
      rowsUrl: '/admin/news_manage_rows', currentPage: page, totalPages,
      total, perPage: PER_PAGE, unit: '条', hintId: 'newsLoadedHint', announceLabel: '笔记',
      // 2.4.1: 页面已没有跳页控件, 这里也不再下发跳页 id(只留回到顶部)
      baseUrl: MANAGE_URL, backTopId: 'newsBackTopBtn', jump: false,
      rowMarker: 'rowCheck', version: ctx.version
    }) + staticScript('js/news_batch.js', ctx.version)
  });
}

async function rowsFragment(ctx) {
  const where = listWhere(ctx.query);
  const page = clampPage(ctx.query.page, null);
  let rows = [];
  let nameMap = null;
  try {
    // 取行与分类名互不依赖 → 并发(片段里改前是两轮串行等待)
    [rows, nameMap] = await Promise.all([
      all(ctx.env,
        `SELECT ${LIST_COLUMNS} FROM news${where.sql} ORDER BY publish_time DESC, id DESC LIMIT ? OFFSET ?`,
        ...where.args, PER_PAGE + 1, (page - 1) * PER_PAGE),
      getNameMap(ctx.env)
    ]);
  } catch (err) {
    console.error('获取笔记分页数据失败', err && err.message);
    return json({ success: false, message: '加载失败，请稍后重试' });
  }
  const hasMore = rows.length > PER_PAGE;
  rows = rows.slice(0, PER_PAGE);
  if (!rows.length) return json({ success: true, rows: '', has_more: false });
  // 触底加载的片段也要显示分类名称(与首屏同一套渲染)
  ctx.nameMap = nameMap;
  return json({ success: true, rows: renderRows(ctx, rows), has_more: hasMore });
}


// 预览: 只读, 不给前台浏览量 +1(与旧站一致)
// 正文管线顺序照旧站 news_admin.news_preview: 净化 → 视频转 <video>(绝对地址) → 图片绝对化
// (2.4.0 起不再把正文配图换成 800px 缩略图: 缩略图功能整体移除, 一律用原图)
// 页面结构/类名与旧站 templates/news_preview.html 逐项对齐(.mp-preview/.mp-frame/.mp-card/.mp-meta/.mp-chip/
// .mp-author/.mp-video/.news-content + .page-actions-center), 宽度与字号来自 admin.css 的「小程序尺度统一层」——
// 与编辑区共用一份定义, 所以"预览所见 = 编辑所见"
async function previewPage(ctx) {
  const newsId = intOr(ctx.query.id, 0);
  const fail = (message) => adminLayout({
    title: '笔记预览', currentPage: 'news_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error: message,
    content: '<div class="card"><div class="card-body">请从「笔记管理」列表重新进入预览。</div></div>'
  });
  if (newsId <= 0) return fail('缺少笔记ID');
  const row = await one(ctx.env, 'SELECT * FROM news WHERE id = ?', newsId).catch(() => null);
  if (!row) return fail('新闻不存在');

  const base = mediaBase(ctx.env);
  const absolute = videoForBrowser(sanitizeHtml(strOf(row.content)), base);
  // 2.6.9: 正文配图在这里统一改成绝对地址 + 挂图片兜底 —— 注入点必须在 sanitizeHtml 之后,
  // 否则 onerror 会被清洗掉; 正文是用户内容, 图片地址经常是"早就删了的素材", 没有兜底就是一排裂图
  const body = absolute.replace(/<img\b([^>]*)>/gi, (whole, inner) => {
    const withSrc = inner.replace(/(\bsrc=["'])([^"']+)(["'])/i,
      (matched, head, src, tail) => head + assetUrl(ctx.env, src, '') + tail);
    return /onerror=/i.test(withSrc) ? `<img${withSrc}>` : `<img${withSrc} ${IMG_FALLBACK_ATTR}>`;
  });
  const nameMap = await getNameMap(ctx.env);
  const kind = statusKind('news');
  // 2.4.0: 封面与主视频直接给原图/原视频地址(原来会先探测有没有 800px 缩略图)
  const cover = strOf(row.image) ? assetUrl(ctx.env, row.image, '') : '';
  const mainVideo = strOf(row.video_url) ? assetUrl(ctx.env, row.video_url, '') : '';
  const desc = strOf(row.desc);

  const content = `<div class="row">
  <div class="col-12">
    <div class="card">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-center mb-3">
          ${statusCell('news', row)}
          <span class="text-muted small">
            <i class="bi bi-eye" aria-hidden="true"></i> ${intOr(row.view_count, 0)} ｜
            <i class="bi bi-hand-thumbs-up" aria-hidden="true"></i> ${intOr(row.likes, 0)} ｜
            <i class="bi bi-star" aria-hidden="true"></i> ${intOr(row.favorites, 0)}
          </span>
        </div>

        <div class="mp-preview mp-frame">
          <div class="mp-frame-hint">小程序笔记详情页预览（800px 宽，与编辑区一致）</div>
          <div class="mp-frame-hint">真机差异：小程序 rich-text 会过滤 &lt;video&gt;，视频要 mp-html 或原生 &lt;video&gt; 混合渲染才能播放；本页按 video 渲染，只为核对尺寸与封面。</div>
          ${cover ? `<div class="mp-cover-label">封面图（列表页展示）</div>
          ${imageTag(ctx.env, cover, { className: 'mp-cover', attrs: '' })}` : ''}
          <div class="mp-card">
            <div class="mp-title">${escapeHtml(strOf(row.title))}</div>
            ${desc ? `<div class="mp-cover-label">副标题（列表页展示）</div>
            <p class="text-muted small border-start border-3 ps-2">${escapeHtml(desc)}</p>` : ''}
            <div class="mp-meta">
              <span class="mp-chip">${escapeHtml(nameFor(nameMap, row.category, strOf(row.category) || '-'))}</span>
              <span>${escapeHtml(strOf(row.publish_time))}</span>
              <span class="mp-author">管理员</span>
            </div>
            ${mainVideo ? `<div class="mp-video">${videoPreview(ctx.env, mainVideo, { poster: row.image })}</div>` : ''}
            <div class="news-content">${body}</div>
          </div>
        </div>

        <hr>
        <div class="page-actions-center">
          ${backButton(`/admin/news_edit?id=${row.id}`, '返回编辑')}
          ${backButton(MANAGE_URL, '返回列表')}
        </div>
      </div>
    </div>
  </div>
</div>`;
  return adminLayout({
    title: '笔记预览', currentPage: 'news_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, content
  });
}

// 编辑: 正文先做视频转换再净化(顺序不能反 —— 净化会剥掉编辑器视频的外层容器, 先净化就认不出来了)
async function editPage(ctx) {
  const newsId = intOr(ctx.query.id, 0);
  const isNew = newsId <= 0;
  let error = ctx.error || '';
  let errorField = '';
  let row;

  if (isNew) {
    row = {
      id: 0, title: '', desc: '', content: '', category: '', image: '', video_url: '',
      status: 'pending', publish_time: nowLocalMinute(), activity_time: ''
    };
  } else {
    row = await one(ctx.env, "SELECT * FROM news WHERE id = ? AND type='admin_users' AND deleted_at IS NULL", newsId)
      .catch(() => null);
    if (!row) {
      return editView(ctx, {
        isNew: false, row: null, error: '找不到指定的笔记(仅可编辑官方发布的笔记)', errorField: '', options: []
      });
    }
  }
  const options = await optionsForSelect(ctx.env, row.category);
  if (!row.category && options.length) row.category = options[0][0];

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const title = strOf(form.title);
    const category = strOf(form.category);
    const image = strOf(form.image);
    const content = strOf(form.content);
    const videoUrl = strOf(form.video_url);
    const status = form.status ? 'approved' : 'pending';
    const publishTime = normalizeDatetime(form.publish_time) || beijingNow();
    const activityTime = strOf(form.activity_time);
    row = Object.assign({}, row, { title, category, image, content, video_url: videoUrl, status, publish_time: publishTime, activity_time: activityTime });

    const missing = [];
    if (!title) missing.push('标题');
    if (!category) missing.push('分类');
    if (!image) missing.push('封面图');
    if (!content) missing.push('正文内容');
    if (missing.length) {
      error = `请填写必填项: ${missing.join('、')}`;
      errorField = !title ? 'title' : (!category ? 'category' : (!image ? 'image' : 'content'));
    } else if (!options.some(([value]) => value === category)) {
      error = '分类无效：请从下拉框中选择「分类管理」里已登记的分类';
      errorField = 'category';
    }

    if (!error) {
      // 入库形态: 视频还原成 <wx-video> 且地址转相对; 图片地址也转相对(库内只存相对路径)
      const stored = imagesForStorage(videoForStorage(sanitizeHtml(content)));
      // 摘要留空则自动截取正文
      const desc = strOf(form.desc) || plainDesc(stored);
      try {
        if (isNew) {
          await run(ctx.env,
            "INSERT INTO news (title, \"desc\", content, category, image, video_url, type, status, publish_time, activity_time) "
            + "VALUES (?,?,?,?,?,?,'admin_users',?,?,?)",
            title, desc, stored, category, image, videoUrl, status, publishTime, activityTime);
        } else {
          await run(ctx.env,
            'UPDATE news SET title=?, "desc"=?, content=?, category=?, image=?, video_url=?, status=?, publish_time=?, activity_time=? '
            + "WHERE id=? AND type='admin_users'",
            title, desc, stored, category, image, videoUrl, status, publishTime, activityTime, newsId);
        }
        invalidateEntityCache('news');
        auditLog(`admin.news.${isNew ? 'create' : 'update'}`, { user: ctx.session.username, news_id: newsId, title });
        return redirect(buildListUrl(MANAGE_URL, { message: isNew ? '笔记发布成功' : '笔记更新成功' }));
      } catch (err) {
        console.error(`保存笔记失败 id=${newsId}`, err && err.stack ? err.stack : err);
        error = '保存失败，请稍后重试';
      }
    }
  }
  return editView(ctx, { isNew, row, error, errorField, options });
}

function editView(ctx, { isNew, row, error, errorField, options }) {
  if (!row) {
    return adminLayout({
      title: '编辑笔记', currentPage: 'news_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error,
      content: `<div class="card"><div class="card-body">${escapeHtml(error || '找不到指定的笔记')}</div></div>`
    });
  }
  // 回显: 视频转成编辑器认识的 <video>(根路径), 否则打开编辑页看不到视频、一保存就丢
  const contentValue = videoForEditor(strOf(row.content));
  // 字段顺序与旧站 news_edit.html 一致: 标题 → 分类 → 封面 → 视频地址 → 摘要 → 正文 → 发布设置卡 → 数据统计卡
  const main = textField({ name: 'title', label: '标题', value: row.title, required: true, errorField })
    + selectField({
      name: 'category', label: '分类', options: options.length ? options : [['', '（还没有可用分类）']],
      value: row.category, required: true, errorField
    })
    + imageUploadField({
      env: ctx.env, name: 'image', label: '封面图 URL', value: row.image, required: true,
      mediaPicker: true, errorField, hint: '封面建议使用 16:9 横版图片（如 1280×720）。'
    })
    + imageUploadField({
      env: ctx.env, name: 'video_url', label: '视频地址(可选)显示在正文之前', value: row.video_url,
      mediaKind: 'video', mediaPicker: true, errorField,
      // 2.7.7: 视频有了预览, 封面用笔记封面(row.image); 没有封面时由 videoPreview 落兜底图, 不会纯黑
      poster: row.image,
      hint: '填站内相对路径（如 video/video_x.mp4），或点右侧上传/从视频素材库选。'
    })
    + textareaField({
      name: 'desc', label: '摘要 / 描述 (留空则自动截取正文)', value: row.desc, rows: 3, errorField
    })
    + `<div class="mb-3">
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-1">
        <label class="form-label mb-0" for="contentRaw">正文内容 <span class="text-danger">*</span></label>
        <div class="d-flex flex-wrap gap-2">
          <button type="button" class="btn btn-outline-secondary" data-bs-toggle="modal" data-bs-target="#editorUploadModal">
            <i class="bi bi-cloud-arrow-up" aria-hidden="true"></i> 本地上传</button>
          <button type="button" class="btn btn-outline-secondary" data-bs-toggle="modal" data-bs-target="#mediaLibraryModal"
                  data-media-mode="editor" data-media-kind="image" data-media-lock-kind="1">
            <i class="bi bi-images" aria-hidden="true"></i> 图片素材库</button>
          <button type="button" class="btn btn-outline-secondary" data-bs-toggle="modal" data-bs-target="#mediaLibraryModal"
                  data-media-mode="editor" data-media-kind="video" data-media-lock-kind="1">
            <i class="bi bi-film" aria-hidden="true"></i> 视频素材库</button>
        </div>
      </div>
      <div class="mp-frame">
        <div id="contentToolbar" class="border rounded-top bg-light"></div>
        <div id="contentEditor" class="rich-editor border border-top-0 rounded-bottom${errorField === 'content' ? ' border-danger' : ''}"
             data-media-base="${escapeHtml(mediaBase(ctx.env))}"
             data-img-fallback="${escapeHtml(IMAGE_FALLBACK_SRC)}"${errorField === 'content' ? ' tabindex="-1" data-invalid="1"' : ''}></div>
      </div>
      <textarea id="contentRaw" name="content" class="form-control font-monospace d-none" rows="16" aria-required="true">${escapeHtml(contentValue)}</textarea>
      <div class="form-text" data-hint-mobile-hidden>
        富文本所见即所得，插图三种方式结果一致：① 上方<b>「本地上传」</b>（图片与视频都能选，传完插到正文光标处）；
        ② <b>「图片素材库」/「视频素材库」</b>（点选后插到光标处）；③ 工具栏「图片 → 上传图片」「视频 → 上传视频」。<br>
        图片以 <code>&lt;img src="image/…"&gt;</code> 入库、视频以小程序标签 <code>&lt;wx-video&gt;</code> 入库
        （编辑页在"浏览器能播"与"小程序存储格式"之间自动转换，打开能看、保存不丢）。视频支持 mp4 / mov / m4v / webm，网页上传上限 64MB；
        更大的视频可先传到素材目录再用「视频素材库」选。<br>
        编辑器资源若未能加载，页面会退回普通文本域并给出提示（不阻塞编辑保存）。
      </div>
    </div>`
    // 发布设置: 与旧站一样收在正文下面的一张卡里(不是右侧栏), 保存与返回也在卡内
    + `<div class="card mb-3"><div class="card-body">
      <div class="form-label">发布设置</div>
      ${switchField({ name: 'status', label: '立即显示 (不勾选则为待审核)', checked: strOf(row.status) === 'approved' })}
      ${textField({
      name: 'publish_time', label: '发布时间', value: datetimeLocalValue(row.publish_time), errorField,
      placeholder: 'YYYY-MM-DD HH:MM'
    })}
      ${textField({ name: 'activity_time', label: '活动时间(可选)', value: row.activity_time, errorField })}
      <div class="d-grid gap-2">
        <button class="btn btn-primary" type="submit"><i class="bi bi-check-lg" aria-hidden="true"></i> ${isNew ? '发布笔记' : '保存修改'}</button>
        ${backButton(MANAGE_URL, '返回列表')}
      </div>
    </div></div>`
    // 数据统计卡: 只在编辑已有笔记时出现(与旧站一致)
    + (isNew ? '' : `<div class="card"><div class="card-body small text-muted">
      数据统计：浏览 ${intOr(row.view_count, 0)} ｜ 点赞 ${intOr(row.likes, 0)} ｜ 收藏 ${intOr(row.favorites, 0)}
    </div></div>`);
  // 单列居中 + .mp-frame: 与旧站 news_edit 同布局, 也与预览页共用同一套"小程序尺度"
  const content = `<div class="card">
  <div class="card-body">
    <form method="post" action="/admin/news_edit${isNew ? '' : `?id=${row.id}`}">
      <div class="row g-3 justify-content-center">
        <div class="col-lg-8 mp-frame">${main}</div>
      </div>
    </form>
  </div>
</div>` + imageUploadModal({ name: 'image', purpose: 'cover' })
    + imageUploadModal({ name: 'video_url', purpose: 'video', kind: 'video' })
    // 正文「本地上传」: 图片与视频都收(kind=mixed), 传完由组件回调 MediaInsertFromUpload 插到光标处
    + imageUploadModal({ name: 'editor', purpose: 'content', kind: 'mixed', insert: 'editor', title: '上传图片或视频到正文' })
    + mediaLibraryModal();
  return adminLayout({
    title: '编辑笔记', currentPage: 'news_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content,
    // 编辑器只在编辑页加载: 样式 → 编辑器本体 → 本页的初始化脚本(顺序不能乱)
    scripts: [
      `<link rel="stylesheet" href="/admin/static/vendor/wangeditor/style.css?v=${encodeURIComponent(String(ctx.version || ''))}">`,
      `<script src="/admin/static/vendor/wangeditor/index.js?v=${encodeURIComponent(String(ctx.version || ''))}"></script>`,
      `<script src="/admin/static/js/news_editor.js?v=${encodeURIComponent(String(ctx.version || ''))}"></script>`
    ].join('\n')
  });
}

// 软删除: 标记 deleted_at 进回收站(可恢复), 子表数据与素材都保留
async function deleteSubmit(ctx) {
  const rawId = strOf(ctx.form.id);
  const page = strOf(ctx.form.page) || null;
  if (!positiveId(rawId)) {
    return redirect(buildListUrl(MANAGE_URL, { error: '无效的请求', page }));
  }
  const duplicated = await onceOrError(ctx, 'news_delete', [rawId]);
  if (duplicated) {
    return redirect(buildListUrl(MANAGE_URL, { error: duplicated, page }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, "SELECT title FROM news WHERE id=? AND type='admin_users' AND deleted_at IS NULL", intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到指定的官方笔记', page }));
    await run(ctx.env, "UPDATE news SET deleted_at=? WHERE id=? AND type='admin_users' AND deleted_at IS NULL",
      beijingNow(), intOr(rawId, 0));
    invalidateEntityCache('news');
    auditLog('admin.news.delete', { user: ctx.session.username, news_id: intOr(rawId, 0), title: row.title || '' });
    message = `笔记 "${strOf(row.title)}" 已移入回收站(ID：${intOr(rawId, 0)})，可在「笔记管理 → 回收站」恢复`;
  } catch (err) {
    console.error(`删除笔记失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试', page }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, page }));
}

// 复制: 新副本一律待审核; 活动时间的 YYYY/MM/DD 归一成 YYYY-MM-DD
async function copySubmit(ctx) {
  const rawId = strOf(ctx.form.id);
  const page = strOf(ctx.form.page) || null;
  if (!positiveId(rawId)) {
    return redirect(buildListUrl(MANAGE_URL, { error: '缺少有效的笔记ID参数', page }));
  }
  const duplicated = await onceOrError(ctx, 'news_copy', [rawId]);
  if (duplicated) {
    return redirect(buildListUrl(MANAGE_URL, { error: duplicated, page }));
  }
  let message = '';
  try {
    const original = await one(ctx.env, "SELECT * FROM news WHERE id=? AND type='admin_users'", intOr(rawId, 0));
    if (!original) return redirect(buildListUrl(MANAGE_URL, { error: '找不到指定的官方笔记', page }));
    const activity = strOf(original.activity_time).replace(/\//g, '-');
    const result = await run(ctx.env,
      'INSERT INTO news (title, "desc", content, image, category, video_url, activity_time, publish_time, status, type) '
      + "VALUES (?,?,?,?,?,?,?,?, 'pending', 'admin_users')",
      `${strOf(original.title)} (副本)`, strOf(original.desc), strOf(original.content), original.image,
      original.category, original.video_url, activity, beijingNow());
    const newId = (result && result.meta && result.meta.last_row_id) || 0;
    invalidateEntityCache('news');
    auditLog('admin.news.copy', { user: ctx.session.username, news_id: intOr(rawId, 0), new_id: newId });
    message = `笔记已成功复制！新ID: ${newId}`;
  } catch (err) {
    console.error(`复制笔记失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '复制失败，请稍后重试', page }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, page }));
}

// 批量: 只作用于官方笔记, 单次最多 200 条(防超大 IN 子句)
async function batchSubmit(ctx) {
  const form = ctx.form;
  const filters = { category: strOf(form.category), status: strOf(form.status), keyword: strOf(form.keyword) };
  const page = strOf(form.page) || null;
  const action = strOf(form.action);
  const ids = strOf(form.ids).split(',').map((item) => intOr(item.trim(), 0)).filter((id) => id > 0).slice(0, BATCH_MAX);
  if (!ids.length) return redirect(buildListUrl(MANAGE_URL, { error: '参数错误', filters, page }));
  if (!['approve', 'pending', 'delete'].includes(action)) {
    return redirect(buildListUrl(MANAGE_URL, { error: '不支持的操作类型', filters, page }));
  }
  const duplicated = await onceOrError(ctx, 'news_batch', [action, ids.join(',')]);
  if (duplicated) {
    return redirect(buildListUrl(MANAGE_URL, { error: duplicated, filters, page }));
  }
  let message = '';
  try {
    const marks = ids.map(() => '?').join(',');
    const found = await all(ctx.env,
      `SELECT id FROM news WHERE id IN (${marks}) AND type='admin_users' AND deleted_at IS NULL`, ...ids);
    const valid = found.map((item) => intOr(item.id, 0));
    if (!valid.length) return redirect(buildListUrl(MANAGE_URL, { error: '没有可操作的笔记', filters, page }));
    const validMarks = valid.map(() => '?').join(',');
    if (action === 'delete') {
      await run(ctx.env, `UPDATE news SET deleted_at=? WHERE id IN (${validMarks})`, beijingNow(), ...valid);
    } else {
      await run(ctx.env, `UPDATE news SET status=? WHERE id IN (${validMarks})`, action === 'approve' ? 'approved' : 'pending', ...valid);
    }
    invalidateEntityCache('news');
    auditLog('admin.news.batch', { user: ctx.session.username, action, count: valid.length, ids: valid.join(',') });
    const label = statusLabel(statusKind('news'), action === 'approve' ? 'approved' : 'pending');
    message = action === 'delete'
      ? `已成功将 ${valid.length} 条官方笔记移入回收站`
      : `已成功将 ${valid.length} 条官方笔记设为${label}状态`;
  } catch (err) {
    console.error(`批量操作失败 action=${action}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '操作失败，请稍后重试', filters, page }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, filters, page }));
}

// 到期清理: 把超过保留期的回收站记录连带子表一起清掉。
// 只由 purgeExpiredSubmit(超管 POST) 调用 —— 以前挂在回收站的 GET 上, 结果"打开页面就删数据",
// 既没有审计记录也说不清是谁删的, 还可能被浏览器/爬虫预取触发。
// 异常不再吞掉: 清理失败要能报给页面与日志, 静默失败会让人以为"回收站已经清干净了"。
async function purgeExpired(env) {
  const cutoff = new Date(Date.now() - RECYCLE_RETENTION_DAYS * 24 * 3600 * 1000);
  const cutoffText = new Date(cutoff.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const expired = await all(env, 'SELECT id FROM news WHERE deleted_at IS NOT NULL AND deleted_at < ?', cutoffText);
  const ids = expired.map((item) => intOr(item.id, 0)).filter((id) => id > 0);
  if (!ids.length) return 0;
  await cleanupNews(env, ids);
  invalidateEntityCache('news');
  return ids.length;
}

// 彻底删除时连带清子表: 与对外接口/用户彻底删除同一份表清单(全库无外键, 必须应用层级联)
// ids 可能一次上百条(批量操作 / 到期清理), 每条 IN 都按 D1 的 100 个绑定参数上限切片
async function cleanupNews(env, ids) {
  const statements = [];
  for (const chunk of chunkIds(ids)) {
    for (const table of ['news_likes', 'news_favorites', 'news_view_history', 'news_shares', 'news_comments']) {
      statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE news_id IN (${marksOf(chunk)})`).bind(...chunk));
    }
    statements.push(env.DB.prepare(`DELETE FROM news WHERE id IN (${marksOf(chunk)})`).bind(...chunk));
  }
  await env.DB.batch(statements);
}

async function recyclePage(ctx) {
  const source = strOf(ctx.query.source);
  const keyword = strOf(ctx.query.keyword);
  const clauses = ['deleted_at IS NOT NULL'];
  const args = [];
  if (source === 'admin') clauses.push("type = 'admin_users'");
  if (source === 'users') clauses.push("type = 'users'");
  if (keyword) {
    clauses.push('title LIKE ?');
    args.push(`%${keyword}%`);
  }
  let rows = [];
  let total = 0;
  let error = '';
  try {
    const where = ` WHERE ${clauses.join(' AND ')}`;
    // 两条查询互不依赖(回收站固定取 RECYCLE_LIMIT 行) → 一起发, 少等一次 D1 往返
    const [counted, listed, names] = await Promise.all([
      one(ctx.env, `SELECT COUNT(*) AS total FROM news${where}`, ...args),
      all(ctx.env, `SELECT ${RECYCLE_COLUMNS} FROM news${where} ORDER BY deleted_at DESC, id DESC LIMIT ?`,
        ...args, RECYCLE_LIMIT),
      // 「分类」列显示名称要用到(同一次并发里取, 不多等一次往返)
      getNameMap(ctx.env)
    ]);
    ctx.nameMap = names;
    total = intOr(counted && counted.total, 0);
    rows = listed;
  } catch (err) {
    console.error('获取回收站失败', err && err.message);
    rows = [];
    error = '读取数据失败，请稍后重试';
  }
  const rendered = rows.length ? rows.map((row) => {
    const image = strOf(row.image);
    const cover = image ? imageTag(ctx.env, image) : '-';   // 回收站列表同一份封面渲染(含兜底)
    const sourceBadge = strOf(row.type) === 'users'
      ? '<span class="badge text-bg-info">用户笔记</span>'
      : '<span class="badge text-bg-secondary">官方笔记</span>';
    return `<tr>
  <td class="text-nowrap">${row.id}</td>
  <td>${cover}</td>
  <td>${escapeHtml(strOf(row.title) || '-')}</td>
  <td class="text-nowrap">${sourceBadge}</td>
  <td class="text-nowrap">${escapeHtml(nameFor(ctx.nameMap || {}, row.category, strOf(row.category) || '-'))}</td>
  <td class="text-nowrap small">${escapeHtml(strOf(row.deleted_at).slice(0, 16))}</td>
  <td class="text-nowrap">
    <div class="action-cell justify-content-center">
      <form method="post" action="/admin/news_restore" class="d-inline">
        <input type="hidden" name="id" value="${row.id}">
        <input type="hidden" name="source" value="${escapeHtml(source)}">
        <input type="hidden" name="keyword" value="${escapeHtml(keyword)}">
        <button class="btn btn-sm btn-outline-success" type="submit"><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i> 恢复</button>
      </form>
      <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=news&amp;id=${row.id}">
        <i class="bi bi-trash" aria-hidden="true"></i> 彻底删除</a>
    </div>
  </td>
</tr>`;
  }).join('') : emptyRow(RECYCLE_COLUMNS_HEAD, '回收站是空的');
  // 搜索条: 共用实现(按钮文案也统一为「搜索」); 参数名 source/keyword 与取值不变
  const filterForm = searchBar({
    action: RECYCLE_URL,
    body: searchSelect({
      name: 'source', value: source,
      items: [['all', '全部来源'], ['admin', '官方笔记'], ['users', '用户笔记']]
    }) + searchInput({ name: 'keyword', value: keyword, placeholder: '搜索标题' })
  });
  const content = `<div class="card"><div class="card-body">
  <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
    <a class="btn btn-outline-secondary" href="${MANAGE_URL}"><i class="bi bi-arrow-left" aria-hidden="true"></i> 返回笔记管理</a>
    ${filterForm}
    ${ctx.session.isSuper ? `<form method="post" action="${PURGE_EXPIRED_URL}" class="d-inline"
        onsubmit="return confirm('清理超过 ${RECYCLE_RETENTION_DAYS} 天、已删除的记录？此操作不可恢复。')">
      <input type="hidden" name="confirm" value="1">
      <button class="btn btn-outline-danger" type="submit"><i class="bi bi-eraser" aria-hidden="true"></i> 清理到期记录</button>
    </form>` : ''}
    <span class="ms-auto text-end text-muted small">共 ${total} 条${total > rows.length ? `（仅显示最近 ${RECYCLE_LIMIT} 条）` : ''}
      · 超过 ${RECYCLE_RETENTION_DAYS} 天的记录由超管手工清理（打开本页不会再删任何东西）</span>
  </div>
  <div class="table-responsive">
    <table aria-label="回收站" class="table table-hover align-middle text-center">
      <thead class="table-light"><tr>${RECYCLE_COLUMNS_HEAD.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${rendered}</tbody>
    </table>
  </div>
</div></div>`;
  return adminLayout({
    title: '笔记回收站', currentPage: 'news_recycle', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content
  });
}

async function restoreSubmit(ctx) {
  const rawId = strOf(ctx.form.id);
  const filters = { source: strOf(ctx.form.source), keyword: strOf(ctx.form.keyword) };
  if (!positiveId(rawId)) {
    return redirect(buildListUrl(RECYCLE_URL, { error: '参数错误', filters }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT title FROM news WHERE id=? AND deleted_at IS NOT NULL', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(RECYCLE_URL, { error: '回收站中找不到该笔记', filters }));
    await run(ctx.env, 'UPDATE news SET deleted_at=NULL WHERE id=?', intOr(rawId, 0));
    invalidateEntityCache('news');
    auditLog('admin.news.restore', { user: ctx.session.username, news_id: intOr(rawId, 0) });
    message = `笔记 "${strOf(row.title)}" 已恢复`;
  } catch (err) {
    console.error(`恢复笔记失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(RECYCLE_URL, { error: '恢复失败，请稍后重试', filters }));
  }
  return redirect(buildListUrl(RECYCLE_URL, { message, filters }));
}

async function purgeSubmit(ctx) {
  const rawId = strOf(ctx.form.id);
  if (!positiveId(rawId)) {
    return redirect(buildListUrl(RECYCLE_URL, { error: '参数错误' }));
  }
  const duplicated = await onceOrError(ctx, 'news_purge', [rawId]);
  if (duplicated) {
    return redirect(buildListUrl(RECYCLE_URL, { error: duplicated }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT title FROM news WHERE id=? AND deleted_at IS NOT NULL', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(RECYCLE_URL, { error: '回收站中找不到该笔记' }));
    await cleanupNews(ctx.env, [intOr(rawId, 0)]);
    invalidateEntityCache('news');
    auditLog('admin.news.purge', { user: ctx.session.username, news_id: intOr(rawId, 0) });
    message = `笔记 "${strOf(row.title)}" 已彻底删除`;
  } catch (err) {
    console.error(`彻底删除笔记失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(RECYCLE_URL, { error: '删除失败，请稍后重试' }));
  }
  return redirect(buildListUrl(RECYCLE_URL, { message }));
}

// 到期清理(超管手工触发): 只认 POST + 确认标记, 并写一条审计 —— 删了多少、谁删的都能查
async function purgeExpiredSubmit(ctx) {
  if (strOf(ctx.form.confirm) !== '1') {
    return redirect(buildListUrl(RECYCLE_URL, { error: '请从回收站点「清理到期记录」提交（缺少确认标记）' }));
  }
  const duplicated = await onceOrError(ctx, 'news_purge_expired');
  if (duplicated) {
    return redirect(buildListUrl(RECYCLE_URL, { error: duplicated }));
  }
  let purged = 0;
  try {
    purged = await purgeExpired(ctx.env);
  } catch (err) {
    console.error('清理到期笔记失败', err && err.message);
    auditLog('admin.news.purge_expired', { user: ctx.session.username, ok: false, reason: err && err.message });
    return redirect(buildListUrl(RECYCLE_URL, { error: '清理失败，请稍后重试' }));
  }
  auditLog('admin.news.purge_expired', { user: ctx.session.username, count: purged });
  return redirect(buildListUrl(RECYCLE_URL, {
    message: purged ? `已清理 ${purged} 条超过 ${RECYCLE_RETENTION_DAYS} 天的记录` : '没有超过保留期的记录'
  }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'HEAD'], path: '/admin/news_manage_rows', handler: rowsFragment },
  { methods: ['GET', 'HEAD'], path: '/admin/news_preview', handler: previewPage },
  { methods: ['GET', 'POST'], path: '/admin/news_edit', handler: editPage },
  { methods: ['POST'], path: '/admin/news_delete', handler: deleteSubmit },
  { methods: ['POST'], path: '/admin/news_copy', handler: copySubmit },
  { methods: ['POST'], path: '/admin/news_batch_action', handler: batchSubmit },
  { methods: ['GET', 'HEAD'], path: RECYCLE_URL, handler: recyclePage },
  { methods: ['POST'], path: '/admin/news_restore', handler: restoreSubmit },
  { methods: ['POST'], path: '/admin/news_purge', handler: purgeSubmit },
  // 到期清理: 从回收站的 GET 挪到这里(超管 POST), 见 purgeExpiredSubmit
  { methods: ['POST'], path: PURGE_EXPIRED_URL, handler: purgeExpiredSubmit }
];
