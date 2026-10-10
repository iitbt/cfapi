// 首页内容管理(2.2.5 起合并了原「首页精选管理」):
//   主题项目 / 拓展项目 → app_home_sections 的两个 section_key
//   精选项目            → app_featured_items(原首页精选的表, 数据与字段都没动)
//
// 三块内容的列头、行渲染、新增/编辑/删除入口都来自 lib/homeSections.js 的唯一描述表;
// 切换方式与 2.2.3 的筛选重构一致: 地址栏参数 ?section=main|ext|featured(空 = 全部) + 标签条。
// 2.3.8: 三个「添加」按钮合并成一个(按当前视图的板块决定 ?section=), 三个编辑页也合并成 editPage 一个
// (main|ext → 板块入口表单, featured → 精选表单); 精选原来的 /admin/app_featured_edit 已删除,
// 它的删除端点搬到这里(deleteFeaturedSubmit), 路径不变。
import { escapeHtml } from '../../core/html.js';
import { all, one, run } from '../../core/db.js';
import { adminLayout } from '../lib/layout.js';
import { getNameMap, getActiveKeys, nameFor, optionsForSelect } from '../lib/categorySource.js';
import {
  HOME_SECTION_KEYS, MANAGE_URL, SECTIONS, SECTION_OPTIONS, SECTION_TABS,
  sectionLabel, sectionOf, sortSectionRows
} from '../lib/homeSections.js';
import {
  addButton, editShell, emptyRow, filterButtons, imageUploadField, imageUploadModal, listMeta, listToolbar,
  mediaLibraryModal, numberField, selectField, switchField, textField
} from '../lib/partials.js';
import { auditLog, buildListUrl, intOr, invalidateEntityCache, strOf } from '../lib/utils.js';

const EDIT_URL = '/admin/app_home_edit';
const DELETE_URL = '/admin/app_home_delete';
//: 精选标识格式: 小写字母开头 + 小写字母/数字/下划线, 最长 40(与旧站 FEATURED_KEY_PATTERN 一致)
const FEATURED_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * 单个板块的卡片: 标题 + 条数 + 表格(列头与行都来自描述表)。
 * 2.3.7 起「添加…」按钮不再挂在这里(靠右的小角落), 而是提到页面第一行 —— 与 news_manage 同构:
 * 第一行 = 新增按钮(左), 第二行 = 板块标签条, 卡片头部只留板块名与条数。
 */
function sectionCard(ctx, spec, rows) {
  const body = rows.length
    ? rows.map((row) => `<tr>${spec.cells(ctx, row)}</tr>`).join('')
    : emptyRow(spec.columns, spec.emptyText);
  return `<div class="card mb-3"><div class="card-body">
  <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
    <h2 class="h6 mb-0">${escapeHtml(spec.label)}</h2>
    ${listMeta({ total: rows.length, unit: '条', simple: true })}
  </div>
  <div class="table-responsive">
    <table aria-label="${escapeHtml(spec.label)}列表" class="table table-hover align-middle text-center">
      <thead class="table-light"><tr>${spec.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>
</div></div>`;
}

