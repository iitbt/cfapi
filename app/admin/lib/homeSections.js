// 首页"三块内容"的唯一描述表(2.2.5: 原「首页精选管理」页合并进「首页板块管理」时抽出)
//   主题项目 / 拓展项目 → app_home_sections(同一张表用 section_key 区分)
//   精选项目            → app_featured_items(原首页精选的表: 未迁移数据、未改字段)
//
// 合并页 /admin/app_home_manage 的列头、行渲染、新增/编辑/删除入口全部由这里派生 ——
// 三块内容共用同一套表格与单元格实现, 不再各写一套; 板块名与取值口径也只有这一处。
// 2.3.8: 三个编辑页也合并了 —— 三块的 addUrl/editUrl 都指向 /admin/app_home_edit, 由 ?section= 区分
// (精选那边原来的 /admin/app_featured_edit 已删除)。
import { escapeHtml } from '../../core/html.js';
import { statusButtons, statusCell } from './status.js';
import { imageTag } from './partials.js';
import { nameFor } from './categorySource.js';

/** 三个板块的键(顺序即页面上的标签条与卡片顺序)。 */
export const SECTION_KEYS = ['main', 'ext', 'featured'];
/** 同属 app_home_sections 的板块: 取数时一条 SQL 拿回来再按 section_key 分组。 */
export const HOME_SECTION_KEYS = ['main', 'ext'];
/** 板块中文名(唯一维护点)。 */
const LABELS = { main: '主题项目', ext: '拓展项目', featured: '精选项目' };
/** 合并页的路径(编辑/删除回跳都指向它)。 */
export const MANAGE_URL = '/admin/app_home_manage';

export function sectionLabel(key) {
  const text = String(key === undefined || key === null ? '' : key).trim();
  return LABELS[text] || text || '-';
}

/** 认地址栏参数 ?section=: 不认识的值一律当"全部"(空串)。 */
export function sectionOf(raw) {
  const key = String(raw === undefined || raw === null ? '' : raw).trim();
  return SECTION_KEYS.indexOf(key) >= 0 ? key : '';
}

/** 新增/编辑表单里的"板块"下拉(只有落在 app_home_sections 的两块可选)。 */
export const SECTION_OPTIONS = HOME_SECTION_KEYS.map((key) => [key, LABELS[key]]);

/** 合并页筛选组的项(与其它管理页同一套的按钮组): 'all' = 全部(sectionOf('all') 也当"全部")。 */
export const SECTION_TABS = [['all', '全部']].concat(SECTION_KEYS.map((key) => [key, LABELS[key]]));

/** 预览单元格(封面缩略图, 与其它列表页一致的 .cover-thumb, 含加载失败兜底图)。 */
function previewCell(env, image) {
  const text = String(image === undefined || image === null ? '' : image);
  return text ? imageTag(env, text) : '-';
}

/** 操作列: 编辑 + 行内启停 + 删除(删除一律走服务端确认页, 前端 confirm 可被绕过)。 */
function actionsCell(spec, row, sectionKey) {
  const buttons = statusButtons(spec.kind, row);
  // 回跳带上"这一行所属的板块": 在拓展项目里删的, 不该退回主题项目的视图
  const back = `${MANAGE_URL}?section=${encodeURIComponent(sectionKey || spec.key)}`;
  const homeExtra = spec.table === 'app_home_sections' ? `&amp;section=${encodeURIComponent(spec.key)}` : '';
  return `<div class="action-cell justify-content-center">
    <a class="btn btn-sm btn-outline-primary" href="${escapeHtml(spec.editUrl(row.id))}"><i class="bi bi-pencil" aria-hidden="true"></i> 编辑</a>
    ${buttons}
    <a class="btn btn-sm btn-outline-danger" href="/admin/delete_confirm?kind=${spec.deleteKind}&amp;id=${row.id}${homeExtra}&amp;back=${encodeURIComponent(back)}">
      <i class="bi bi-trash" aria-hidden="true"></i> 删除</a>
  </div>`;
}

