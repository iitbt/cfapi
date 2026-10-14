# 狼牙极限运动笔记 · 主后端（cfapi / Cloudflare Workers）

> **版本**：`v2.5.4` —— 唯一维护点在 `main.js` 顶部的 `API_VERSION`。状态页、`/health`、`/apitest`、后台静态资源 `?v=` 都读它；**改了后台样式/脚本后必须升它再部署**（否则浏览器继续用旧文件）。
> **主域名**：**https://lyjx.250036.xyz**（对外 API + `/admin` 管理后台同一域名）。
> **素材域名**：**https://storage.250036.xyz**（R2 公开域，与接口域名分离）。
> **定位**：微信小程序「狼牙极限运动笔记」的**主要后端**。今后小程序的开发、接口变更、联调、发版均以本工程为准；FastAPI 工程（`../fastapi/`）为**备用后端**。
> 内部文档/代码常称本项目为 `api-cf`；当前文件夹名为 `cfapi`，两者指同一工程。

---

## 一、三端关系与定位

| 工程 | 路径 | 角色 | 域名 |
| --- | --- | --- | --- |
| **cfapi（本工程）** | `../cfapi/` | **主要后端**（今后开发基准） | `lyjx.250036.xyz` |
| fastapi | `../fastapi/` | 备用后端（回滚 / 灰度对照） | `api0.250036.xyz`、`api.250036.xyz` |
| xapp | `../xapp/` | 微信小程序前端 | 无独立域名，请求打往上面两条线路 |

- 小程序（`xapp`）默认把请求发往 **线路一 = `lyjx.250036.xyz`（即本工程）**；线路二 `api0.250036.xyz`、线路三 `api.250036.xyz` 指向 FastAPI 旧站，作为回滚/备用（`xapp/utils/constants.js`）。
- 本工程是从 FastAPI（更早是 PHP `api/`）**逐接口迁移**到 Cloudflare Workers 的实现：接口路径、参数、响应结构 `{code,msg,data}`、错误码与文案均与小程序调用兼容。对照证据见 `notes/api-inventory.md`（接口台账）、`notes/structure-map.md`（fastapi↔cfapi 结构对照），以及 `tests/api_contract*`、`tools/diff_api.mjs`（新旧站 JSON 对拍）。
- **迁移进度**：对外 34 条业务接口已全部实现并自测通过；后台 17 个页面已全量迁移。
- **今后约定**：接口变更、联调、发版一律以本工程（cfapi）为准；FastAPI 仅作为备用保留。

---

## 二、项目简介与用途

为「狼牙极限运动笔记」微信小程序提供全部后端能力：

- **对外 JSON 接口**：小程序整包配置、内容（轮播图 / 户外精选 / 摩旅精选 / 通知公告 / 未读）、笔记（列表 / 详情 / 点赞 / 收藏 / 分享 / 留言 / 行为状态）、用户（微信登录 / 资料 / 注销 / 收藏 / 点赞 / 浏览历史）。
- **管理后台 `/admin`**：内容运营（笔记 / 分类 / 轮播 / 专题 / 公告 / 留言）、用户与内部测试管理、配置中心（版本 / 文案 / 我的页菜单）、素材库治理、数据库工具、系统信息。
- **状态 / 探测页**：`/`、`/apitest`、`/health`、`/health/ready`、`/metrics`（最后一项默认关）。

---

## 三、技术栈与运行环境

| 项 | 实际情况 | 依据 |
| --- | --- | --- |
| 运行时 | **Cloudflare Workers**（纯 Worker，非 Pages Functions），无 Web 框架，自研精确匹配路由 `app/core/router.js` | `main.js:110-170` |
| 语言 | JavaScript（ESM，`package.json` `"type":"module"`） | `package.json` |
| 运行时依赖 | **零**；`package.json` 仅有 `devDependencies: wrangler ^4` | `package.json:13-15` |
| 数据存储 | **D1**（Cloudflare SQLite）：绑定 `DB` → 库 `lyjxxapp-d1`（`database_id` 见 `wrangler.toml`） | `wrangler.toml:13-18` |
| 素材存储 | **R2**：绑定 `STORAGE` → 桶 `lyjxxapp-r2`，公开域 `storage.250036.xyz` | `wrangler.toml:22-24` |
| 定时任务 | Cron `17 3 * * *`（每日清理限流计数行） | `wrangler.toml:58-59` |
| 兼容日期 | `compatibility_date = "2026-10-04"` | `wrangler.toml:5` |
| Worker 名 | `lyjxxapp-api` | `wrangler.toml:3` |
| 本地端口 | `8787` | `wrangler.toml:61-62` |
| 区域要求 | D1 / R2 **必须手动建在亚太（Asia Pacific）**；不能靠 wrangler 自动建（会落西欧且不可改） | `DEPLOY.md`「第 2 步 / 第 3 步」 |

> 没有 KV / Durable Objects / Vectorize 绑定。配置注入方式：明文 `[vars]`（部署时写入）+ 密文 Secrets（`ADMIN_SESSION_SECRET` 等）。

---

## 四、代码编写习惯

