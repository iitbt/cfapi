// 内容下发: 轮播图 / 户外 / 摩旅 / 公告 / 未读数 / 标记已读 (共 6 条)
import { bannersFail, bannersOk, fail, legacyFail, legacyOk, ok, okMessage } from '../core/response.js';
import { all, intOf, one, run, str } from '../core/db.js';
import { assetUrl } from '../core/media_scheme.js';
import { currentUser, tokenOf } from './helpers.js';
import { clampPage } from './schemas.js';
import { beijingNow } from '../core/timeutil.js';
import { logError } from '../core/logging.js';
import { cacheOnce } from '../core/ttlCache.js';

const LEVEL_TEXT = { info: '公告', warning: '提醒', important: '重要' };
//: 轮播图几乎不变, 却每次进首页都要查一次: 按 isolate 缓存 30 秒(代价: 后台上新图后最多 30 秒小程序侧才看到)
const BANNERS_CACHE_TTL_MS = 30 * 1000;
//: 未读公告只要 id 列表, 封顶 200 条: 公告是运营内容, 不会同时上线几百条, 而改前没有 LIMIT
const UNREAD_NOTICE_LIMIT = 200;
// 公告"接收人"可见性(2.5.9): 一条 OR 查询判完四种接收人 ——
//   0=所有用户(含游客; 历史数据默认值, 语义与改造前完全一致)
//   1=内部测试用户   2=普通用户(已登录且不是内部测试)
//   3=指定用户(单个, 认 app_notices.target_user_id)
// 占位符顺序: 观看者档位 ×2, 指定用户 id ×1(见 noticeViewer)
// 为什么不拆成"先查类型再查列表": 公告量极小(运营内容), 一条 OR 能保证列表/计数/未读三处口径逐字一致
const NOTICE_VISIBLE_SQL = '(receiver_type=0'
  + ' OR (receiver_type=1 AND ?=1)'
  + ' OR (receiver_type=2 AND ?=0)'
  + ' OR (receiver_type=3 AND target_user_id=?))';
// 生效中的公告(启用 + 在生效区间内), 占位符顺序: start_at, end_at
const NOTICE_ACTIVE_SQL = "status=1 AND (start_at IS NULL OR start_at='' OR start_at<=?) AND (end_at IS NULL OR end_at='' OR end_at>=?)";

/**
 * 观看者档位 —— 只用于 NOTICE_VISIBLE_SQL 的两个占位符:
 *   1=已登录的内部测试用户 / 0=已登录的普通用户 / -1=游客。
 * 游客取 -1: 两个"按用户类型"的分支都命中不了, 于是游客只看得到 receiver_type=0(所有用户)的公告,
 * 而历史公告全是 0 —— 未登录行为跟改造前一模一样。定向消息(3)与游客无关。
 */
function noticeViewer(user) {
  if (!user) return -1;
  return Number(user.is_trusted) === 1 ? 1 : 0;
}

/**
 * 当前用户"看得到、还没读过"的公告 id(倒序, 封顶 UNREAD_NOTICE_LIMIT)。
 * /content/get_notice_unread 与 /content/notice_read 共用这一份口径 ——
 * 旧实现里 notice_read 回的是"全体公告数 - 我的已读行数", 有了定向公告后那个减法会把别人的消息算成我的未读。
 */
async function unreadNoticeIds(env, userId, viewer) {
  const now = beijingNow();
  const [rows, readRows] = await Promise.all([
    all(env, `SELECT id FROM app_notices WHERE ${NOTICE_ACTIVE_SQL} AND ${NOTICE_VISIBLE_SQL} ORDER BY id DESC LIMIT ?`,
      now, now, viewer, viewer, userId, UNREAD_NOTICE_LIMIT),
    all(env, 'SELECT notice_id FROM app_notice_reads WHERE user_id=?', userId)
  ]);
  const readSet = new Set(readRows.map((row) => Number(row.notice_id)));
  return rows.map((row) => Number(row.id)).filter((id) => !readSet.has(id));
}
const VIDEO_TABLES = ['outdoor_activities', 'motorcycle_trips'];
const COLUMNS = {
  outdoor_activities: 'id,title,description,date,location,poster,videoUrl,created_at,updated_at',
  motorcycle_trips: 'id,title,description,distance,duration,difficulty,poster,videoUrl,created_at,updated_at'
};

function limitOf(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = intOf(value, fallback);
  if (parsed <= 0) return 0;
  return Math.min(parsed, max);
}

