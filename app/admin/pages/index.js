// 后台页面路由汇总: 每个页面模块导出自己的路由, 在这里合成一张表交给 admin/index.js 分发
// 路由形如 { methods: ['GET'], path: '/admin/banner_manage', handler: (ctx) => HTML|Response }
// 权限口径不在这里声明 —— 写在 admin/lib/entities.js 的三份清单里, 分发前统一拦截
import { routes as adminUsersRoutes } from './adminUsers.js';
import { routes as appHomeRoutes } from './appHome.js';
import { routes as appTextRoutes } from './appText.js';
import { routes as appVersionRoutes } from './appVersion.js';
import { routes as bannerRoutes } from './banners.js';
import { routes as categoryRoutes } from './categories.js';
import { routes as commentRoutes } from './comments.js';
import { routes as dbToolsRoutes } from './dbTools.js';
import { routes as deleteConfirmRoutes } from './deleteConfirm.js';
import { routes as mediaGovernRoutes } from './mediaGovern.js';
// 注意: 这里的 media.js 是"后台素材页模块", 与 app/core/media_scheme.js(对外接口的地址拼装) 不是同一个文件
import { routes as mediaRoutes } from './media.js';
import { routes as newsRoutes } from './news.js';
import { routes as noticeRoutes } from './notices.js';
import { routes as settingsRoutes } from './settings.js';
import { routes as systemInfoRoutes } from './systemInfo.js';
import { routes as topicRoutes } from './topics.js';
import { routes as userRoutes } from './users.js';
import { DASHBOARD_PATH } from '../lib/guard.js';
import { dashboardPage } from '../routes.js';

export const PAGE_ROUTES = [
  // 控制面板也放进这张表(2.4.9): 以前它在 index.js 里另有一条分支, 找页面要翻两处
  { methods: ['GET', 'HEAD'], path: DASHBOARD_PATH, handler: dashboardPage },
  ...bannerRoutes,
  ...noticeRoutes,
  ...categoryRoutes,
  // 2.3.8: 首页精选的编辑页已并入 appHome.js, appFeatured.js 整个模块删掉了
  ...appHomeRoutes,
  ...appVersionRoutes,
  ...appTextRoutes,
  ...topicRoutes,
  ...settingsRoutes,
  ...systemInfoRoutes,
  ...userRoutes,
  ...adminUsersRoutes,
  ...newsRoutes,
  ...commentRoutes,
  ...mediaRoutes,
  ...dbToolsRoutes,
  ...mediaGovernRoutes,
  ...deleteConfirmRoutes
];