| 约定 | 说明 |
| --- | --- |
| 全中文注释、写"为什么" | 关键改动带日期 / 问题编号，并说明代价与取舍 |
| 配置单点 | 所有 vars/secrets 的默认值与开关语义集中在 `app/core/config.js` 的 `settings(env)`；新增可配项先在此登记 |
| 响应形态单点 | 5 种响应形态统一在 `app/core/response.js`（`ok`/`okMessage`/`bannersOk`/`legacyOk`/`fail` + `json`/`html`/`text`/`redirect`） |
| 路由单点 | 对外 API 由 `app/core/router.js` 精确路径匹配（Map，支持 GET/HEAD/POST），各 `app/api/*.js` 导出的 `registerXxxRoutes(router)` 在 `main.js` 装配 |
| 后台写入口受控 | 写权限由 `app/admin/lib/entities.js` 四份清单统一口径（`SUPER_ONLY_WRITE_PATHS`/`ROUTE_SUPER_ONLY_WRITE_PATHS`/`NORMAL_WRITE_PATHS`/`EXEMPT_WRITE_PATHS`），未登记写入口一律 403 |
| 后台页面唯一布局 | 后台页面外壳在 `app/admin/lib/layout.js`（对齐旧站 `base.html`），宏/片段唯一实现在 `app/admin/lib/partials.js` |
| 列表页骨架单点 | 后台列表页的取数/分页一律走 `app/admin/lib/listPage.js` 的 `listController`（7 个列表页共用），页面只提供表名/筛选/排序/行渲染 |
| 幂等防重单点 | 后台写操作的防重一律走 `app/admin/lib/utils.js` 的 `onceOrError(ctx, action, parts)`（命中就返回可直接回显的文案），不再各页手拼 `idemKey` + `isDuplicateSubmit` |
| 页面脚本不内联 | 页面脚本一律放 `app/admin/static/js/*.js`，模板里最多注入配置（`window.__xxxCfg`）—— 大段脚本写在模板字符串里会被吃掉反斜杠、被反引号截断（2026-10-10 两次教训） |
| 静态资源内联 | `app/admin/assets/static-assets.js`（自有 css/js 内联，由 `tools/embed_admin_assets.mjs` 打包 `app/admin/static/**` 生成）随代码提交但**不是手改文件**；`static/vendor/`（wangEditor / 图标字体 / bootstrap）**不内联**，从 R2 的 `admin/` 前缀直出（见 `DEPLOY.md` 第 7.5 步） |
| 往返优先（性能） | 线上主要成本是 **D1 往返次数**（一次实测约 240ms，见状态页）：① 互不依赖的查询一律 `Promise.all` 并发发出；② 非关键写库（如浏览量 +1）用 `ctx.waitUntil` 交给后台，不挡响应；③ 几乎不变的配置数据走 `app/core/ttlCache.js` 的 30 秒进程内缓存 |
| 时间口径 | 全站东八区，集中在 `app/core/timeutil.js`（`beijingNow`/`windowStart`/`toEpoch`） |
| 安全 | 日志键名/文本双重脱敏（`app/core/logging.js`），后台审计 `auditLog` |

---

## 五、目录结构

```
cfapi/
├── main.js                  # 入口：中间件装配、路由注册、媒体/R2 直出、异常兜底、定时任务、版本号
├── wrangler.toml            # Worker 绑定（D1/R2/Cron/变量）、兼容日期、本地端口
├── package.json             # scripts（dev/deploy/test/schema/secrets）+ wrangler 开发依赖
├── .dev.vars.example        # 本地明文变量样例（不入库）
├── .secrets.json.example    # 本地密文样例（不入库）
├── DEPLOY.md                # 部署手册（建 D1/R2、建表导数据、配密钥、自定义域）
├── README.md                # 本文件
├── app/
│   ├── api/                 # 对外 JSON 接口（6 个路由文件 + 2 个辅助）
│   ├── admin/               # 管理后台（index/routes/auth + lib/ + pages/ + assets/ + static/）
│   ├── core/                # 平台能力（db/response/router/middleware/storage/ratelimit/...）
│   └── sql/                 # 建表脚本（0001~0006，按序执行）
├── tests/                   # *.test.mjs（node --test，桩模拟 D1/R2）
├── tools/                   # 运维脚本（对拍/冒烟/区域迁移/资源内联/导出）
├── notes/                   # 迁移与运维笔记（api-inventory/structure-map/limits-design/ops-sql）
└── out/                     # 生成物（seed.sql + 拆块 schema/seed，已被 .gitignore 忽略）
```

---

## 六、文件功能说明

### 6.1 顶层

| 文件 | 职责 |
| --- | --- |
| `main.js` | 应用入口：装配中间件与路由、媒体/R2 直出、统一异常兜底、定时任务（`scheduled`）、`API_VERSION` 唯一来源、对外接口与 `/admin` 在此分流 |
| `wrangler.toml` | Worker 绑定（D1 `DB` / R2 `STORAGE` / Cron）、`[vars]` 明文变量、`compatibility_date`、本地 `8787` |
| `package.json` | `scripts`：`dev`/`deploy`/`test`/`schema:local`/`schema:remote`/`schema:notnull`/`schema:testapply`/`secrets:put` |
| `DEPLOY.md` | 部署手册（建 D1/R2 必须亚太、建表导数据、3 个密钥、自定义域、bootstrap 超管） |
| `建议.md` | 全量源码检查的问题清单与建议（专题文档：一次检查的结论，**以代码为准**，不逐条维护"是否已修"） |
| `.dev.vars.example` / `.secrets.json.example` | 本地变量 / 密文样例（不入库） |