function normalizeTopic(row, env, canWatch) {
  const out = Object.assign({}, row);
  if (out.videoUrl !== undefined) {
    out.video_url = out.videoUrl;
    delete out.videoUrl;
  }
  out.poster = assetUrl(env, out.poster);
  if (out.video_url) {
    if (canWatch) {
      out.video_url = assetUrl(env, out.video_url);
    } else {
      delete out.video_url;
    }
  }
  out.can_watch_video = !!canWatch;
  return out;
}

export function registerContentRoutes(router) {
  router.any('/content/get_banners', async (request, env, ctx, args) => {
    const body = args.body || {};
    try {
      const position = str(body.position, 'news') || 'news';
      const limit = limitOf(body.limit, 5, 50);
      // 缓存键含 position/limit: 不同取法各存一份, 命中时这页少一次 D1 往返
      const rows = await cacheOnce(`api:banners:${position}:${limit}`, BANNERS_CACHE_TTL_MS, () => all(
        env,
        'SELECT id,title,image_url,link_url FROM banner_images WHERE position=? AND status=1 ORDER BY sort_order ASC, id DESC LIMIT ?',
        position, limit === 0 ? 200 : limit
      ));
      const data = rows.map((row) => ({
        id: row.id,
        title: row.title === undefined ? null : row.title,
        image_url: assetUrl(env, row.image_url),
        link_url: row.link_url === undefined ? null : row.link_url
      }));
      return bannersOk(data);
    } catch (error) {
      return bannersFail();
    }
  });

  router.any('/content/get_outdoor', (request, env, ctx, args) => topicHandler(request, env, args, 'outdoor_activities'));
  router.any('/content/get_motorcycle', (request, env, ctx, args) => topicHandler(request, env, args, 'motorcycle_trips'));

  async function topicHandler(request, env, args, table) {
    const body = args.body || {};
    // 成功文案与旧站逐字一致: 旧站两条专题接口各有自己的 msg/message
    const message = table === 'motorcycle_trips' ? '获取摩旅精选数据成功' : '获取户外精选数据成功';
    try {
      const user = await currentUser(env, request, body);
      const canWatch = !!(user && Number(user.is_trusted) === 1);
      const page = intOf(body.page, 0);
      const size = Math.min(Math.max(1, intOf(body.page_size || body.pageSize || body.limit, 2)), 20);
      const columns = COLUMNS[table];
      if (page <= 0) {
        const rows = await all(env, `SELECT ${columns} FROM ${table} WHERE status='approved' ORDER BY id ASC LIMIT ?`, 500);
        return legacyOk(rows.map((row) => normalizeTopic(row, env, canWatch)), message);
      }
      const total = Number((await one(env, `SELECT COUNT(*) AS c FROM ${table} WHERE status='approved'`)).c) || 0;
      const rows = await all(
        env,
        `SELECT ${columns} FROM ${table} WHERE status='approved' ORDER BY id ASC LIMIT ? OFFSET ?`,
        size, (page - 1) * size
      );
      return legacyOk({
        list: rows.map((row) => normalizeTopic(row, env, canWatch)),
        total,
        page,
        page_size: size
      }, message);
    } catch (error) {
      return legacyFail();
    }
  }

  router.any('/content/get_notices', async (request, env, ctx, args) => {
    const body = args.body || {};
    try {
      const page = clampPage(body.page, 1);
      let size = intOf(body.page_size || body.pageSize || body.limit, 10);
      if (size < 1) size = 10;
      if (size > 20) size = 20;
      // 先认人再查列表: 可见性(定向消息)与 is_read 都要按"当前用户"算, 顺手避免 currentUser 查两遍
      const token = tokenOf(request, body);
      const user = token ? await currentUser(env, request, body) : null;
      const userId = user ? (Number(user.id) || 0) : 0;
      const viewer = noticeViewer(user);
      const now = beijingNow();
      const where = `${NOTICE_ACTIVE_SQL} AND ${NOTICE_VISIBLE_SQL}`;
      const total = Number((await one(env, `SELECT COUNT(*) AS c FROM app_notices WHERE ${where}`, now, now, viewer, viewer, userId)).c) || 0;
      const rows = await all(
        env,
        `SELECT id,title,content,level,link_type,link_value,create_time FROM app_notices WHERE ${where} ORDER BY sort_order ASC, id DESC LIMIT ? OFFSET ?`,
        now, now, viewer, viewer, userId, size, (page - 1) * size
      );
      const list = rows.map((row) => {
        const level = LEVEL_TEXT[row.level] ? row.level : 'info';
        const linkType = row.link_type === 'page' ? 'page' : '';
        return {
          id: row.id,
          title: str(row.title),
          content: str(row.content),
          level,
          level_text: LEVEL_TEXT[level],
          link_type: linkType,
          link_value: linkType === 'page' ? str(row.link_value) : '',
          // 发布时间显示到秒(2.5.9): 改前只有日期(端上看着像"这条公告没写时间")。
          // 库里的 create_time 本来就存的是北京时间字符串, 端上原样显示, **再做时区换算反而会多/少 8 小时**
          published_at: str(row.create_time).replace('T', ' ').slice(0, 19)
        };
      });
      // 有有效 token 时才追加 is_read(旧站行为: 否则键不存在); user 上面已经查过, 这里不再重复查
      if (user && list.length) {
        const marks = list.map(() => '?').join(',');
        const readRows = await all(
          env,
          `SELECT notice_id FROM app_notice_reads WHERE user_id=? AND notice_id IN (${marks})`,
          user.id, ...list.map((item) => item.id)
        );
        const readSet = new Set(readRows.map((row) => Number(row.notice_id)));
        list.forEach((item) => { item.is_read = readSet.has(Number(item.id)); });
      }
      return okMessage({
        list,
        total,
        page,
        page_size: size,
        pageSize: size,
        has_more: (page - 1) * size + list.length < total
      }, '获取通知公告成功');
    } catch (error) {
      // 口径不变(小程序看到的是"成功但空列表"), 但故障必须留痕, 否则线上只会表现为"公告都没了"
      logError('content.notices_query_failed', error);
      return okMessage({ list: [], total: 0, page: 1, page_size: 10, pageSize: 10, has_more: false }, '获取通知公告成功');
    }
  });

  router.any('/content/get_notice_unread', async (request, env, ctx, args) => {
    const body = args.body || {};
    // 旧站口径: 未登录 **不是错误** —— 回 200 + msg"未登录" + 空数据(小程序启动即调, 不该弹错误)
    if (!tokenOf(request, body)) return ok({ unread_count: 0, ids: [] }, '未登录');
    const user = await currentUser(env, request, body);
    if (!user) return fail(401, '登录已过期，请重新登录');
    try {
      // 与 notice_read 共用 unreadNoticeIds: 两处口径必须一致, 否则红点会"消不掉"或"点了还在"
      const ids = await unreadNoticeIds(env, Number(user.id) || 0, noticeViewer(user));
      return ok({ unread_count: ids.length, ids }, '获取未读公告成功');
    } catch (error) {
      logError('content.notice_unread_failed', error);
      return fail(500, '获取未读公告失败，请稍后重试');
    }
  });

  router.any('/content/notice_read', async (request, env, ctx, args) => {
    const body = args.body || {};
    // 旧站文案: 无 token → "未登录"; token 失效 → "登录已过期，请重新登录"
    if (!tokenOf(request, body)) return fail(401, '未登录');
    const user = await currentUser(env, request, body);
    if (!user) return fail(401, '登录已过期，请重新登录');
    const noticeId = intOf(body.notice_id);
    if (!noticeId) return fail(400, '参数有误');
    try {
      await run(
        env,
        'INSERT INTO app_notice_reads (user_id, notice_id, read_at) VALUES (?,?,?) ON CONFLICT(user_id, notice_id) DO NOTHING',
        user.id, noticeId, beijingNow()
      );
    } catch (error) {
      return fail(500, '操作失败，请稍后重试');
    }
    // 未读数按"可见且未读"重算(见 unreadNoticeIds): 改前用"全体公告数 - 我的已读行数",
    // 有了定向公告后会把别人的定向消息算成我的未读, 红点永远消不掉
    try {
      const ids = await unreadNoticeIds(env, Number(user.id) || 0, noticeViewer(user));
      return ok({ notice_id: noticeId, unread_count: ids.length }, '已标记为已读');
    } catch (error) {
      logError('content.notice_read_count_failed', error);
      // 标记本身已写入, 这里只是回不出准确未读数: 不报错, 让小程序先按"0"清红点, 下次进页面会重算
      return ok({ notice_id: noticeId, unread_count: 0 }, '已标记为已读');
    }
  });
}
