// 公告"指定用户"收件人列表的规范化读写(2.6.0) —— 唯一实现。
//
// 为什么要有这个文件: "一条公告可能发给多个指定用户"(2.6.0 起), 而这个列表的**存法**被三处共用 ——
//   ① 后台编辑页写入(app/admin/pages/notices.js)
//   ② 系统消息写入(app/core/user_notice.js)
//   ③ 小程序侧可见性判定(app/api/content.js 的 NOTICE_VISIBLE_SQL)
// 存法一旦各写一份, 迟早出现"后台存的是 7,9 而查询按 ,7, 匹配"这种静默失配(公告谁都收不到)。
//
// 存法: 逗号分隔的 users.id, **两端都带逗号**, 如 `,7,9,`。
//   两端带逗号是为了让查询能写 `target_user_ids LIKE '%,7,%'` —— 不然 `LIKE '%7%'` 会把 17、70 也算成收件人。
//   空串 = 没有收件人(只有 receiver_type=3 时有意义; 类型不是 3 时列表一律清空)。
// 2.5.7~2.5.9 用的是单值列 app_notices.target_user_id, 0010 已把老数据折进新列, 新代码只读新列。
import { idList } from './db.js';

/** 写入口: 单值 / 数组 / 逗号串 → 规范化列表 `,7,9,`(去重、丢掉非正整数); 没有有效值回空串。 */
export function targetsMark(value) {
  const ids = [];
  const raw = Array.isArray(value) ? value.join(',') : value;
  idList(raw).forEach((id) => {
    if (ids.indexOf(id) === -1) ids.push(id);
  });
  return ids.length ? `,${ids.join(',')},` : '';
}

/** 读出口: 存值 `,7,9,` → 正整数数组 [7, 9](顺序即写入顺序)。 */
export function targetsList(value) {
  return idList(value);
}

/**
 * LIKE 参数据: 判断"某个用户是不是这条公告的收件人"时绑定的那个值(`%,7,%`)。
 * 未登录/无 user id 时给 `%,0,%` —— users.id 从 1 起, 所以永不匹配,
 * 而不是给空串: `LIKE ''` 只会匹配"空收件人列表"的行, 那等于把没勾人的定向公告漏给游客。
 */
export function targetsLike(userId) {
  return `%,${Number(userId) || 0},%`;
}