### 6.2 `app/api/`（对外接口）

| 文件 | 职责 | 注册路由（节选） |
| --- | --- | --- |
| `app_config.js` | 小程序整包配置 `/config/get_app_config`（分类/首页板块/精选/版本/文案/菜单；表空或异常回退内置常量） | 1 条 |
| `content.js` | 内容下发：轮播图 / 户外 / 摩旅 / 公告 / 未读数 / 标记已读 | 6 条 |
| `news.js` | 笔记：列表 / 详情 / 点赞 / 收藏 / 分享 / 留言 / 评论列表 / 行为状态 / 批量点赞态 | 9 条 |
| `user.js` | 用户：登录 / 资料 / 改资料 / 头像上传 / 注销 / 注销后动作 / 收藏 / 点赞 / 浏览历史 | 9 条 |
| `pages.js` | 静态内容页：`/pages/terms`、`/pages/agreement`、`/pages/privacy`、`/pages/download` | 4 条 |
| `service_status.js` | 状态类：`/`、`/test`、`/index`、`/info`、`/apitest` | 5 条 |
| `helpers.js` | 辅助：token 取值顺序（body→query→Bearer）+ 身份校验 + 鉴权文案（不注册路由） | — |
| `schemas.js` | 辅助：请求参数夹取（`PAGE_MAX`/`MAX_PAGE_SIZE`/`MAX_COMMENT_LENGTH`/批量上限/昵称长度） | — |

> 对外接口合计 **38 条已注册**（俗称「34 条业务接口」= user10+news9+content6+app_config1+service_status5+core health/metrics3；**不含** 4 个 `/pages/*` 静态页）。后台 `/admin/*` 不计入对外 34 条。

### 6.3 `app/core/`（平台能力）

| 文件 | 职责 |
| --- | --- |
| `config.js` | 配置唯一来源 `settings(env)`：汇总所有 vars+secrets 默认值/开关语义 |
| `db.js` | D1 薄封装 `all/one/run` + `intOf/str/idList`；不做 ORM |
| `response.js` | 5 种响应形态 + `json/html/text/redirect` |
| `router.js` | 精确路径路由表 `createRouter`（Map 匹配，GET/HEAD/POST） |
| `middleware.js` | 安全头 / CORS / 预检 / 请求 ID / 请求体 5MB 上限 / 请求体解析 |
| `storage.js` | R2 素材清单 / 占用统计 / 批量删除 / 移动 / 复制 / 路径归一 / 分层列举 |
| `ratelimit.js` | D1 计数表限流（配额 / 登录锁 / 每日清理 SQL），无 Durable Objects |
| `health.js` | `/health`、`/health/ready` 依赖探针 |
| `metrics.js` | `/metrics` 最小 Prometheus 文本（默认关，由 `OBSERVABILITY_ENABLED` 控制） |
| `html.js` | 静态页外壳 `pageShell`/`contentPage` + 服务状态页 `statusPage` |
| `logging.js` | 结构化日志 + 键名/文本双重脱敏 + 后台审计 `auditLog` |
| `md5.js` | 自带 MD5（仅用于生成 `wx_<md5(openid)>` 用户名前缀） |
| `media_scheme.js` | 素材地址拼装 `assetUrl`/`iconAssetUrl`/`putObject` |
| `timeutil.js` | 全站东八区时间口径 |
| `wechat.js` | 微信 `code2session` / `access_token` 缓存（D1）/ 昵称安全送审 |
| `sanitize.js` | 富文本白名单净化 + 图片与视频封面改绝对地址 |
| `overview.js` | 表行数 / 核心计数唯一实现（须排除 D1 内部表，逐表 COUNT） |
| `favicon.js` | 站点图标内联字节（约 65KB 生成物，按需解码直出） |
| `ttlCache.js` | 进程内短 TTL 缓存 `cacheOnce(key, ttlMs, loader)`：只给"几乎不变、却每个请求都要查一次"的配置数据用（分类/首页板块/精选/文案/菜单/轮播图，TTL 30 秒）。跨 isolate 无法主动失效，所以靠 TTL 兜底 —— 后台改完最多 30 秒生效 |

### 6.4 `app/admin/`（管理后台，前缀 `/admin`）

入口与鉴权：

| 文件 | 职责 |
| --- | --- |
| `index.js` | 后台总分发：静态资源（生成物直出，未命中的大件从 R2 取）/ 登录态 / 写权限拦截（含来源校验）/ 页面路由表 `PAGE_ROUTES`；**每笔写请求留一条 `admin.write` 审计**（操作人 + IP/UA + 路径 + 结果） |
| `routes.js` | 控制面板 `dashboardPage`（13 卡+2 趋势+3 最新列表）+ 待迁占位页 `pendingPage` |
| `routes/auth.js` | 登录 / 登出 / 首次初始化（签名 Cookie 会话；未配密钥显示「后台未就绪」） |

`lib/`（支撑库）：