/** 主题项目 / 拓展项目: 同一张表、同一套列, 只有 section_key 与中文名不同。 */
function homeSectionSpec(key) {
  return {
    key,
    label: LABELS[key],
    table: 'app_home_sections',
    kind: 'home_section',
    columns: ['ID', '预览', '板块', '分类', '排序', '状态', '操作'],
    emptyText: '暂无板块入口',
    addLabel: '添加入口',
    // 这里写**未转义**的 & —— 2.3.2 起交给 partials.addButton 里的 escapeHtml 统一转义,
    // 若在这里先写成 &amp; 会被二次转义成 &amp;amp; → 链接失效
    // 2.3.8: 三个编辑页合并成一个, 类型由 ?section= 带过去(编辑页据此决定字段集与写入的表)
    addUrl: `/admin/app_home_edit?id=0&section=${key}`,
    editUrl: (id) => `/admin/app_home_edit?id=${id}&section=${key}`,
    deleteKind: 'home_section',
    cells(ctx, row) {
      // 分类名实时取自分类表(分类改名后这里立即跟随); 未知标识原样显示, 便于发现脏数据
      const itemId = String(row.item_id === undefined || row.item_id === null ? '' : row.item_id);
      const categoryText = nameFor(ctx.nameMap || {}, row.item_id, itemId);
      return `<td class="text-nowrap">${row.id}</td>`
        + `<td>${previewCell(ctx.env, row.image_url)}</td>`
        + `<td class="text-nowrap">${escapeHtml(sectionLabel(row.section_key))}</td>`
        + `<td class="text-nowrap">${escapeHtml(categoryText || '-')}</td>`
        + `<td class="text-nowrap">${row.sort_order}</td>`
        + `<td class="text-nowrap">${statusCell('home_section', row)}</td>`
        + `<td class="text-nowrap">${actionsCell(this, row, String(row.section_key || key))}</td>`;
    }
  };
}

/** 精选项目: 原「首页精选管理」那一页的内容(表与字段都没动, 只是入口挪到这里)。 */
function featuredSpec() {
  return {
    key: 'featured',
    label: LABELS.featured,
    table: 'app_featured_items',
    kind: 'app_featured',
    columns: ['ID', '预览', '标识', '名称', '跳转页面', '排序', '状态', '操作'],
    emptyText: '暂无精选内容',
    addLabel: '添加精选',
    // 2.3.8: 精选的编辑页也并进 /admin/app_home_edit(原来独立的 /admin/app_featured_edit 已删除)
    addUrl: '/admin/app_home_edit?id=0&section=featured',
    editUrl: (id) => `/admin/app_home_edit?id=${id}&section=featured`,
    deleteKind: 'featured',
    cells(ctx, row) {
      return `<td class="text-nowrap">${row.id}</td>`
        + `<td>${previewCell(ctx.env, row.image_url)}</td>`
        + `<td><code>${escapeHtml(row.item_key || '-')}</code></td>`
        + `<td><div class="text-truncate clamp-lg" title="${escapeHtml(String(row.name || ''))}">${escapeHtml(row.name || '-')}</div></td>`
        + `<td class="text-nowrap">${row.page_path ? `<code>${escapeHtml(row.page_path)}</code>` : '-'}</td>`
        + `<td class="text-nowrap">${row.sort_order}</td>`
        + `<td class="text-nowrap">${statusCell('app_featured', row)}</td>`
        + `<td class="text-nowrap">${actionsCell(this, row, 'featured')}</td>`;
    }
  };
}

/** 三块内容的描述(顺序 = 标签条顺序)。 */
export const SECTIONS = [homeSectionSpec('main'), homeSectionSpec('ext'), featuredSpec()];

/** 按 key 取描述(找不到回 undefined)。 */
export function sectionSpec(key) {
  return SECTIONS.find((item) => item.key === key);
}

/** 行排序: 主题/拓展 "板块顺序 → 排序值 → id"; 精选 "排序值 → id"(与各自旧页一致)。 */
export function sortSectionRows(key, rows) {
  const grouped = HOME_SECTION_KEYS.indexOf(key) >= 0;
  return rows.slice().sort((left, right) => {
    if (grouped) {
      const leftOrder = HOME_SECTION_KEYS.indexOf(String(left.section_key || ''));
      const rightOrder = HOME_SECTION_KEYS.indexOf(String(right.section_key || ''));
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }
    const bySort = Number(left.sort_order || 0) - Number(right.sort_order || 0);
    if (bySort !== 0) return bySort;
    return Number(left.id || 0) - Number(right.id || 0);
  });
}
