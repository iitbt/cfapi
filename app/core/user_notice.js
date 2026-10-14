// 给某个用户发一条"定向公告"(系统消息) —— 全站唯一写入口(cfapi 2.5.7 / 小程序 4.5.1)
//
// 为什么不另建一张"系统消息"表: 公告页、未读红点、已读落库(app_notice_reads)都已经是现成的,
// 定向消息只是把可见范围收窄到某些人(2.6.0 起为 receiver_type=3 + app_notices.target_user_ids);
// 另建一张表就得在小程序里再写一套"列表 + 红点 + 已读", 与项目"单点维护"的约定相悖。
//
// 2.6.0 起由"覆盖式"改为**每次新建一条**: 原先会先删掉同用户的旧消息(连同它的已读行)再插新的,
// 于是"设为内部测试 → 取消 → 再设为"这种来回操作只剩最后一条, 用户回头看不到中间发生过什么,
// 也没法从公告里回溯是谁在什么时候改过他的身份。代价是历史消息会累积在公告页里 —— 这是需求要的取舍。
// 已读仍按"用户 + 公告"一条一条记(app_notice_reads 有唯一索引), 所以新消息不会顶掉旧消息的已读状态, 也不会把别的未读一起清掉。
import { beijingNow } from './timeutil.js';
import { targetsMark } from './notice_targets.js';
import { logError } from './logging.js';

//: 级别固定 important: 这类消息是"你的身份变了", 需要比普通公告更显眼
const LEVEL = 'important';

/**
 * 新建一条只发给某个用户的公告。
 *
 * 主键: app_notices.id 是 INTEGER PRIMARY KEY AUTOINCREMENT, 由 SQLite 自增分配 ——
 * D1 对同一个数据库是**单写者**(写入串行), 所以并发调用也不会撞 id, 不需要时间戳/雪花那种外部生成。
 *
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
    // receiver_type=3(指定用户) + target_user_ids: 与后台"接收人=指定用户"完全同一套语义,
    // 定向消息和普通公告从此共用一个字段判定(收件人列表的写法见 core/notice_targets.js)
    const result = await env.DB.prepare(
      'INSERT INTO app_notices (title, content, level, link_type, link_value, sort_order, status, receiver_type, target_user_ids, create_time)'
      + " VALUES (?,?,?,'','',0,1,3,?,?)"
    ).bind(title, String(payload.content || ''), LEVEL, targetsMark(uid), beijingNow()).run();
    return Number(result && result.meta && result.meta.last_row_id) || 0;
  } catch (error) {
    logError('notice.push_user_notice_failed', error, { user_id: uid });
    return 0;
  }
}