| 文件 | 职责 |
| --- | --- |
| `session.js` | `admin_session` Cookie 的 HMAC-SHA256 签名与会话读写（**无服务端状态但每次回查库**：改密/降权/删号后旧 Cookie 立刻失效；D1 不可用时退回"只信签名"，免得库一抖就把人踢到登录页） |
| `password.js` | 管理员口令 `PBKDF2-SHA256`（10000 轮 —— 实测每万轮约 9.6ms，已接近免费套餐 10ms CPU 上限，不再往上提；改用可选 `ADMIN_PASSWORD_PEPPER` 提升离线爆破成本，并在登录成功后按当前参数自动重哈希升级） |
| `guard.js` | 访问控制常量 + `currentAdmin` + 写请求来源校验 `writeOriginAllowed` |
| `auth-store.js` | `admin_users` 表读写（含按 id 取数与写回新口令哈希） |
| `http.js` | `json` / `redirect` 的**唯一实现**（以前散在十几个页面模块里各写一份） |
| `listPage.js` | 列表页「取数 + 分页」骨架的**唯一实现** `listController`（news/users/comments/banners/notices/topics/admin_users 七个列表页共用，各页只给表名/筛选/排序/行渲染） |
| `nav.js` | 侧栏菜单唯一来源 `NAV_GROUPS` + `migrationProgress()` |
| `entities.js` | 实体注册表 + 后台写权限四份清单 + `classifyWritePath` |
| `catalog.js` | 目录 / 文案 / 菜单常量唯一来源（同旧站 `catalog.py`） |
| `categorySource.js` | 分类真值来源 |
| `controlled.js` | 六张小配置表的 CRUD 工厂 |
| `dbTool.js` | 数据库工具安全内核（白名单表 / 危险语句拒绝 / 分页 / SQL 执行） |
| `homeSections.js` | 首页「三块内容」描述表 |
| `layout.js` | 后台页面外壳（对齐旧站 `base.html`） |
| `mediaUpload.js` | 上传（写 R2，不生成缩略图）+ 素材库列举 |
| `newsContent.js` | 富文本 `<wx-video>`↔`<video>` 转换 + 摘要生成 |
| `partials.js` | 后台页面「宏」唯一实现 |
| `status.js` | 后台「状态切换」注册表 + 行内徽章/启停按钮的唯一渲染入口 `statusCell`/`statusButtons` |
| `utils.js` | 后台通用小工具（分页 / 审计 / 幂等键 + 防重入口 `onceOrError` / `positiveId`；`invalidateEntityCache` 是**预留的空实现** —— 当前接口层没有缓存） |
| `base64url.js` | base64url 编解码 |

`pages/`（17 个后台页面模块，各导出 `routes` 合并进 `PAGE_ROUTES`）：

| 文件 | 职责 |
| --- | --- |
| `adminUsers.js` | 管理员管理（列表 / 新增 / 删除 / 重置口令，仅超管） |
| `appHome.js` | 首页板块管理（已合并原首页精选：main/ext/featured） |
| `appMenu.js` | 我的页菜单：列表 / 编辑 / 删除 / 补齐内置项 |
| `appText.js` | 运营文案：列表(分组筛选) / 编辑 / 删除 |
| `appVersion.js` | 版本更新配置（`app_version_config` 单行 upsert） |
| `banners.js` | 轮播图管理：列表 / 编辑 / 删除 / 复制 |
| `categories.js` | 笔记分类：列表 / 编辑 / 删除影响面确认 |
| `comments.js` | 留言管理：列表 / 通过·拒绝·删除 |
| `dbTools.js` | 数据库管理（表浏览 / 字段总览 / 结构 / 数据编辑 / SQL 执行） |
| `deleteConfirm.js` | 通用删除确认页（先摊开影响面再提交） |
| `media.js` | 素材上传 `POST /admin/image_upload` + 素材库 `GET /admin/media_library` |
| `mediaGovern.js` | 素材库治理（R2 桶资源管理器：浏览/改名/复制/删除/引用检查，仅超管） |
| `news.js` | 笔记管理：列表 / 发布编辑 / 预览 / 软删 / 复制 / 回收站 / 恢复 / 彻底删 |
| `notices.js` | 通知公告：列表 / 编辑 / 删除 |
| `settings.js` | 管理员设置：改自己资料 / 改自己口令 |
| `systemInfo.js` | 系统信息：运行环境 / 表数量 / 记录数 / 素材占用 |
| `topics.js` | 专题精选（摩旅 / 户外）：聚合列表 / 编辑 / 预览 / 删除 |
| `users.js` | 用户管理：列表（可按「仅已申请」筛选，类型列显示「已申请」徽章）/ 详情 / 设内部测试（同时清申请标记，用户撤回也会让徽章消失）/ 恢复 / 删除 |

`static/js/`（页面脚本，全部打包进 `assets/static-assets.js`；引用一律走 `partials.js` 的 `staticScript`，带 `?v=<API_VERSION>`）：

