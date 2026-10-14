// 给某个用户发一条"定向公告"(系统消息) —— 全站唯一写入口(cfapi 2.5.7 / 小程序 4.5.1)
//
// 为什么不另建一张"系统消息"表: 公告页、未读红点、已读落库(app_notice_reads)都已经是现成的,
// 定向消息只是把可见范围收窄到一个人(app_notices.target_user_id 非空);
// 另建一张表就得在小程序里再写一套"列表 + 红点 + 已读", 与项目"单点维护"的约定相悖。
import { beijingNow } from './timeutil.js';
import { logError } from './logging.js';

//: 级别固定 important: 这类消息是"你的身份变了", 需要比普通公告更显眼
const LEVEL = 'important';

/**
 * 覆盖式发布一条定向公告: 同一用户只保留**最新一条**。
 * 先删旧的那条(连同它的已读行)再插新的 —— 否则"已通过"和"已取消"会同时躺在公告页里
 * 互相矛盾, 反复设置还会越堆越多; 删已读行则让新消息重新亮红点(否则旧 id 的已读会盖住红点)。
 *
 * 三条语句走一次 batch(1 轮 D1 往返; 串行就是 3 轮, 见 README "D1 响应"一节)。
 * 失败只记日志、不抛: 公告只是通知, 不能因为它失败就把管理员刚做完的身份变更"报成失败"。
 *
 * @param {object} env Worker 环境(D1 绑定名 DB)
 * @param {number|string} userId 收件用户 id
 * @param {{title: string, content?: string}} notice 标题与正文
 * @returns {Promise<number>} 新公告 id; 参数不全或写入失败回 0
 */
export async function pushUserNotice(env, userId, notice) {
  const uid = Number(userId) || 0;
  const payload = notice || {};
  const title = String(payload.title === undefined || payload.title === null ? '' : payload.title).trim();
  if (!uid || !title) return 0;
  try {
    const results = await env.DB.batch([
      // 删已读行用子查询而不是"先查 id 再拼 IN": 免去 D1"单条语句最多 100 个绑定参数"的坑
      env.DB.prepare('DELETE FROM app_notice_reads WHERE notice_id IN (SELECT id FROM app_notices WHERE target_user_id=?)').bind(uid),
      env.DB.prepare('DELETE FROM app_notices WHERE target_user_id=?').bind(uid),
      env.DB.prepare(
        'INSERT INTO app_notices (title, content, level, link_type, link_value, sort_order, status, target_user_id, create_time)'
        + " VALUES (?,?,?,'','',0,1,?,?)"
      ).bind(title, String(payload.content || ''), LEVEL, uid, beijingNow())
    ]);
    const inserted = results && results[results.length - 1];
    return Number(inserted && inserted.meta && inserted.meta.last_row_id) || 0;
  } catch (error) {
    logError('notice.push_user_notice_failed', error, { user_id: uid });
    return 0;
  }
}
