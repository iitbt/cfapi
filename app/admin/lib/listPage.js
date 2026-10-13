// 列表页"取数 + 分页"骨架的唯一实现(news / users / comments / banners / notices / topics / admin_users 七个页面共用)
//
// 为什么需要它: 这七个模块的 `COUNT(*) → totalPages → firstScreenLimit → LIMIT 取行` 是同一套写法,
// 各写一份的结果是"分页边界与口径的修复要同步七处"(历史上的越界、跳页问题就是这么分散修的)。
// 各页真正不同的部分 —— 筛选条、表格外壳、行单元格 —— 仍留在页面里。
import { all, one } from '../../core/db.js';
import { MAX_FIRST_SCREEN_PAGES, PER_PAGE, firstScreenLimit, intOr } from './utils.js';

// 用法: const { total, totalPages, page, rows, extra, error } = await listController(ctx, {...})
//   table     表名(取行与计数都从这里拼); comments 这类带 JOIN 的页面用 from 覆盖
//   from      替代 FROM 后面的整段(如 'news_comments c LEFT JOIN users u ON …'), 默认同 table
//   where     各页自己的 *_where() 产出 { sql, args }
//   columns   取哪些列, 默认 *
//   orderBy   ORDER BY 后面的内容(必填: 各页排序口径不同, 不给默认免得悄悄排错)
//   parallel  与 COUNT/取行一起并发发出的额外查询(如笔记页的分类下拉), 结果原样回在 extra
//   label     日志里的名字(如"获取用户列表"), 失败时打 console.error; 失败文案用 failure 覆盖
export async function listController(ctx, options) {
  const perPage = options.perPage || PER_PAGE;
  const where = options.where || {};
  const args = where.args || [];
  const whereSql = where.sql || '';
  const from = options.from || options.table;
  const label = options.label || '列表';
  // 固定按"首屏最多渲染几页"的上限取行, 而不是先算当前页再取行: 只有 LIMIT 是定值,
  // COUNT 与取行才能一次并发发出(少等一次 D1 往返); 多取的那几行由下面的 slice 裁掉。
  const limit = MAX_FIRST_SCREEN_PAGES * perPage;
  try {
    const [counted, listed, extra] = await Promise.all([
      one(ctx.env, `SELECT COUNT(*) AS total FROM ${from}${whereSql}`, ...args),
      all(ctx.env, `SELECT ${options.columns || '*'} FROM ${from}${whereSql} ORDER BY ${options.orderBy} LIMIT ?`,
        ...args, limit),
      options.parallel ? options.parallel() : null
    ]);
    const total = intOr(counted && counted.total, 0);
    const totalPages = Math.max(Math.ceil(total / perPage), 1);
    const [page, firstScreenRows] = firstScreenLimit(ctx.query.page, perPage, totalPages);
    return { total, totalPages, page, rows: listed.slice(0, firstScreenRows), extra, error: '' };
  } catch (err) {
    // 查询失败要明说: 渲染成"暂无数据"会让运营以为数据被删了
    console.error(`${label}失败`, err && err.message);
    return {
      total: 0, totalPages: 1, page: 1, rows: [], extra: null,
      error: options.failure || '读取数据失败，请稍后重试'
    };
  }
}