| 文件 | 职责 |
| --- | --- |
| `media_govern.js` | 素材库治理页：上传队列/进度/失败重试跳过 + 批量勾选（常量由页面注入 `window.__mediaGovernCfg`） |
| `db_tools.js` | 数据库管理页：复制、表名本地筛选、单行 JSON/INSERT/UPDATE、SQL 控制台（快捷语句/历史/结果） |
| `news_batch.js` | 笔记管理页：批量勾选与提交 |
| `infinite_scroll.js` | 触底加载 `AdminListLoader`（各列表页共用，由 `pagerScript` 引入） |
| `admin-shell.js` / `status-toggle.js` / `sidebar-groups.js` / `live_time.js` / `image_upload.js` / `media_library.js` | 外壳交互 / 状态就地切换 / 侧栏分组 / 相对时间 / 上传弹窗 / 素材库弹窗 |

### 6.5 `app/sql/`（建表脚本，按序执行）

| 文件 | 职责 |
| --- | --- |
| `0001_schema.sql` | 18 张业务表建表 + 索引（来自旧库真实 DDL；2.4.9 起热点列补 `NOT NULL` 默认值，**只影响新建库**） |
| `0002_rate_limit.sql` | `rate_limit_counters` 限流计数表（新站新增） |
| `0003_wechat_token.sql` | `wechat_tokens` access_token 缓存表（新站新增） |
| `0004_admin.sql` | `admin_users` 管理员账号表（首启 `/admin/bootstrap` 建超管） |
| `0005_drop_redundant_indexes.sql` | 冗余索引清理（幂等；老库与新建库都跑一次） |
| `0006_news_notnull_rebuild.sql` | **老库专用**：重建 news 与三张关联表以收紧约束（会重建表，执行前必须备份，见文件头） |

### 6.6 `tests/` `tools/` `notes/` `out/`

- **`tests/`**：`*.test.mjs`（约 281 条用例，`node --test`，桩模拟 D1/R2），含 `api_contract`/`api_reads`/`api_writes`、`admin_*`、`unit`、`sql_migrations`（用真实 SQLite 跑迁移脚本）、`stub` 等。
- **`tools/`**：`diff_api.mjs`（新旧站 JSON 对拍）、`live_smoke.mjs`（真实数据端到端冒烟）、`cf_region.mjs`（R2/D1 区域迁移）、`embed_admin_assets.mjs`（打包静态资源）、`embed_favicon.mjs`（内联 favicon）、`export_sqlite.py`（旧库导出 seed）、`split_sql.py`（SQL 拆块便于控制台粘贴）、`verify_counts.py`（行数校验）、`media_to_r2.md`（素材搬 R2 说明）。
- **`notes/`**：`api-inventory.md`（对外接口台账）、`structure-map.md`（fastapi↔cfapi 结构与机制对照）、`limits-design.md`（限流方案）、`ops-sql.md`（运营改数 SQL）。
- **`out/`**：**生成物**（已被 `.gitignore` 忽略）：`seed.sql`（全量数据）+ 拆块 `schema/`、`seed/`、`schema-big/`、`seed-big/`，供控制台逐块粘贴建表/导数据。

---

## 七、安装与启动 / 部署

**`package.json` scripts**：

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装 wrangler 开发依赖（仅 devDependency） |
| `npm run dev` | `wrangler dev --local`（本地 8787） |
| `npm test` | `node --test` |
| `npm run schema:local` / `schema:remote` | 依次执行 5 个 `app/sql/*.sql` 建表（`0001`~`0005`，本地 / 远程 D1） |
| `npm run schema:notnull` | **老库专用**：单独执行 `0006_news_notnull_rebuild.sql`（会重建 4 张表，**执行前先备份**，见该文件头）。**故意不并进 `schema:remote`** —— 它重建表，不能在普通部署里顺手带上 |
| `npm run schema:testapply` | **老库专用（2.5.3 起）**：单独执行 `0007_user_test_applied.sql`，给 `users` 加 `test_applied` 列（`ALTER TABLE ADD COLUMN` **不幂等**，只跑一次；新建库已含该列，不用跑） |
| `npm run secrets:put` | `wrangler secret bulk .secrets.json`（推 3 个密文） |
| `npm run deploy` | `wrangler deploy` |

**部署步骤摘要（详见 `DEPLOY.md`）**：

1. **建 D1** `lyjxxapp-d1`：控制台手动建，**Location 选 Asia Pacific**，回填 `database_id` 到 `wrangler.toml`。
2. **建 R2** `lyjxxapp-r2`：手动建、选亚太；开公开域 `storage.250036.xyz`。
3. **建表 + 导数据**：用 `tools/split_sql.py` 拆 `app/sql/*` 与 `out/seed.sql`，在 D1 控制台逐块粘贴；共 21 张表（18 业务 + 限流 + token + admin_users）。
4. **连 Git 部署**：Worker → Connect to Git，Build/Deploy 命令留空或 `npx wrangler deploy`，`[vars]` 与绑定自动生效。
5. **配 3 个密钥**：`WECHAT_APPID` / `WECHAT_SECRET` / `ADMIN_SESSION_SECRET`（控制台加密变量或 `npm run secrets:put`）。
6. **自定义域**：`lyjx.250036.xyz` → 此 Worker（小程序接口 + `/admin`）；`storage.250036.xyz` → R2 公开域。
7. **进后台**：`/admin/bootstrap` 建首个超管（仅 `admin_users` 空时可用），口令 ≥10 位。