async function managePage(ctx) {
  const section = sectionOf(ctx.query.section);          // 空 = 全部
  const visible = SECTIONS.filter((spec) => !section || spec.key === section);
  const homeKeys = visible.filter((spec) => spec.table === 'app_home_sections').map((spec) => spec.key);
  const wantFeatured = visible.some((spec) => spec.table === 'app_featured_items');
  let homeRows = [];
  let featuredRows = [];
  let error = '';
  try {
    // 两块内容互不依赖 → 并发(各占一次 D1 往返); 只查当前可见的那几块
    const [home, featured] = await Promise.all([
      homeKeys.length
        ? all(ctx.env,
          `SELECT * FROM app_home_sections WHERE section_key IN (${homeKeys.map(() => '?').join(',')})`,
          ...homeKeys)
        : [],
      wantFeatured ? all(ctx.env, 'SELECT * FROM app_featured_items') : []
    ]);
    homeRows = home;
    featuredRows = featured;
  } catch (err) {
    console.error('获取首页内容失败', err && err.message);
    error = '读取数据失败，请稍后重试';
  }
  // 分类名实时取自分类表(分类改名后列表立即跟随)
  ctx.nameMap = await getNameMap(ctx.env);

  const cards = visible.map((spec) => {
    const source = spec.table === 'app_home_sections'
      ? homeRows.filter((row) => String(row.section_key || '') === spec.key)
      : featuredRows;
    return sectionCard(ctx, spec, sortSectionRows(spec.key, source));
  }).join('');

  // 板块标签条: 与留言/笔记页同一套(共用 filterButtons), 参数仍是 ?section=all|main|ext|featured
  const filterBar = filterButtons({
    baseUrl: MANAGE_URL, param: 'section', active: section || 'all',
    label: '按首页内容板块筛选', items: SECTION_TABS
  });
  // 2.3.7 头部结构与 news_manage 同构(共用 listToolbar): 第一行新增按钮、第二行板块标签条(无搜索表单)。
  // 2.3.8: 三个「添加」按钮合并成一个 —— 类型由当前视图决定(选了某个板块就带那个 section, 「全部」时默认主题项目),
  // 文案沿用该板块的 addLabel(「全部」视图用通用的「添加」); 要加另一种类型在编辑页里一次点击即可切换。
  const activeSpec = SECTIONS.find((spec) => spec.key === section);
  const addEntry = addButton(
    activeSpec ? activeSpec.addUrl : SECTIONS[0].addUrl,
    activeSpec ? activeSpec.addLabel : '添加'
  );
  const content = listToolbar({ primary: addEntry, filters: filterBar })
    + (cards || '<div class="card"><div class="card-body">没有可展示的板块。</div></div>');

  return adminLayout({
    title: '首页板块管理', currentPage: 'app_home_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version,
    message: ctx.message, error: error || ctx.error, content
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

/**
 * 老地址(?id=N 不带 section)也要能编辑: 先在板块表里找, 找不到再去精选表找一次。
 * 带 section 时直接按它定位对应的表(正常路径只有 1 条查询)。
 */
async function loadEditRow(env, rowId, wanted) {
  if (wanted === 'featured') {
    return { kind: 'featured', row: await one(env, 'SELECT * FROM app_featured_items WHERE id = ?', rowId).catch(() => null) };
  }
  const home = await one(env, 'SELECT * FROM app_home_sections WHERE id = ?', rowId).catch(() => null);
  if (home || wanted) return { kind: 'home', row: home };
  const featured = await one(env, 'SELECT * FROM app_featured_items WHERE id = ?', rowId).catch(() => null);
  return featured ? { kind: 'featured', row: featured } : { kind: 'home', row: null };
}

/** 精选标识唯一性检查: 查询异常时按"已占用"处理(阻止保存) —— 旧站 B1 修复的教训: 异常当"无重复"会放行脏数据。 */
async function featuredKeyExists(env, itemKey, rowId) {
  try {
    const found = await one(env, 'SELECT id FROM app_featured_items WHERE item_key=? AND id<>?', itemKey, rowId);
    return Boolean(found);
  } catch (error) {
    console.error('检查精选标识唯一性失败', error && error.message);
    return true;
  }
}

// 2.3.8: 主题项目 / 拓展项目 / 精选项目 三个编辑页合并成一个。
//   类型由 ?section= 决定: main|ext → app_home_sections(板块入口); featured → app_featured_items(精选)。
//   两者字段集不同, 所以按类型渲染表单、按类型校验与写入 —— 各写各的表, 互不串改。
async function editPage(ctx) {
  const rowId = intOr(ctx.query.id, 0);
  const isNew = rowId <= 0;
  const wanted = sectionOf(ctx.query.section);
  let kind = wanted === 'featured' ? 'featured' : 'home';
  let row;
  if (isNew) {
    // 新增: 类型只看参数(不查库); 从某个板块的「添加」进来时预选那个板块(?section=), 否则默认第一块
    row = kind === 'featured'
      ? { id: 0, item_key: '', name: '', image_url: '', page_path: '', sort_order: 0, status: 1 }
      : {
        id: 0, section_key: wanted || HOME_SECTION_KEYS[0],
        item_id: '', name: '', image_url: '', sort_order: 0, status: 1
      };
  } else {
    const loaded = await loadEditRow(ctx.env, rowId, wanted);
    kind = loaded.kind;
    row = loaded.row;
    if (!row) return editView(ctx, { isNew: false, kind, row: null, error: '找不到该配置项', errorField: '', options: [] });
  }
  // 板块入口要用"启用中的分类"校验、并列出分类下拉; 精选项目两者都不需要(不为它白查库)
  const activeKeys = kind === 'home' ? await getActiveKeys(ctx.env) : new Set();
  const options = kind === 'home' ? await optionsForSelect(ctx.env, row.item_id) : [];

  if (ctx.method === 'POST') {
    const form = ctx.form;
    const sortOrder = intOr(form.sort_order, 0);
    const status = form.status ? 1 : 0;
    let error = '';
    let errorField = '';

    if (kind === 'featured') {
      const itemKey = strOf(form.item_key);
      const name = strOf(form.name);
      const imageUrl = strOf(form.image_url);
      const pagePath = strOf(form.page_path);
      row = { id: rowId, item_key: itemKey, name, image_url: imageUrl, page_path: pagePath, sort_order: sortOrder, status };

      if (!itemKey) {
        error = '请填写必填项: 标识';
        errorField = 'item_key';
      } else if (!FEATURED_KEY_PATTERN.test(itemKey)) {
        error = '标识格式不正确: 小写字母开头, 只允许小写字母/数字/下划线, 最长 40';
        errorField = 'item_key';
      } else if (await featuredKeyExists(ctx.env, itemKey, rowId)) {
        error = '该标识已被其它精选使用, 请换一个(标识在本模块内必须唯一)';
        errorField = 'item_key';
      } else if (!name) {
        error = '请填写必填项: 名称';
        errorField = 'name';
      } else if (!imageUrl) {
        error = '请填写必填项: 图片地址';
        errorField = 'image_url';
      } else if (!pagePath) {
        error = '请填写必填项: 跳转页面';
        errorField = 'page_path';
      }
      if (!error) {
        try {
          if (isNew) {
            await run(ctx.env,
              'INSERT INTO app_featured_items (item_key, name, image_url, page_path, sort_order, status) VALUES (?,?,?,?,?,?)',
              itemKey, name, imageUrl, pagePath, sortOrder, status);
          } else {
            await run(ctx.env,
              'UPDATE app_featured_items SET item_key=?, name=?, image_url=?, page_path=?, sort_order=?, status=? WHERE id=?',
              itemKey, name, imageUrl, pagePath, sortOrder, status, rowId);
          }
          invalidateEntityCache('featured');
          auditLog(`admin.app_featured.${isNew ? 'create' : 'update'}`,
            { user: ctx.session.username, featured_id: rowId, item_key: itemKey });
          return redirect(buildListUrl(MANAGE_URL, {
            message: isNew ? '精选已添加' : '精选已更新', filters: { section: 'featured' }
          }));
        } catch (err) {
          console.error(`保存精选失败 id=${rowId}`, err && err.stack ? err.stack : err);
          error = '保存失败，请稍后重试';
        }
      }
    } else {
      const sectionKey = strOf(form.section_key);
      const itemId = strOf(form.item_id);
      const imageUrl = strOf(form.image_url);
      row = { id: rowId, section_key: sectionKey, item_id: itemId, name: row.name, image_url: imageUrl, sort_order: sortOrder, status };

      if (HOME_SECTION_KEYS.indexOf(sectionKey) < 0) {
        error = '请选择有效的板块';
        errorField = 'section_key';
      } else if (!activeKeys.has(itemId)) {
        error = '请选择有效的分类（须为「分类管理」中已启用的分类）';
        errorField = 'item_id';
      } else if (!imageUrl) {
        error = '请填写必填项: 图片地址';
        errorField = 'image_url';
      }
      if (!error) {
        // 显示名统一跟随分类表: 分类改名后首页入口自动跟着改, 不必再来这里改一遍
        const nameMap = await getNameMap(ctx.env);
        const derivedName = nameFor(nameMap, itemId, itemId);
        try {
          if (isNew) {
            await run(ctx.env,
              'INSERT INTO app_home_sections (section_key, item_id, name, image_url, sort_order, status) VALUES (?,?,?,?,?,?)',
              sectionKey, itemId, derivedName, imageUrl, sortOrder, status);
          } else {
            await run(ctx.env,
              'UPDATE app_home_sections SET section_key=?, item_id=?, name=?, image_url=?, sort_order=?, status=? WHERE id=?',
              sectionKey, itemId, derivedName, imageUrl, sortOrder, status, rowId);
          }
          invalidateEntityCache('home_section');
          auditLog(`admin.app_home.${isNew ? 'create' : 'update'}`,
            { user: ctx.session.username, home_section_id: rowId, section_key: sectionKey });
          return redirect(buildListUrl(MANAGE_URL, {
            message: isNew ? '板块入口添加成功' : '板块入口已更新',
            filters: { section: sectionOf(sectionKey) }
          }));
        } catch (err) {
          console.error(`保存板块入口失败 id=${rowId}`, err && err.stack ? err.stack : err);
          error = '保存失败，请稍后重试';
        }
      }
      row.name = row.name || '';
    }
    // 校验失败: 留在表单里(提交过的值回填 + 出错字段高亮), 不回列表
    return editView(ctx, { isNew, kind, row, error, errorField, options });
  }
  return editView(ctx, { isNew, kind, row, error: ctx.error || '', errorField: '', options });
}

function editView(ctx, { isNew, kind, row, error, errorField, options }) {
  const isFeatured = kind === 'featured';
  const pageTitle = isFeatured ? '编辑精选项目' : '编辑板块入口';
  if (!row) {
    return adminLayout({
      title: pageTitle, currentPage: 'app_home_manage', admin: ctx.session.username,
      isSuper: ctx.session.isSuper, version: ctx.version, error: error || '找不到该配置项',
      content: '<div class="card"><div class="card-body">找不到该配置项，可能已被删除。</div></div>'
    });
  }
  // 两类字段集(合并前分别在 app_home_edit / app_featured_edit 两个页面里, 现在按 ?section= 选一套)
  const main = isFeatured
    ? textField({
      name: 'item_key', label: '标识', value: row.item_key, required: true, errorField,
      placeholder: '如 outdoor_sale',
      hint: '小写字母开头，只允许小写字母/数字/下划线，最长 40；本模块内不可重复。'
    }) + textField({ name: 'name', label: '名称', value: row.name, required: true, errorField, placeholder: '如 户外精选' })
      + imageUploadField({
        env: ctx.env, name: 'image_url', label: '图片地址', value: row.image_url,
        required: true, mediaPicker: true, errorField
      })
      + textField({
        name: 'page_path', label: '跳转页面', value: row.page_path, required: true, errorField,
        placeholder: '如 /pages/outdoor/outdoor'
      })
    : selectField({
      name: 'section_key', label: '板块', options: SECTION_OPTIONS, value: row.section_key, errorField,
      hint: '主题项目与拓展项目对应小程序首页的两排入口；「精选项目」字段不同（标识/名称/跳转页面），切到「精选项目」视图后添加。'
    }) + selectField({
      name: 'item_id', label: '分类', options: options.length ? options : [['', '（还没有可用分类）']],
      value: row.item_id, errorField, required: true,
      hint: '入口点进去看到的是这个分类下的笔记，所以只能选「分类管理」里已启用的分类。'
    }) + imageUploadField({
      env: ctx.env, name: 'image_url', label: '图片地址', value: row.image_url,
      required: true, mediaPicker: true, errorField
    });
  const side = numberField({ name: 'sort_order', label: '排序 (小在前)', value: row.sort_order, errorField })
    + switchField({ name: 'status', label: '启用展示', checked: intOr(row.status, 0) === 1 });
  const section = isFeatured ? 'featured' : (sectionOf(row.section_key) || HOME_SECTION_KEYS[0]);
  const back = `${MANAGE_URL}?section=${encodeURIComponent(section)}`;
  // 新增时给一条"换一种类型"的入口: 合并前列表页上是三个按钮, 现在合并成一个 + 这里一次点击
  const switcher = isNew
    ? `<div class="alert alert-light border small mb-3">正在添加「${escapeHtml(sectionLabel(section))}」。
      <a href="${EDIT_URL}?id=0&amp;section=${isFeatured ? 'main' : 'featured'}">改为添加${isFeatured ? '板块入口（主题/拓展项目）' : '精选项目'}</a></div>`
    : '';
  const content = editShell({
    action: `${EDIT_URL}?section=${section}${isNew ? '' : `&id=${row.id}`}`,
    top: switcher, main, side, backUrl: back, backLabel: '返回列表',
    primaryLabel: isNew ? (isFeatured ? '添加精选' : '添加入口') : '保存修改'
  }) + imageUploadModal({ name: 'image_url', purpose: 'cover' }) + mediaLibraryModal();
  return adminLayout({
    title: pageTitle, currentPage: 'app_home_manage', admin: ctx.session.username,
    isSuper: ctx.session.isSuper, version: ctx.version, error, content
  });
}

async function deleteSubmit(ctx) {
  const rawId = ctx.form.id;
  const section = sectionOf(ctx.form.section);
  if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误', filters: { section } }));
  }
  let message = '';
  let redirectSection = section;
  try {
    const row = await one(ctx.env, 'SELECT section_key, image_url FROM app_home_sections WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该配置项', filters: { section } }));
    // 回跳优先按这一行自己所属的板块: 删的是"拓展项目"里的入口, 不该退回"主题项目"的筛选视图
    redirectSection = sectionOf(row.section_key) || section;
    await run(ctx.env, 'DELETE FROM app_home_sections WHERE id = ?', intOr(rawId, 0));
    auditLog('admin.app_home.delete', {
      user: ctx.session.username, home_section_id: intOr(rawId, 0),
      section_key: row.section_key || '', image_url: row.image_url || ''
    });
    invalidateEntityCache('home_section');
    message = '板块入口已删除';
  } catch (err) {
    console.error(`删除板块入口失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试', filters: { section } }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, filters: { section: redirectSection } }));
}

// 精选项目的删除(2.3.8 从 pages/appFeatured.js 搬进来: 那个模块的编辑页已合并, 只剩删除这一个入口)
async function deleteFeaturedSubmit(ctx) {
  const rawId = ctx.form.id;
  if (!rawId || !/^\d+$/.test(String(rawId).replace('-', ''))) {
    return redirect(buildListUrl(MANAGE_URL, { error: '参数错误', filters: { section: 'featured' } }));
  }
  let message = '';
  try {
    const row = await one(ctx.env, 'SELECT item_key, image_url FROM app_featured_items WHERE id = ?', intOr(rawId, 0));
    if (!row) return redirect(buildListUrl(MANAGE_URL, { error: '找不到该精选项', filters: { section: 'featured' } }));
    await run(ctx.env, 'DELETE FROM app_featured_items WHERE id = ?', intOr(rawId, 0));
    // 只删配置记录, 磁盘/桶上的图片按素材保留策略留下(同一张图可能被多处引用)
    auditLog('admin.app_featured.delete', {
      user: ctx.session.username, featured_id: intOr(rawId, 0),
      item_key: row.item_key || '', image_url: row.image_url || ''
    });
    invalidateEntityCache('featured');
    message = '精选已删除';
  } catch (err) {
    console.error(`删除精选失败 id=${rawId}`, err && err.message);
    return redirect(buildListUrl(MANAGE_URL, { error: '删除失败，请稍后重试', filters: { section: 'featured' } }));
  }
  return redirect(buildListUrl(MANAGE_URL, { message, filters: { section: 'featured' } }));
}

export const routes = [
  { methods: ['GET', 'HEAD'], path: MANAGE_URL, handler: managePage },
  { methods: ['GET', 'POST'], path: EDIT_URL, handler: editPage },
  { methods: ['POST'], path: DELETE_URL, handler: deleteSubmit },
  { methods: ['POST'], path: '/admin/app_featured_delete', handler: deleteFeaturedSubmit }
];