> **区域坑**：D1/R2 必须手动建且选亚太；留空 `database_id` 让 wrangler 自动建会落西欧且不可改。
> **本地联调微信**：把 `DEV_WECHAT_MOCK` 设为 `"1"` 即可用任意 `code` 登录。

---

## 八、环境变量 / 配置项

**明文 `[vars]`（`wrangler.toml`，部署时随代码写入；`config.js` 读取）**：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `MEDIA_BASE` | `https://storage.250036.xyz` | 素材对外域名（库里只存相对路径，下发时拼前缀） |
| `DEV_WECHAT_MOCK` | `"0"` | `1`=走本地假微信数据联调；`0`=真调 api.weixin.qq.com |
| `UPLOAD_MAX_BYTES` | `"20971520"` | 头像上传上限 20MB |
| `ENABLE_PUBLIC_PROBE` | `"1"` | `1`=开放 `/apitest` 探测 |
| `OBSERVABILITY_ENABLED` | `"0"` | `1`=开放 `/metrics` |
| `ALLOWED_ORIGINS` | `https://lyjx.250036.xyz` | CORS 白名单（逗号分隔）；留空或 `*` = 放开。同源访问不需要 CORS 头，所以收窄不影响后台与状态页 |
| `ENABLE_SQL_TOOL` | `"0"` | `1`=开放数据库工具 / 素材库管理页；**出厂 0**，要用临时改，用完改回 |
| `SITE_NAME` / `SITE_SHORT` | 狼牙极限运动笔记 / 狼牙极限 | 后台标题 / 登录页 / 图标 alt |
| `WXWORK_WEBHOOK_KEY` | 见 `wrangler.toml` | 企业微信机器人 key：用户提交「申请测试」时给管理员发文本通知。**留空 = 不发**（本地/单测默认空）；只想换群就改这一行，不用动代码 |

**密文 Secrets（`.secrets.json` / `.dev.vars`，不入库）**：

| 密钥 | 含义 |
| --- | --- |
| `WECHAT_APPID` | 小程序 AppID（与 `xapp/project.config.json` 一致：`wxe05d1286861259e7`） |
| `WECHAT_SECRET` | 小程序 AppSecret |
| `ADMIN_SESSION_SECRET` | 后台会话 HMAC 签名密钥（32+ 位随机字符；不配则登录页显示「后台未就绪」，不用默认值放行） |
| `ADMIN_PASSWORD_PEPPER`（可选） | 口令 pepper：配了就与口令拼在一起派生，拿到库也爆不动；**配了之后不能删** —— 删掉后已升级成带 pepper 的账号都验不过，只能到 D1 控制台重置口令 |

> `.gitignore` 已忽略 `.secrets.json`、`.dev.vars`、`out/`、`node_modules/`、`.wrangler/`、`notes/`。

---

## 九、主要接口

### 9.1 对外 API（注册在 `main.js` 的 `router`）

**状态 / 探测类**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| ANY | `/` | 服务状态页（HTML；`?format=json`/AJAX 返回 JSON） |
| ANY | `/test` `/index` `/info` | 重定向到 `/apitest`、`/` |
| ANY | `/apitest` | 连通性探测（`ENABLE_PUBLIC_PROBE=0` 时 404；小程序「检测线路」依赖） |
| GET | `/health` | 存活探针 |
| GET | `/health/ready` | 就绪探针（库或素材不可用时 503） |
| GET | `/metrics` | Prometheus 文本（`OBSERVABILITY_ENABLED` 开才挂） |

**用户类（均 POST）**

| 路径 | 登录 | 用途 |
| --- | --- | --- |
| `/user/login` | 否 | 微信登录，不存在则注册 |
| `/user/get_user_info` | 是 | 取资料 |
| `/user/update_profile` | 是 | 改昵称 / 头像 |
| `/user/upload_avatar` | 是 | 头像上传（multipart，写 R2 `avatar/`） |
| `/user/delete_account` | 是 | 软注销 |
| `/user/deleted_account_action` | 否 | 注销后 `defer`/`restore`/`purge` |
| `/user/user_favorites` | 是 | 收藏列表 / 增删 |
| `/user/user_likes` | 是 | 点赞列表 / 增删 |
| `/user/user_view_history` | 是 | 浏览历史 / 增删 |
| `/user/apply_test` | 是 | 申请 / 撤回内部测试（**2.5.3 起**；2.5.4 补撤回）：`action=apply`（默认）置 `test_applied=1`；`action=cancel` 清 0。两者都通知管理员，身份只认 token |

> **内部测试申请 / 撤回流程（2.5.3 起，撤回 2.5.4 起）**：小程序「我的 → 申请测试」调 `/user/apply_test`：
> - `action=apply`：`users.test_applied` 置 1（条件更新 `WHERE id=? AND test_applied=0`，双击/并发只有一条能成功，重复提交 409；已是内部测试用户也 409）；
> - `action=cancel`：清回 0（条件 `WHERE id=? AND test_applied=1`，没有待处理申请时 409），**不碰 `is_trusted`** —— 内部测试身份仍只能由后台给/收；
> - 两种动作都用企业微信机器人给管理员发一条文本（含昵称、ID、用户名、时间；撤回那条写明"上一条申请通知可忽略"——**机器人消息发出去撤不回**，所以撤回要再提醒一次，否则管理员可能白去点一次「设为内部测试」）。`WXWORK_WEBHOOK_KEY` 没配就跳过，**发送失败只记日志，不影响用户那边的提交/撤回结果**；
> - 管理员在 `/admin/users` 看到「已申请」徽章（下拉可筛「仅已申请」）→ 点【设为内部测试】后 `is_trusted=1`、`test_applied=0`（申请已处理，徽章消失）；用户撤回后徽章同样消失（列表读的就是这一个字段，**不需要额外的删除动作**）；
> - `test_applied` 随 `/user/login`、`/user/get_user_info` 一起下发，小程序据此决定点【申请测试】后弹"申请"还是"撤回申请"（菜单文案不变）。

**笔记类**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/news/list` | 列表（无 `page` 返回数组；已审核、未删除） |
| GET | `/news/detail` | 详情（含作者 / 点赞收藏等状态、浏览量自增、富文本净化；正文图片与视频封面 `poster` 都转绝对地址，供小程序未播放时显示封面） |
| POST | `/news/like` `/news/favorite` | 点赞 / 收藏（带限流，内部测试免审） |
| POST | `/news/share` | 分享计数（可游客） |
| POST | `/news/add_comment` | 留言（≤500 字，内部测试免审） |
| GET | `/news/get_comments` | 评论列表（分页） |
| ANY | `/news/check_user_action` | 行为状态（4 个 bool + 计数）。**身份只认 token**：游客 / 失效 token 一律返回全 `false`，`body.user_id` 被忽略（不再拿客户端传来的 id 查库） |
| POST | `/news/check_user_like_batch` | 批量点赞态（≤200 个）。必带 token（身份由它反查），只需 `news_ids`；旧客户端多传 `user_id` 仍兼容（与 token 用户不一致才 403） |

**内容类（ANY）**：`/content/get_banners`、`/content/get_outdoor`、`/content/get_motorcycle`（户外/摩旅专题分页）、`/content/get_notices`（公告分页，带 `is_read`）、`/content/get_notice_unread`（未读数）、`/content/notice_read`（标记已读）。

**配置类（ANY）**：`/config/get_app_config`（返回 `categories/home_sections/featured/version/texts/menu` + `timestamp`，用 `message` 键）。六块数据彼此无依赖，**并发查库**（耗时 ≈ 最慢的一条，而不是六条之和；失败仍各自回退内置兜底）。

**静态内容页（GET）**：`/pages/terms`、`/pages/agreement`、`/pages/privacy`、`/pages/download`。

### 9.2 管理后台路由（`/admin` 前缀，不计入对外 34 条）

- 入口/鉴权：`/admin/login`、`/admin/logout`、`/admin/bootstrap`、`/admin/dashboard`、`/admin/status_update`（统一状态切换，全后台唯一写接口）。
- 页面（GET）：用户管理 `/admin/users`(+`/users_rows`/`/user_detail`)、管理员 `/admin/admin_users`、笔记 `/admin/news_manage`(+`/news_manage_rows`/`/news_preview`/`/news_edit`/`/news_recycle`)、分类 `/admin/app_category_manage`、公告 `/admin/notice_manage`、留言 `/admin/comments_manage`、版本 `/admin/app_version_edit`、文案 `/admin/app_text_manage`、菜单 `/admin/app_menu_manage`、轮播 `/admin/banner_manage`、首页板块 `/admin/app_home_manage`、专题 `/admin/topics_manage`、设置 `/admin/settings`、系统信息 `/admin/system_info`、数据库管理 `/admin/db_tools`(+`/db_manage`)、素材库 `/admin/media_manage`(+`/media_library`)。
- 写入口权限由 `app/admin/lib/entities.js` 四份清单统一口径；未登记写入口一律 403 并记日志。
- 后台是独立页面（同域名 `/admin` 前缀，HTML SPA + 原生 JS），与小程序前端无耦合；小程序通过微信「服务器域名」白名单访问 `lyjx.250036.xyz`。

---

## 十、与 fastapi 的差异（迁移进度 / 备用用途）

| 维度 | cfapi（本工程，主） | fastapi（备用） |
| --- | --- | --- |
| 技术栈 | Cloudflare Workers + D1 + R2，零运行时依赖 | Python + FastAPI + SQLite/MySQL（双驱动） |
| 域名 | `lyjx.250036.xyz` | `api0.250036.xyz`、`api.250036.xyz` |
| 版本号 | `API_VERSION=2.5.4` | `APP_VERSION=2.5.9`（后端自身版本，独立于小程序 `APP_VERSION=4.4.8`） |
| 接口 | 34 条业务接口已全量实现并自测 | 历史「唯一后端」，接口同构可互切（**缺 `/user/apply_test` 与 `test_applied`**） |
| 后台 | 17 页面（字符串拼 HTML） | 同样 17+ 模块（Jinja2 服务端渲染） |
| 口令哈希 | PBKDF2-SHA256（Workers CPU 限制，不用 bcrypt） | bcrypt |
| 缩略图 | 整体移除（2.4.0 起） | 保留（Pillow 压缩/缩略图） |
| 缓存 | 无进程内缓存（替代旧站 SharedCache）；`lib/utils.js` 的 `invalidateEntityCache` 是**预留入口**（当前什么也不做，将来上 Cache API 只改这一处） | 进程内 memory / 可选 redis |
| 限流 | D1 计数表 + Cron 清理 | 内存桶 + 登录限速 |
| 媒体 | R2（公开域 `storage.250036.xyz`） | 本地目录 `avatar_uploads/`/`news_uploads/` |

**已知实现差异（接口层面已尽量对齐，但实现机制不同）**：

1. 口令哈希 bcrypt → **PBKDF2-SHA256**（Workers 免费套餐 CPU 仅 10ms/请求，bcrypt 会 Error 1102）；迭代数保持 10000 并用可选 pepper 补强度（见 `lib/password.js` 顶部注释）。
2. 缩略图整体移除（接口/前端引用全删）；存量 `_thumb/` 对象清理**待确认**（见 `tools/media_to_r2.md`）。
3. 业务数据无缓存（替代旧站 SharedCache）；2.5.2 起**配置类**数据有 30 秒进程内短 TTL 缓存（`core/ttlCache.js`）；限流改 D1 计数表 + Cron 清理；模板 Jinja2 → 字符串拼 HTML；access_token 缓存改存 D1（`wechat_tokens`）；gzip 交 Cloudflare 边缘。
4. 表行数统计必须排除 D1 内部表（`sqlite_%`/`_cf_%`/`d1_migrations`），且用 `batch()` 逐表 COUNT（旧站一条 `UNION ALL` 在 D1 上会失败）。

**备用用途**：当主后端（本工程）出现异常时，小程序可在「我的 → 线路切换」切到线路二 `api0.250036.xyz`（fastapi）回滚；线路三 `api.250036.xyz` 为备用（指向待确认，见 `xapp` README 第 7.1 节）。

---

## 十一、常见问题与注意事项

1. **D1/R2 区域建错**：必须手动选亚太；wrangler 自动建会落西欧且不可改，只能删库重建。
2. **后台打不开 / 显示「后台未就绪」**：多半是 `ADMIN_SESSION_SECRET` 没配；配了才放行登录。
3. **改了后台样式/脚本不生效**：`app/admin/assets/static-assets.js` 与静态资源带 `?v=<API_VERSION>`，改完必须升 `API_VERSION` 再 `npm run deploy`。
4. **小程序新功能只在主后端体现**：今后接口变更以本工程为准；fastapi 为备用，可能滞后，切到备用线路后如功能缺失属预期。
5. **`api.250036.xyz` 指向待确认**：`xapp` 侧线路三标注「待确认」，以实际 DNS 解析为准。
6. **本地联调微信登录**：设 `DEV_WECHAT_MOCK="1"` 可用任意 code 登录（需本地 dev 环境）。
7. **测试**：`npm test` 跑 `node --test`（桩模拟 D1/R2），不连外网；`tools/live_smoke.mjs` 跑真实数据端到端冒烟。
8. **用户申请（或撤回）内部测试但群里没消息**：先看 `wrangler.toml` 的 `WXWORK_WEBHOOK_KEY` 是否配了（空 = 不发，且不报错）；再按 `user.test_apply_notify_rejected` / `user.test_apply_notify_failed` 日志排查（企业微信失败时 HTTP 仍是 200，错误在 `errcode`，日志带 `kind=apply|cancel`）。**通知发不出去不影响用户那边的结果**，后台照样能看到「已申请」徽章的出现与消失。
9. **老库升级到 2.5.3**：先跑一次 `npm run schema:testapply` 加 `users.test_applied` 列，否则 `/user/apply_test` 与后台用户列表会报 `no such column`。该脚本不幂等，只跑一次。
8. **线上"又慢了"先看状态页的「D1 响应」**：它是一次真实 D1 往返的耗时（基线约 240ms）。接口/页面的耗时 ≈ **串行轮数 × 它**，所以"多了几百毫秒"基本都是多了一轮串行查询，而不是单条 SQL 变慢。
9. **怎么量"串行轮数"**：本地用 `tests/stub.mjs` / `tests/admin_stub.mjs` 的桩，把每条 D1 语句包一层 `await sleep(240)`，再跑一次该页面/接口 —— `耗时 ÷ 240ms` 就是串行轮数（后台全部 GET 路径可从 `app/admin/pages/index.js` 的 `PAGE_ROUTES` 列出来）。2.5.2 的对照：控制面板 7 轮 → 2 轮、`/config/get_app_config` 6 轮 → 1 轮（命中缓存 0 轮）、`/news/list` 3 轮 → 1~2 轮、`/news/detail` 4 轮 → 2 轮。
10. **配置类数据最多 30 秒延迟生效**：分类/首页板块/精选/文案/菜单/轮播图走 `core/ttlCache.js` 的 30 秒进程内缓存（跨 isolate 没法主动失效）。后台改完若在小程序侧没立刻看到，等半分钟或重启小程序再试。
8. **`notes/`、`out/` 已被 `.gitignore` 忽略**：`notes/` 是迁移/运维笔记，`out/` 是生成物，不要手动提交。
