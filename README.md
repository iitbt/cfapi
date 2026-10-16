# 狼牙极限运动笔记 · 主后端（cfapi / Cloudflare Workers）

> **版本**：`v2.7.4` —— 唯一维护点在 `main.js` 顶部的 `API_VERSION`。状态页、`/health`、`/apitest`、后台静态资源 `?v=` 都读它；**改了后台样式/脚本后必须升它再部署**（否则浏览器继续用旧文件）。
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
- **管理后台 `/admin`**：内容运营（笔记 / 分类 / 轮播 / 专题 / 公告 / 留言）、用户与内部测试管理、配置中心（版本 / 文案）、素材库治理、数据库工具、系统信息。
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
| 图片兜底单点 | 后台展示素材图的 `<img>` 一律走 `app/admin/lib/partials.js` 的 `imageTag()`（或它的 `IMG_FALLBACK_ATTR`）：加载失败换 `/lucky.jpg`，兜底图自己再失败就收起。兜底图由 Worker 内联字节直出（`app/core/lucky.js`，生成物；路由见 `main.js`），不依赖 R2 里有没有那张对象 |
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
│   └── sql/                 # 建表脚本（0001~0008；0006/0007/0008 属"老库专用"，见 §7.2）
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
| `storage.js` | R2 素材清单 / 占用统计 / 批量删除 / 移动 / 复制 / 路径归一 / 分层列举（`listLevel` 列一层：桶浏览器的每一层与上传卡片的「目标路径」下拉都用它，2.6.6 起下拉只要桶根那一层）/ **引用抽取 `relPathsIn`（引用判定的唯一实现，2.6.5 起按"整段路径"命中）** |
| `ratelimit.js` | D1 计数表限流（配额 / 登录锁 / 每日清理 SQL），无 Durable Objects |
| `health.js` | `/health`、`/health/ready` 依赖探针 |
| `metrics.js` | `/metrics` 最小 Prometheus 文本（默认关，由 `OBSERVABILITY_ENABLED` 控制） |
| `html.js` | 静态页外壳 `pageShell`/`contentPage` + 服务状态页 `statusPage` |
| `logging.js` | 结构化日志 + 键名/文本双重脱敏 + 后台审计 `auditLog` |
| `md5.js` | 自带 MD5（仅用于生成 `wx_<md5(openid)>` 用户名前缀） |
| `media_scheme.js` | 素材地址拼装 `assetUrl`/`iconAssetUrl`/`putObject` |
| `timeutil.js` | 全站东八区时间口径 |
| `notice_targets.js` | 公告「指定用户」收件人列表的**唯一读写实现**（2.6.0）：`targetsMark`（单值/数组/逗号串 → `,7,9,`，去重丢非正整数）/ `targetsList`（存值 → `[7,9]`）/ `targetsLike`（`%,7,%`，供 `LIKE` 判定用）。**两端带逗号**是为了让 `LIKE '%,7,%'` 不会把 17、70 算成收件人；后台编辑页、系统消息写入、小程序可见性判定三处共用这一份 |
| `user_notice.js` | **定向公告（系统消息）唯一写入口** `pushUserNotice(env, userId, {title, content})`：给某个用户发一条只他可见的公告（落库为 `receiver_type=3` + `target_user_ids=,<uid>,`，与后台「接收人=指定用户」同一套语义）。**2.6.0 起每次动作都新建一条**（不再覆盖旧的）：用户回头能看到"什么时候被设过 / 取消过"。失败只记日志不抛 —— 公告只是通知，不能把管理员刚做完的身份变更报成失败 |
| `wechat.js` | 微信 `code2session` / `access_token` 缓存（D1）/ 昵称安全送审 |
| `sanitize.js` | 富文本白名单净化 + 图片与视频封面改绝对地址 |
| `overview.js` | 表行数 / 核心计数唯一实现（须排除 D1 内部表，逐表 COUNT） |
| `favicon.js` | 站点图标内联字节（约 65KB 生成物，按需解码直出 `/favicon.ico`） |
| `lucky.js` | 后台图片兜底图内联字节（约 9KB 生成物，按需解码直出 `/lucky.jpg`；两处都由 `tools/embed_favicon.mjs` 生成） |
| `ttlCache.js` | 进程内短 TTL 缓存 `cacheOnce(key, ttlMs, loader)`：只给"几乎不变、却每个请求都要查一次"的配置数据用（分类/首页板块/精选/文案/菜单/轮播图，TTL 30 秒）。跨 isolate 无法主动失效，所以靠 TTL 兜底 —— 后台改完最多 30 秒生效 |

### 6.4 `app/admin/`（管理后台，前缀 `/admin`）

入口与鉴权：

| 文件 | 职责 |
| --- | --- |
| `index.js` | 后台总分发：静态资源（生成物直出，未命中的大件从 R2 取）/ 登录态 / 写权限拦截（含来源校验）/ 页面路由表 `PAGE_ROUTES`；**每笔写请求留一条 `admin.write` 审计**（操作人 + IP/UA + 路径 + 结果） |
| `routes.js` | 控制面板 `dashboardPage`（**2.7.0 精简为 5 卡 + 3 最新列表**（两张 7 日趋势卡连同它们的取数与 `sparkline` 一并删除）：用户 / 近 7 日新增 / 笔记（含已显示·待审核）/ 留言（含待审核）/ 互动；版本、服务器时间、依赖状态、表数量、存储占用等在「系统信息」与对外状态页已有，这里不再重复）+ 待迁占位页 `pendingPage` |
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
| `catalog.js` | 文案分组 / 内置文案 key / 版本默认值常量唯一来源（同旧站 `catalog.py`） |
| `categorySource.js` | 分类真值来源 |
| `dbTool.js` | 数据库工具安全内核（白名单表 / 危险语句拒绝 / 分页 / SQL 执行） |
| `homeSections.js` | 首页「三块内容」描述表 |
| `layout.js` | 后台页面外壳（对齐旧站 `base.html`） |
| `mediaUpload.js` | 上传（写 R2，不生成缩略图）+ 素材库列举 |
| `newsContent.js` | 富文本 `<wx-video>`↔`<video>` 转换 + 摘要生成 |
| `partials.js` | 后台页面「宏」唯一实现；**后台图片兜底唯一实现**（`imageTag()` / `IMG_FALLBACK_ATTR` / `IMAGE_FALLBACK_SRC`，失败换 `/lucky.jpg`） |
| `status.js` | 后台「状态切换」注册表 + 行内徽章/启停按钮的唯一渲染入口 `statusCell`/`statusButtons` |
| `utils.js` | 后台通用小工具（分页 / 审计 / 幂等键 + 防重入口 `onceOrError` / `positiveId`；`invalidateEntityCache` 是**预留的空实现** —— 当前接口层没有缓存） |
| `base64url.js` | base64url 编解码 |

`pages/`（17 个后台页面模块，各导出 `routes` 合并进 `PAGE_ROUTES`）：

| 文件 | 职责 |
| --- | --- |
| `adminUsers.js` | 管理员管理（列表 / 新增 / 删除 / 重置口令，仅超管） |
| `appHome.js` | 首页板块管理（已合并原首页精选：main/ext/featured） |
| `appText.js` | 运营文案：列表(分组筛选) / 编辑 / 删除 |
| `appVersion.js` | 版本更新配置（`app_version_config` 单行 upsert） |
| `banners.js` | 轮播图管理：列表 / 编辑 / 删除 / 复制 |
| `categories.js` | 笔记分类：列表 / 编辑 / 删除影响面确认 |
| `comments.js` | 留言管理：列表 / 通过·拒绝·删除 |
| `dbTools.js` | 数据库管理（表浏览 / 字段总览 / 结构 / 数据编辑 / SQL 执行） |
| `deleteConfirm.js` | 通用删除确认页（先摊开影响面再提交） |
| `media.js` | 素材上传 `POST /admin/image_upload` + 素材库 `GET /admin/media_library`（**2.7.1 起逐层浏览**：可选 `prefix`/`q`/`page`，返回 `rows`(渲染好的行 HTML)/`folders`/`prefix`/`page`/`totalPages`/`hasMore`/`total`/`levelCount`/`truncated`/`base`/`accept`；只带 `kind` 的老调用照旧可用。取数/过滤/排序/分页与行结构都在 `lib/mediaBrowse.js`，与素材库治理页同一份；**2.7.3 起目录口径也逐字一致**：不再过滤站内自有目录，`folders` 与治理页根层完全相同；**2.7.4 起多一个可选 `scope=dir|all`**（缺省 `dir`，老调用不受影响）—— `all` = 忽略 `prefix` 扫整个桶（上限 3000 个对象，**必须带 `q`**，否则回落成 `dir`），返回体多 `scope`/`scanned`，全盘时 `folders` 为空、行里的名字是**完整相对路径**） |
| `mediaGovern.js` | 素材库治理（R2 桶资源管理器：浏览/改名/复制/删除/引用检查，仅超管）。**目录按钮 2.6.5 起跟着当前位置动态一层**（常态 =「存储桶根目录」+ 根下子目录，进了子目录就换成它的子目录；原固定的 `image/`/`video/`/`news_uploads/` 按钮并入这一层），**上传卡片的「目标路径」下拉 2.6.6 起只列桶根下的一级子目录**（2.6.5 曾扫全桶把各级目录都列出来，选项太长所以收回），**2.6.7 起与「存储桶根目录」后面那排按钮逐字一致**（站在根目录直接复用本页 `browseQuery` 的根层数据，不再另扫一份、不再多一层"站内自有目录不进"的过滤），更深的目录用「其它（手动填写）」写。**2.6.8 起上传卡片改两处**：命名默认值从「自动生成」变成「保留原名」（重名顺延 `_1`/`_2`，「自动生成」仍是可选项），并新增一份可滚动的**待上传清单**（缩略图/图标 + 相对路径 + 大小/类型/状态，可按单个文件或整个文件夹移除） |
| `news.js` | 笔记管理：列表 / 发布编辑 / 预览 / 软删 / 复制 / 回收站 / 恢复 / 彻底删 |
| `notices.js` | 通知公告：列表（可按接收人筛选 + **多选批量删除**，2.6.1）/ 编辑 / 删除。**接收人四档**（所有用户 / 内部测试用户 / 普通用户 / 指定用户）仅超管可改；选「指定用户」时用 `name=action value=search_user` 的普通提交按钮重画本页来搜人、用每位后面的「移除」按钮摘掉收件人（都不引入弹窗与接口），**2.6.0 起可一次指定多位**（同名多值 `target_user_id`，由 `app/admin/index.js` 的 `readForm` 拼成逗号串），非超管提交时保留库里的原接收人 |
| `settings.js` | 管理员设置：改自己资料 / 改自己口令 |
| `systemInfo.js` | 系统信息：运行环境 / 表数量 / 记录数 / 素材占用 |
| `topics.js` | 专题精选（摩旅 / 户外）：聚合列表 / **合并后的编辑页**（2.7.0：`/admin/topics_edit?topic=motorcycle\|outdoor`，一份表单 + 顶部项目单选）/ 预览 / 删除 |
| `users.js` | 用户管理：列表（可按「仅已申请」筛选，类型列显示「已申请」徽章）/ 详情 / 设内部测试（同时清申请标记）/ 恢复 / 删除。**用户可自助撤回**：待审批撤回=徽章消失，已通过后撤回=「类型」列回到「普通 微信」，管理员无需清理。**设/取消内部测试后自动给本人发一条定向公告**（「内部测试申请已通过」/「内部测试已取消」，走 `core/user_notice.js`）—— 用户在小程序「通知公告」页与公告红点处收到 |

`static/js/`（页面脚本，全部打包进 `assets/static-assets.js`；引用一律走 `partials.js` 的 `staticScript`，带 `?v=<API_VERSION>`）：

| 文件 | 职责 |
| --- | --- |
| `media_govern.js` | 素材库治理页：上传队列/进度/失败重试跳过 + 批量勾选（常量由页面注入 `window.__mediaGovernCfg`） |
| `db_tools.js` | 数据库管理页：复制、表名本地筛选、单行 JSON/INSERT/UPDATE、SQL 控制台（快捷语句/历史/结果） |
| `news_batch.js` | 笔记管理页：批量勾选与提交 |
| `infinite_scroll.js` | 触底加载 `AdminListLoader`（各列表页共用，由 `pagerScript` 引入） |
| `admin-shell.js` / `status-toggle.js` / `sidebar-groups.js` / `live_time.js` / `image_upload.js` / `media_library.js` | 外壳交互 / 状态就地切换 / 侧栏分组 / 相对时间 / 上传弹窗 / 素材库弹窗（2.7.1 起逐层浏览 + 触底加载：路径与子目录按钮 + 表格，滚到底取下一页；2.7.3 起路径单斜杠拼接、【上一级】与路径同一行且排在末尾、根目录不显示按钮；2.7.4 起搜索行多「本目录 / 全盘」范围下拉、按钮从「刷新」正名成「搜索」） |

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

- **`tests/`**：`*.test.mjs`（约 300 条用例，`node --test`，桩模拟 D1/R2），含 `api_contract`/`api_reads`/`api_writes`、`admin_*`、`unit`、`sql_migrations` 与 `notice_visibility`（后两个用真实 SQLite）、`stub` 等。
  - `notice_visibility`（2.5.9 起）用**真实 SQLite**顶掉 D1 后走真接口，验证公告接收人四档："谁能看到哪条 / 未读数对得上 / 已读互不影响 / 游客只看得到「所有用户」"（2.6.0 起含"一条公告发给两位"的逗号列表）。为什么要真库：桩只能证明"SQL 长什么样"（`api_reads` 里那条断言），证明不了口径在真 SQL 上确实是这个结果 —— 例如 `?` 占位符顺序错位在桩里看不出来。
  - `frontend_notice_reddot`（2.5.8 起；4.5.3 起多一条"同一身份的资料刷新不许把红点抹掉 / 换账号必须归零"，4.5.4 起多一条"前台每 30 秒轮询公告、切后台必须停"）是**跨端守卫**：用桩顶掉 `getApp/wx/Page` 后直接 require 小程序的 `pages/profile/profile.js` 与 `subpackages/content/notices/notices.js`，真跑一遍"红点每次强制取服务端未读数 / 状态翻转才重渲染 / 已读补丁回写秒开缓存"。本机没有 `../xapp`（只部署后端）时自动跳过，也可用 `LYXJ_DIR=<xapp 路径>` 指定。
  - `frontend_test_content`（4.5.7 起）同样是跨端守卫，管**测试内容可见性**：真跑一遍"户外/摩旅的秒开缓存 + 服务端回包"（断言 `video_url` 真的进了渲染层、非内部测试时仍不整表 `setData`）、`trustedUser` 的判据（服务端 `can_watch_video` 优先 / 没有才回退本地身份 / 值没变不 `setData`）以及详情页回包按 `can_watch_video` 落 `isTrusted`。挡的就是"服务端已下发视频、端上却因为列表指纹漏掉 `video_url` 或本地身份镜像是旧的就把它藏起来"。
- **`tools/`**：`diff_api.mjs`（新旧站 JSON 对拍）、`live_smoke.mjs`（真实数据端到端冒烟）、`cf_region.mjs`（R2/D1 区域迁移）、`embed_admin_assets.mjs`（打包静态资源）、`embed_favicon.mjs`（内联 favicon 与后台兜底图 lucky.jpg → `core/favicon.js` / `core/lucky.js`）、`export_sqlite.py`（旧库导出 seed）、`split_sql.py`（SQL 拆块便于控制台粘贴）、`verify_counts.py`（行数校验）、`media_to_r2.md`（素材搬 R2 说明）。
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
| `npm run schema:noticetarget` | **老库专用（2.5.7 起）**：单独执行 `0008_notice_target.sql`，给 `app_notices` 加 `target_user_id` 列（定向公告用；同样 **不幂等**，只跑一次；新建库已含该列，不用跑） |
| `npm run schema:noticereceiver` | **老库专用（2.5.9 起）**：单独执行 `0009_notice_receiver.sql`，给 `app_notices` 加 `receiver_type` 并把历史定向行回填成 `3`（`ALTER TABLE ADD COLUMN` **不幂等**，只跑一次；新建库已含该列，不用跑）。**漏跑的两条后果**：① 公告接口与后台公告页报 `no such column: receiver_type`；② 不做那步回填，2.5.7 起发的定向消息（`target_user_id` 非空）会按默认值 `0` 当成「所有用户」**全员可见**（私信变广播） |
| `npm run schema:noticetargets` | **老库专用（2.6.0 起）**：单独执行 `0010_notice_targets.sql`，给 `app_notices` 加 `target_user_ids`（逗号列表）并把老的单值列 `target_user_id` 折进去（同样 **不幂等**，只跑一次；新建库已含该列，不用跑）。**漏跑的后果**：公告列表/未读接口与后台公告页统一报 `no such column: target_user_ids`（公告功能整体不可用）；即使接口没碰, 不折数据也会让 2.5.7 起发的定向消息与后台发过的定向公告变成"没有收件人"—— 静默丢消息 |
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
| `/user/apply_test` | 是 | 申请 / 撤回内部测试（**2.5.3 起**；2.5.4 补撤回、2.5.5 补"已通过后退回"）：`action=apply`（默认）置 `test_applied=1`；`action=cancel` 撤回。两者都通知管理员，身份只认 token |

> **内部测试申请 / 撤回流程（2.5.3 起；撤回 2.5.4；已通过后退回 2.5.5）**：小程序「我的 → 申请测试」调 `/user/apply_test`：
> - `action=apply`：`users.test_applied` 置 1（条件更新 `WHERE id=? AND test_applied=0`，双击/并发只有一条能成功，重复提交 409；已是内部测试用户也 409）；
> - `action=cancel` 按当前身份分两种语义（都由服务端判定，端上不多带参数）：
>   - **待审批**：清 `test_applied=0`（条件 `WHERE id=? AND test_applied=1`，没有待处理申请 409）—— 之后可以重新申请；
>   - **已通过**：连 `is_trusted` 一起退回 0（条件 `WHERE id=? AND is_trusted=1`）—— 即"用户主动放弃内部测试身份"，立即失去专题视频 / 留言免审 / 仅内部测试可见的菜单；返回体为 `{test_applied:0, is_trusted:0}`，端上据此把图标从 `test_a.png` 换回 `test.png`；
> - 三种事件都用企业微信机器人给管理员发一条文本（含昵称、ID、用户名、时间；撤回类写明"上一条申请通知可忽略"，已通过后退回再注明"已放弃内部测试身份"——**机器人消息发出去撤不回**，所以撤回要再提醒一次，否则管理员可能白去点一次「设为内部测试」）。`WXWORK_WEBHOOK_KEY` 没配就跳过，**发送失败只记日志，不影响用户那边的申请/撤回结果**；
> - 管理员在 `/admin/users` 看到「已申请」徽章（下拉可筛「仅已申请」）→ 点【设为内部测试】后 `is_trusted=1`、`test_applied=0`（申请已处理，徽章消失）；用户撤回后徽章同样消失、已通过后退回则「类型」列从「内部测试 微信」回到「普通 微信」（列表读的就是这两个字段，**管理员不需要做任何清理动作**）；
> - `test_applied` 与 `is_trusted` 随 `/user/login`、`/user/get_user_info` 一起下发，小程序据此决定点【申请测试】后弹哪一条、显示哪张图标（菜单文案不变）。
> - **测试内容可见性由服务端下发（2.6.3）**：三条路径都带同一个判据 —— 专题接口（`/content/get_outdoor`、`/content/get_motorcycle`）逐条给 `video_url`（非内部测试**直接删掉该键**）与 `can_watch_video`；`/news/detail` 整条给 `can_watch_video`（正文视频与留言区共用）。端上只渲染服务端给的内容，不再按本地身份镜像二次判断 —— 那样会在"后台刚设/刚取消内部测试、端上还停在旧资料"时把已经下发的视频藏起来（依据：2.5.6 的结论是身份不缓存、重新拉资料即可拿到最新值）。
> - **身份状态不缓存（2.5.6 复核）**：`/user/get_user_info` 每次都按 token 直查 `users` 表（`app/api/helpers.js::userByToken`，`SELECT * FROM users WHERE token=?`，无内存/KV/CDN 缓存层），所以管理员在后台改完 `is_trusted` 后，端上只要重新拉一次资料就能拿到最新身份 —— **不需要刷新接口、不需要额外状态字段**。2.5.6 本身没有接口改动（仅版本号对齐 + 本条说明）；若日后给用户资料加服务端缓存，必须同时提供失效手段，否则端上会出现"重进/下拉也拉不到新身份"。
> - **定向公告：管理员设/取消内部测试 → 本人收到一条系统消息（2.5.7）**：不新增接口、也不新增表 —— 复用 `app_notices`，用收件人列表（`receiver_type=3` + `target_user_ids=,<uid>,`）表示"只发给这个用户"。管理员点【设为内部测试】/【取消内部测试】后，后端经 `app/core/user_notice.js::pushUserNotice` 插入一条（级别 fixed `important`，标题「内部测试申请已通过」/「内部测试已取消」），用户在小程序「通知公告」页看到它，并在「我的」页公告菜单亮红点。要点：
>   - **可见性与未读口径收窄**：`/content/get_notices`、`/content/get_notice_unread`、`/content/notice_read` 三条路径统一按同一份口径过滤（2.5.7 时是 `target_user_id IS NULL OR target_user_id = 当前用户`，未登录按游客 `0` 算只看全体公告；**2.5.9 起换成下面那条 `receiver_type` 四档 OR 查询**，语义向后兼容）。改造前 `notice_read` 回的是"全体公告数 − 我的已读行数"，引入定向公告后那个减法会把**别人的**定向消息算成我的未读，红点永远消不掉 —— 2.5.7 起 `get_notice_unread` 与 `notice_read` 共用同一份口径 `unreadNoticeIds()`。
>   - **每次新建，不再覆盖（2.6.0）**：2.5.7~2.5.9 是"同一用户只保留最新一条"（先删旧的那条 + 它的已读行，再插新的），代价是"设为 → 取消 → 再设为"来回操作后只剩最后一条，用户看不到中间发生过什么，也无从回溯是谁在什么时候改过他的身份。现在每次动作都插一条（已读仍按"用户 + 公告"逐条记，靠 `app_notice_reads` 的唯一索引，所以新消息不会顶掉旧消息的已读、也不会把别的未读一起清掉），代价是历史消息会累积在公告页里 —— 这是需求要的取舍。
>   - **发消息失败不回滚身份变更**：写公告的语句走一次 `batch`，失败只记 `notice.push_user_notice_failed` 日志。
>   - **老库升级（2.5.7 / 2.6.0）**：老库要**依次**跑 `npm run schema:noticetarget`（加 `target_user_id`）→ `npm run schema:noticetargets`（加 `target_user_ids` 并把老的单值折进新列）。**2.6.0 的代码只认新列**，只跑前者会报 `no such column: target_user_ids`。
>   - **小程序侧（4.5.1）**：`app.js` 的公告"秒开"缓存原先**不按身份区分**，定向消息是私有内容，退出/换账号/掉线时已改为清空该缓存（`clearNoticeCache`），否则上一个账号的系统消息会显示给下一个人。
>   - **红点为什么"不立即亮"（2.5.8 复核：后端无需配合）**：定向通知与普通公告**同表同接口**（都落在 `app_notices`，都走 `/content/get_notice_unread` 的 `unreadNoticeIds` 口径），所以未读统计**天然涵盖**这两条内部测试通知 —— 本版**没有接口/行为改动**（2.5.8 仅版本号对齐 + 本条结论）。不生效的原因全在端上：`app.fetchNoticeUnread` 有 30 秒内存缓存，而「我的」页 onShow 与下拉刷新都没强制取最新值（修法见 `../xapp/README.md` 7.12）。修完后红点的亮灭只由这一个服务端数字决定：`unread_count > 0` 亮、`= 0` 灭，公告页条目红点读的是同一份服务端状态（列表里的 `is_read`），两处不再各判一套。
>
>   排查入口：`POST /content/get_notice_unread`（带 token）→ `{unread_count, ids}`。它**就是**端上红点的唯一来源；`ids` 里能直接看到定向消息的 id（未登录恒为 `{0, []}`）。
>
> - **公告接收人：一条公告可以只发给某几类人（2.5.9 起，2.6.0 起「指定用户」可多选）**：`app_notices` 新增 `receiver_type`（`0`=所有用户 / `1`=内部测试用户 / `2`=普通用户 / `3`=指定用户），默认 `0` —— **与历史数据同义**，所以老公告的行为一字不变；`3` 档的收件人存在 `target_user_ids`（**逗号列表**，两端带逗号，如 `,7,9,`，写法与读法见 `core/notice_targets.js`；2.6.0 之前的单值列 `target_user_id` 已由 0010 折进来、新代码不再读写）。后台公告编辑页由超管选择（值定义在 `pages/notices.js` 的 `RECEIVERS`，列表页多一列「接收人」并可按它筛选）。要点：
>   - **一条 OR 查询判完四档**（`app/api/content.js` 的 `NOTICE_VISIBLE_SQL`）：`receiver_type=0 OR (receiver_type=1 AND ?=1) OR (receiver_type=2 AND ?=0) OR (receiver_type=3 AND target_user_ids LIKE ?)`。第三个占位符是 `targetsLike(uid)` 给出的 `%,7,%`，**不是裸 id** —— 写成 `LIKE '%7%'` 会把 17、70 也算成收件人，而 `target_user_ids = ?` 又只能匹配"只有他一个人"的公告。占位符顺序是「观看者档位 ×2，然后收件人参数据 ×1」，排在生效区间（`start_at`/`end_at`）之后。
>   - **观看者档位**（`noticeViewer()`）：已登录且 `is_trusted=1` → `1`；已登录普通用户 → `0`；**游客 → `-1`**（两个"按用户类型"的分支都命中不了 → 游客只看得到 `receiver_type=0` 的公告，未登录行为与改造前完全一致）。定向消息（`3`）与游客无关。
>   - **为什么不拆成"先查接收人类型再查列表"**：公告是运营内容、总量极小，一条 OR 能保证**列表 / 计数 / 未读**三处口径逐字一致 —— 少一处就会出现"列表里有这条、红点却数不着"这种只能靠用户反馈才发现的问题。
>   - **2.5.7 的定向系统消息并入同一列**：`pushUserNotice` 插入时固定 `receiver_type=3` + `target_user_ids=,<uid>,`。2.6.0 起不再有"删旧消息"这一步（改为每次新建），那条"删旧定向消息（连同已读行）"的语句随之消失 —— 系统消息与"管理员手动指定的定向公告"从此只是同一列里的两条记录，不会再互相删。
>   - **非超管编辑公告**：接收人字段只读，且提交时保留库里的原值 —— 否则普通管理员改一次标题就把定向公告重置成"所有用户"（等于把私信发给了所有人）。收件人那两条校验（"必须至少选一位"/"最多 200 位"）也只对超管生效：非超管页面上根本没有这个控件，拿库里的脏数据把他拦住是说不通的。
>   - **指定用户怎么选（2.5.9 起，2.6.0 起可多选）**：候选用户是**一组同名复选框**（`name=target_user_id`），勾几位就提交几个同名值 —— `app/admin/index.js` 的 `readForm` 把同名多值按提交顺序拼成逗号串（全站只有这一处用多值字段，唯一 name 的页面拿到的东西一字不变）。已选清单里每人后面一个「移除」按钮（`name=remove_user_id`），搜索框配一个「搜索用户」按钮（`name=action value=search_user`）；三个都是普通提交按钮、都只带当前草稿重画本页，**不引入弹窗、不加 AJAX 接口、不加静态资源**。三个必须记住的细节：① **接收人类型不能用下拉框, 4 个 radio 也不许套容器** —— 「指定用户」那一段的显隐靠纯 CSS（`#noticeReceiver3:checked ~ .notice-picker`，见 `admin.css`）：`select` 的选中项命中不了 CSS 兄弟选择器，把 radio 包进 `.form-check` 之类容器又会隔一层，两种写法都会让那条 `~` 命不中（2.6.1 修的正是后者）；② **CSS 只是"看不见"**，隐藏起来的收件人控件照样会随表单提交，所以"类型不是指定用户时收件人一律清空"由后端在 `receiver_type≠3` 时忽略提交值来保证（不依赖前端"不提交"）；③ 已选但**不在当前候选列表**里的用户（刚搜了别的关键词）会用隐藏域一起提交，否则"搜一次人"就会让他们悄悄掉出收件人。一次最多指定 200 位（`MAX_TARGETS`）—— 收件人存成逗号串，没上限的话一条公告能把这列撑到几百 KB。公告只记 `users.id`，不会把 openid 写进公告或下发到小程序。
>   - **「指定用户」控件显示不出来（2.6.1 修复，根因在 DOM 层级）**：2.6.0 把 4 个接收人 radio 各包进一个 `<div class="form-check">`，而「指定用户」那一段的显隐靠 `#noticeReceiver3:checked ~ .notice-picker` —— `~` 只认**同一父元素下的后续兄弟**，隔了一层就永远命不中，于是 `.notice-picker` 恒为 `display:none`：选「指定用户」什么都不出现。修法是让 radio/label **平铺**成 `.notice-picker` 的前兄弟（并在 `admin.css` 里抵消 bootstrap 给 `.form-check-input` 的 `float / margin-left`，那两条是给容器留位置用的）。为什么不用 `:has()` 或几行 JS：前者要求浏览器支持、后者违反本页"零新增 JS"，平铺是全浏览器都成立的最小改动。守卫在 `tests/admin_pages_content.test.mjs`：用一个小函数数"起点到终点之间 `<div` 与 `</div>` 的差"来断言四个 radio 与 `.notice-picker` **同级** —— **只断言 CSS 规则文本存在是没用的**（2.6.0 那条规则就在，功能却是坏的）。
>   - **多选批量删除（2.6.1）**：列表首列是全选复选框、每行一个勾选框，勾完点「删除所选」→ `static/js/news_batch.js` 把选中 id 拼进隐藏域 `ids` → POST `/admin/notice_batch_delete`。**与笔记页共用同一份脚本**（同一套 id：`batchForm`/`batchIds`/`rowCheck`/`rowCheckAll`），文案单位由表单的 `data-unit` 决定（笔记页不传 = "笔记"，公告页传 "公告"），所以确认框会正确显示"确定删除选中的 N 条公告？"。服务端走 `purgeNotices(env, ids)`（**单条删除与批量删除共用的唯一实现**，以前单条删除会留下孤儿已读行）：一次 `DB.batch` 发两条，先 `DELETE FROM app_notice_reads WHERE notice_id IN (...)` 再 `DELETE FROM app_notices WHERE id IN (...)` —— **顺序不能反**（公告一删就再也查不出该清哪些 notice_id，留下的孤儿行会让将来同 id 的新公告"没读却已读"；`app_notice_reads` 没有外键，数据库不会替你拦）。勾了之后被别人删掉的 id 会被跳过并在提示里报数（`已删除 N 条公告，另有 M 条已不存在已跳过`），不做静默的部分成功；一次上限 `BATCH_MAX = 200`。删完按当时的筛选与页码回列表（`keyword`/`status`/`receiver`/`page` 随表单带回）。权限与单条删除同档（`entities.js` 的 `NORMAL_WRITE_PATHS`：登录即可，不额外限超管），审计动作 `admin.app_notice.batch_delete`，缓存失效走 `invalidateEntityCache('notice')`。触底加载出来的行同样带勾选框（列表页与 `/admin/notice_rows` 片段共用 `renderRows`），所以 `pagerScript` 要传 `rowMarker: 'rowCheck'`。
>   - **`published_at` 给到秒**：`/content/get_notices` 由"只到日期"改为 `create_time` 的前 19 位（端上原样显示）。库里的字符串本来就是业务时区，**不要再做一次时区换算**（会多/少 8 小时）。
>   - **索引：故意不新增**。公告是运营内容（几十条量级），现有 `idx_app_notices_active (status, sort_order, id)` 已经吃掉 `status=1` 这一段，再为 `receiver_type` / `target_user_ids` 单独建索引只会给每次后台发布加写入代价，收益是零；真涨到几千条再补也不迟（`ALTER TABLE ADD COLUMN` 本身只改元数据、O(1)，0009 / 0010 里真正的写操作只有那两条回填 `UPDATE`）。
>   - **页面停着不动也要收到公告（2.5.10 复核：后端无需配合）**：原先只有"进页面 onShow / 下拉刷新"才调 `fetchNotices`，所以停在首页或「我的」页不动时，刚发的公告要退出重进才出现 —— 这是端上的调用时机问题，本版**没有接口/行为改动**（2.5.10 仅版本号对齐 + 本条结论 + 守卫落档）。修法见 `../xapp/README.md` 7.14：端上前台每 30 秒调一次 `fetchNotices`（它自带 60 秒静默刷新节流，所以真实请求仍是每 60 秒一次），内容真变了才由 `_emitNoticesUpdated` 通知首页公告条与我的页红点；后端这条读接口本来就是"可反复调的轻量 GET"，不需要任何配合。
>   - **自检覆盖**：`tests/notice_visibility.test.mjs` 用**真实 SQLite** 跑一遍四档（谁能看到哪条 / 未读数/红点对得上 / 已读互不影响 / 游客只看得到「所有用户」），其中 4 号公告的收件人是 `,7,9,` —— 顺便证明 `LIKE '%,9,%'` 能命中列表里的**第二位**（只测单值的话，SQL 写成 `=` 也看不出来）。`tests/api_reads.test.mjs` 另盯住三处复用的 SQL 形状与占位符顺序（收件人那条必须是 `LIKE ?` 且参数据是 `%,7,%`）；`tests/admin_pages_content.test.mjs` 覆盖"勾两位就存 `,7,9,`""类型改回所有用户时收件人必须清空"；`tests/sql_migrations.test.mjs` 在真 SQLite 上验证 0010 的折数与 `NOT NULL DEFAULT ''`；`tests/admin_submit_action.test.mjs` 钉住那条 CSS 显隐规则、平铺 radio 的两个补偿类、批量脚本的 `data-unit` 与三处生成物同步；`tests/admin_pages_content.test.mjs` 另用"数 div 开闭"的小函数断言四个 radio 与 `.notice-picker` 同级（2.6.1 起）。
>   - **老库升级（2.5.9 / 2.6.0）**：依次跑 `npm run schema:noticereceiver`（加 `receiver_type` + 回填历史定向行为 `3`）、`npm run schema:noticetargets`（加 `target_user_ids` + 把老的单值折进去），漏跑的后果见第七节命令表。

**笔记类**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/news/list` | 列表（无 `page` 返回数组；已审核、未删除） |
| GET | `/news/detail` | 详情（含作者 / 点赞收藏等状态、浏览量自增、富文本净化；正文图片与视频封面 `poster` 都转绝对地址，供小程序未播放时显示封面）。**2.6.3 起**响应体带 `can_watch_video`（当前访客是否内部测试用户；与专题接口同名字段）—— 正文视频与留言区的可见性由它判定，端上不再拿"只在「我的」页刷新的本地身份镜像"去猜 |
| POST | `/news/like` `/news/favorite` | 点赞 / 收藏（带限流，内部测试免审） |
| POST | `/news/share` | 分享计数（可游客） |
| POST | `/news/add_comment` | 留言（≤500 字，内部测试免审） |
| GET | `/news/get_comments` | 评论列表（分页） |
| ANY | `/news/check_user_action` | 行为状态（4 个 bool + 计数）。**身份只认 token**：游客 / 失效 token 一律返回全 `false`，`body.user_id` 被忽略（不再拿客户端传来的 id 查库） |
| POST | `/news/check_user_like_batch` | 批量点赞态（≤200 个）。必带 token（身份由它反查），只需 `news_ids`；旧客户端多传 `user_id` 仍兼容（与 token 用户不一致才 403） |

**内容类（ANY）**：`/content/get_banners`、`/content/get_outdoor`、`/content/get_motorcycle`（户外/摩旅专题分页）、`/content/get_notices`（公告分页，带 `is_read`；**按 token 与 `receiver_type` 四档过滤可见范围**，`published_at` 到秒）、`/content/get_notice_unread`（未读数；口径同上）、`/content/notice_read`（标记已读，回包里的 `unread_count` 与未读数接口同口径）。

**配置类（ANY）**：`/config/get_app_config`（返回 `categories/home_sections/featured/version/texts` + `timestamp`，用 `message` 键；**不再返回 `menu`**，2.6.2 起「我的页菜单」写死在小程序 `xapp/app.js` 的 `APP_MENU`）。五块数据彼此无依赖，**并发查库**（耗时 ≈ 最慢的一条，而不是五条之和；失败仍各自回退内置兜底）。

**静态内容页（GET）**：`/pages/terms`、`/pages/agreement`、`/pages/privacy`、`/pages/download`。

### 9.2 管理后台路由（`/admin` 前缀，不计入对外 34 条）

- 入口/鉴权：`/admin/login`、`/admin/logout`、`/admin/bootstrap`、`/admin/dashboard`、`/admin/status_update`（统一状态切换，全后台唯一写接口）。
- 页面（GET）：用户管理 `/admin/users`(+`/users_rows`/`/user_detail`)、管理员 `/admin/admin_users`、笔记 `/admin/news_manage`(+`/news_manage_rows`/`/news_preview`/`/news_edit`/`/news_recycle`)、分类 `/admin/app_category_manage`、公告 `/admin/notice_manage`(+`/notice_rows`/`/notice_edit`)、留言 `/admin/comments_manage`、版本 `/admin/app_version_edit`、文案 `/admin/app_text_manage`、轮播 `/admin/banner_manage`、首页板块 `/admin/app_home_manage`、专题 `/admin/topics_manage`(+`/topics_edit`/`/topics_manage_rows`)、设置 `/admin/settings`、系统信息 `/admin/system_info`、数据库管理 `/admin/db_tools`(+`/db_manage`)、素材库 `/admin/media_manage`(+`/media_library`)。
- 写入口权限由 `app/admin/lib/entities.js` 四份清单统一口径；未登记写入口一律 403 并记日志。
- 后台是独立页面（同域名 `/admin` 前缀，HTML SPA + 原生 JS），与小程序前端无耦合；小程序通过微信「服务器域名」白名单访问 `lyjx.250036.xyz`。

---

## 十、与 fastapi 的差异（迁移进度 / 备用用途）

| 维度 | cfapi（本工程，主） | fastapi（备用） |
| --- | --- | --- |
| 技术栈 | Cloudflare Workers + D1 + R2，零运行时依赖 | Python + FastAPI + SQLite/MySQL（双驱动） |
| 域名 | `lyjx.250036.xyz` | `api0.250036.xyz`、`api.250036.xyz` |
| 版本号 | `API_VERSION=2.7.4` | `APP_VERSION=2.5.9`（后端自身版本，独立于小程序 `APP_VERSION=4.5.4`） |
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
10. **老库升级到 2.5.7 / 2.6.0**：依次跑 `npm run schema:noticetarget`（加 `app_notices.target_user_id`）、`npm run schema:noticetargets`（加 `target_user_ids` 并把老的单值折进去），否则公告接口（`/content/get_notices` 等）会报 `no such column: target_user_id` / `no such column: target_user_ids`。两个脚本都不幂等，各只跑一次。
11. **用户说"设了内部测试但小程序里没收到消息"**：先看公告页是否拉到那一页（定向消息也占一条，排在 `sort_order` 相同的公告之前）、再看「我的」页公告红点；后端侧按 `notice.push_user_notice_failed` 日志排查，并确认老库已跑 `schema:noticetarget`。**发消息失败不影响身份变更本身**（列表里的「内部测试」徽章照样会出现）。
12. **用户说"红点不亮 / 亮了不消失"**：先确认端上版本 —— 小程序 **≤4.5.1** 进「我的」页会吃 `fetchNoticeUnread` 的 30 秒内存缓存（管理员刚改完的这段时间里红点不动），**4.5.2 起**改为每次 onShow / 下拉刷新都强制取最新值；**4.5.3 起**修掉剩余竞态（`updateLoginStatus` 原先无条件把未读数清零，资料刷新回包后到会把刚亮起的红点抹掉，清零现在只在换人/首次登录时做）；**4.5.4 起**页面停着不动也会收到新公告（端上前台每 30 秒轮询一次，见 `../xapp/README.md` 7.14）。后端侧只需确认 `POST /content/get_notice_unread` 返回的 `unread_count` 正确：它同时统计**全体公告 + 只发给本人的定向通知**，`> 0` 红点亮、`= 0` 灭。
13. **用户说"已在后台设成内部测试，但户外/摩旅没有视频、笔记里没有留言区"**：2.6.3 起视频可见性与留言区可见性都由服务端下发（专题接口删/留 `video_url`、`/news/detail` 给 `can_watch_video`），所以先按身份核对 `GET /user/get_user_info` 的 `is_trusted`（应为 1）；若接口已是对的，那就是端上仍是旧版本（**4.5.7 起**才不再按本地身份镜像二次判断，也不再因为列表指纹漏掉 `video_url` 而跳过整表刷新），让用户更新小程序并重新进入页面即可。列表侧的守卫见 `tests/frontend_test_content.test.mjs`。
14. **用户说"进「我的」页就报 is not a function"（4.5.8 真踩过）**：那是小程序端把「我的页菜单」从 `app.js` 搬到 `pages/profile/profile.js` 时漏搬了被引用的成员（本后端无改动，菜单本来就不由服务端下发）。修法：更新小程序到 **4.5.8**；端上守卫 `tests/frontend_notice_reddot.test.mjs` 的「我的页菜单(4.5.8)」用例会逐个断言这些成员存在并真跑一次 `loadMenuItems()`。2.6.4 仅版本号对齐（无接口改动，与 2.5.8 的先例相同）。
15. **素材库把"没被引用的文件"标成"被引用"（2.6.5 修）**：根目录素材原先按**子串**判命中 —— 字段里写着 `image/food/2017-2018.jpg` 时，根目录的 `2018.jpg` 因为"是它的后缀"被算成引用。现在 `core/storage.js::relPathsIn` 只认**整段路径相等**（片段剥离协议/主机/`?`/`#` 后比对，另加一条"左右必须是分隔符"的边界匹配，兼容名字里带空格）。判定来源始终只有这一处：列表列 / 「查看引用」/ 详情 / 删除与改名前的复查都走 `scanReferences`。回归守卫：`tests/unit.test.mjs`「引用判定(2.6.5)」+ `tests/admin_pages_tools.test.mjs`「引用判定(2.6.5)」（把 `relPathsIn` 换回 `text.includes(name)`，两条用例立刻失败）。
16. **上传时"目标路径"选不到想要的目录 / 手填报"必须以 image/ 开头"（2.6.5 修）**：① 可选项原先只取**当前浏览层**的子目录（站在 `image/food/` 连 `image/` 的兄弟目录都选不到），2.6.5 改成逐层扫全桶（各级目录全列出来，选项太长），**2.6.6 定为只列桶根下的一级子目录**，2.6.7 起与「存储桶根目录」后面那排按钮**逐字一致**（原先下拉另扫一份、还多一层"站内自有目录不进"的过滤，于是少几个目录 = "显示不全"；现在站内自有目录 `avatar/`、`avatar_uploads/`、`images/` 也照列，见第 17 条）；② 那句拦截来自 `lib/mediaUpload.js::safeTargetDir`（2.4.3 的"只允许本入口素材根之下"，理由是跨目录写进去素材库列不出来）与前端 `static/js/media_govern.js::dirProblem` 的同一口径 —— 但 2.4.4 已经允许写到**存储桶最外层**，这条前缀限制自相矛盾，2.6.5 起 `root` 只当默认值，任何"干净的相对目录"都收，**仍拦** `..`（穿越）、绝对路径、`//`、空段、单点、特殊字符与超长。代价照旧写在校验函数的注释里：写进素材库不扫的目录（如把图片写进 `video/`）时，那些对象在素材库列表与素材选择器里列不出来（公开域直读不受影响）。**本轮没有动任何接口与字段**（`target_dir` 仍是那个字段，只是取值放宽）；守卫：`tests/unit.test.mjs`「目标路径校验(2.6.5)」、`tests/admin_pages_tools.test.mjs`「目标路径可选项」「上传接口(2.6.5)」「存储桶目录按钮(2.6.5)」。
17. **目标路径下拉只列一层、且与桶页那排按钮一致（2.6.6 / 2.6.7）**：① 2.6.5 用 `core/storage.js::listAllDirs` 逐层扫全桶，每个目录一次 R2 子请求（上限 `MAX_DIR_SCAN = 30`），把各级目录都塞进下拉 —— 选项太长、子请求也白花，2.6.6 改为 `listLevel(env, '')` 只列桶根那一层，`listAllDirs` 与 `MAX_DIR_SCAN` 一并删除。② 但 2.6.6 的下拉仍是"**另扫一份** + 多一层过滤（站内自有目录不进下拉）"：桶页那排按钮来自 `browseQuery(ctx)` 的 `data.folders`，下拉来自另一次 `listLevel`，两处口径不同 → 下拉少几个目录（2.6.7 报的就是这个"一级子目录显示不全"）。③ 2.6.7 统一成一份数据：`listPage` 站在根目录**直接复用 `data`**（零额外列举），站在子目录才补一次**同参数**（`{ limit: LEVEL_MAX }`）的 `listLevel`，并删掉那层额外过滤 —— 两处永远同源同参，集合逐字相等（含 `avatar/`、`avatar_uploads/`、`images/`）。要归档到更深层就选「其它（手动填写）」：手填校验沿用 2.6.5 口径（只拦 `..`/绝对路径/`//`/空段/特殊字符/超长），多深都收。下拉的候选目录**与当前浏览位置无关**（站在 `image/` 里看到的仍是桶根那一层）。守卫：`tests/admin_pages_tools.test.mjs`「目标路径可选项」—— 把桶页那排 `?prefix=` 按钮的目录集合与两条下拉的 option 集合做 `deepEqual`（逐字一致才算过），再逐个目录真上传一遍；2.6.5 的多层级目录（`image/素材/`）必须**不再**出现。
18. **上传命名默认值与待上传清单（2.6.8）**：① 命名默认值从「自动生成（`<用途>_时间戳.ext`）」改成「**保留原名**」—— 用户不操作时文件名原样落库；「自动生成」仍是可选项（切过去才换文件名，两种模式都保留文件夹结构）。② 重名规则在 `app/admin/lib/mediaUpload.js`：待写 key = 目标目录 + 相对路径目录 + 文件名，写前 `head` 探测，已存在就顺延 `_1`、`_2`…（`MAX_KEY_TRIES` 次封顶，扩展名不变、**绝不覆盖**）；**计数按完整 key（含目录）算，所以不同子目录里的同名文件互不影响**（`相册一/图.png` 与 `相册二/图.png` 各自独立，只有同一目录内重名才顺延）。③ 选完文件/文件夹后，上传卡片多一份可滚动的「待上传清单」：图片出本地缩略图（`URL.createObjectURL`，移除/清空时 `revokeObjectURL`），视频出图标；每行 = 相对路径 + 大小 + 类型 + 状态（等待/上传中/成功/失败），失败行仍带重试/跳过；可按单个文件「移除」，也可按**选中的那层文件夹**「移除整个文件夹」—— 与进度条共用同一个队列。**已成功与正在上传的不可移除**（对象已落/请求已发），移除待传文件会同步从总量里扣掉体积。④ 体积文案改成自适应 B/KB/MB（原先一律按 MB，几十 KB 的文件全是 `0.0 MB`，看不出大小）。本轮只动后台的页面/脚本/样式：接口、字段、上传规则、目标路径与进度条机制都没变（`purpose`/`rel_path`/`target_dir` 照旧）。守卫：`tests/admin_pages_config.test.mjs`（默认 `value="keep" checked`、「自动生成」不再勾选、清单容器、`createObjectURL`/`revokeObjectURL`、`移除`/`移除整个文件夹`、四态文案、CSS 生成物同步）与 `tests/unit.test.mjs`（重名顺延 `_1`、不同子目录独立计数）。

19. **控制面板精简与「后台图片兜底」（2.6.9）**：① 控制面板卡片 14 → 5：保留 总用户数（含今日新增与较昨日）、近 7 日新增用户（含较上期）、笔记（总数 + 已显示/待审核 并进同一张卡）、留言（总数 + 待审核）、互动（点赞/收藏）；删掉的 轮播图 / 摩旅精选 / 户外精选（各自管理页的统计条里就能看到）、管理页面（后台已全部迁完，侧栏本身就是入口清单）、以及分散的「待审核笔记/待审核留言」两张卡（并进主卡，仍然带 `text-warning` 高亮）；同时把统计 SQL 里那三张表的 COUNT 一并去掉（少读几行）。版本 / 服务器时间 / 依赖状态 / 表数量 / 记录总数 / 存储占用这些口径在「系统信息」页与对外状态页已有，控制面板不再重复。2 张趋势卡与 3 个最新列表（注册用户 / 笔记 / 留言，各自带「查看全部」）保持不变 —— 列表那一行同时承担"常用入口"的作用。② 图片兜底：`admin/news_preview`、`admin/news_manage`（含回收站）、`admin/banner_manage`、`admin/app_home_manage`（列表封面 + 编辑页的封面预览）、`admin/topics_manage`（列表 + 详情）这几处的 `<img>` 一律改走 `app/admin/lib/partials.js` 的 `imageTag()`（或挂同一份 `IMG_FALLBACK_ATTR`）：**加载失败就换成 `app/lucky.jpg`**，兜底图自己再失败才 `visibility:hidden` 收起（用 `this.src.indexOf('/lucky.jpg')` 判断，不会无限触发 error）。原先是各页各写一套（`visibility:hidden` / `display:none` / `classList.add('d-none')` 三种写法），现在换兜底图只改一处。预览页正文里的配图在 `pages/news.js` 里"改绝对地址"的同一步注入兜底 —— 注入点必须在 `sanitizeHtml` 之后，否则会被清洗掉。首页三块内容的列表封面在 `lib/homeSections.js` 的 `previewCell`（先前漏了这一处，是 2.6.9 里唯一没接上的调用点）。③ 兜底图的托管方式（与 favicon 同一手法）：仓库文件 `app/lucky.jpg` → `node tools/embed_favicon.mjs` 生成 `app/core/lucky.js`（base64 内联 + ETag + `?v=` 指纹，当前 6657 字节）→ `main.js` 在根路径 `/lucky.jpg` 直出（不走 R2、不受 `MEDIA_BASE` 影响、未登录也能取；`?v=` 只用于破缓存，路由按 pathname 匹配）。换图流程见 `DEPLOY.md`「第 10.5 步」。④ 正文编辑器（`static/js/news_editor.js`）同一口径：编辑区里的图片也挂兜底（地址由 `pages/news.js` 经 `#contentEditor` 的 `data-img-fallback` 下发同一份 `IMAGE_FALLBACK_SRC`；编辑中新粘进来的图片由既有的 MutationObserver 补挂，Slate 重画后重挂），同时把正文图片的显示地址从"站点根路径"改成**媒体域绝对地址**（`data-media-base` 下发 `mediaBase`，与后端 `assetUrl` 同口径）：站内目录两种写法都能取到，但"上传到存储桶最外层"的素材（2.4.4 起允许）只有媒体域能取 —— 原先在编辑区里是 404 裂图（小程序与预览页正常，因为那两处本就走 `assetUrl`）。提交前 `toStoredHtml` 把媒体域地址还原成库内相对值（编辑期临时改成兜底图的 DOM 不影响入库值：`getHtml()` 读的是编辑器模型）。⑤ 未覆盖的地方：头像（`users.js`/`notices.js`）与素材库缩略图（`mediaGovern.js`）仍保持"加载失败就隐藏" —— 这两处的槽位比例是给头像/原图的，塞一张 447×252 的兜底图会更奇怪；要一起改再说。守卫：`tests/api_reads.test.mjs`（`/lucky.jpg` 直出字节与类型）、`tests/admin_pages_config.test.mjs`（六个页面逐张数 `img`，必须张张带兜底）、`tests/admin_pages_system.test.mjs`（5 张卡、删掉的卡片按 `<div class="lbl">` 标记断言、统计 SQL 不再查那三张表）。

20. **控制面板去掉 7 日趋势、专题两个编辑页合并（2.7.0）**：① 控制面板删掉「近 7 日新增用户趋势」「近 7 日笔记发布趋势」两张折线卡，连同它们的取数与渲染实现（`routes.js` 里的 `trend()`、每次一发的 `substr(...) GROUP BY d`、以及 `sparkline()`）一并删除，面板只剩 5 张数字卡 + 3 个最新列表；一次并发请求从 6 条降到 4 条。② `admin/motorcycle_edit` 与 `admin/outdoor_edit` 合并成一个 **`/admin/topics_edit?topic=motorcycle|outdoor`**（沿用列表页那个 `?topic=` 参数）：共用 标题 / 简介 / 封面图 URL / 视频地址 / 状态，各自独有 摩旅（骑行里程·计划时长·难度）与 户外（活动日期·活动地点），字段集仍由 `CONFIGS[kind].extraFields` 驱动 —— 换项目 = 换一份独有字段 + 换一张表（服务端重新渲染，不做前端隐显）。顶部项目单选沿用列表页那套标签条（`partials.filterButtons`；2.7.0 给它加了可选的 `hrefFor(值)`，因为这一处每一项要带**各自**的记录 id），位置在**标题字段上方**（`editShell` 的 `top`）。编辑态切到另一种项目 = 改为"新增"（两张表的 id 不是一回事），页面上有一行提示；表单 `action` 同时带 `topic` 与 `id`，所以 POST 与 GET 认的是同一个项目，**项目名缺失/非法时直接给报错页、绝不回落到摩旅表**（"默认摩旅"的回落只留给行片段/预览/删除的旧路径）。旧的 `motorcycle_edit`/`outdoor_edit` 路由与 `entities.js` 里那两条写路径登记都已删除（`/admin/motorcycle_edit` 现在落到统一 404 页 —— 编辑页没有做 302，POST 过不了重定向）。③ 编辑页的【封面图 URL】与【视频地址】从左右两栏改成上下两行；封面预览从固定 288×162（16:9 裁剪）改成**居中 + 通栏 + 按原比率缩放**（`app/admin/static/css/admin.css` 的 `.cover-preview`，全后台共用这一份）。无接口、字段与 schema 变更，端上（`xapp/`）无需改动。守卫：`tests/admin_pages_system.test.mjs`（面板仍有 5 卡 + 3 个列表，`sparkline` 与 `substr(...) GROUP BY d` 都不再出现）、`tests/admin_pages_config.test.mjs`（合并页的项目单选 / 字段集 / 上下排版 / 各写各表 / 非法 topic 不写库）、`tests/admin_sidebar_menus.test.mjs`（两个旧编辑路由与写路径登记已删、只剩 `/admin/topics_edit`）、`tests/admin_submit_action.test.mjs`（`.cover-preview` 新样式）。

21. **素材库弹窗"部分图片列不出来"与缩略图裂图（2.7.1）**：① 旧弹窗走 `core/storage.js::listNewsMedia` 一次扫全桶（根目录树 + `image/` + `news_uploads/`），撞到 `MAX_SCAN_OBJECTS`(1000) 就**静默截断**（界面还写着"最多显示 500 个"）—— 桶里素材一多就只列出一部分，且把图片传进 `video/` 这类"素材库不扫的目录"的对象永远列不到（上传卡片的「目标路径」本来就允许，见第 16 条）。② 缩略图拼的是**站点根路径** `/<key>`，而 Worker 只直出 `image/`、`video/`、`news_uploads/` 三个前缀，根目录素材与 `images/` 下的对象一律 404 裂图。现在弹窗改成与素材库治理页**同一套取数**（`lib/mediaBrowse.js::browseLevel`）：一次只列**当前这一层**（前缀 + `delimiter /`），类型/关键词/排序/分页都在本层内做，翻页由弹窗里的触底加载取下一页（每页 30 条，哨兵在弹窗自己的滚动区里，不复用 `AdminListLoader` —— 它按 `location.search` 拼参数，弹窗的目录/关键词在内存里）；面包屑与子目录按钮跟着当前位置换一层，行由服务端渲染（`pages/media.js::pickRows`，预览地址一律按**媒体公开域**拼，`base` 随接口下发）。单层确实超过 1000 个时不再假装列全：状态行直接说明"只列了前一批，用关键词或进子目录缩小范围"（`truncated`）。站内自有目录（`avatar/`、`avatar_uploads/`、`images/`）在选择器里整棵子树都不给，手填 `prefix` 也绕不进去（`hideInternal`）。接口向后兼容：只带 `kind` 的老调用照旧返回第一层。手工填路径、`input`/`editor` 两种插入模式与分类锁定（「图片素材库」/「视频素材库」）都没变。守卫：`tests/admin_pages_users_news.test.mjs`「素材库: 逐层浏览」、`tests/admin_pages_tools.test.mjs`「存储桶(2.4.6)」里的选择器断言（按 `rows`/`folders` 断言）。这一条里"站内自有目录整棵子树都不给"的过滤已被**第 23 条推翻** —— 2.7.3 起选择器与治理页的目录口径逐字一致。

22. **治理页「上一级」点了停在原地（2.7.2 修）**：`lib/mediaBrowse.js::parentOf` 原先直接找入参最后一个 `/` 的位置 —— 面包屑与详情页把**带尾斜杠**的目录前缀（`image/`、`素材/子/`）交给它时，切点正好落在最后那个斜杠上，`parentOf('image/')` 返回 `image/` **自身**，于是「上一级」链回当前页，点了没反应。现在先剥掉尾斜杠再取父级：`image/` → 空串（存储桶根）、`素材/子/` → `素材/`；对象键不受影响（`image/a.png` → `image/`，改名页的「目标目录」与详情页的「所在层」照旧）。根目录本来就**不渲染**这个按钮（面包屑只到「存储桶」），所以不存在"根目录点上一级"的入口。这一轮同时把状态页那条长期红的用例收干净：`tests/api_reads.test.mjs` 的状态页断言里，「进程启动时间」整块早已从页面删除、「使用说明」也已改名成「常用接口」—— 两条失效断言都去掉（改成断言现状），`app/api/service_status.js` 里没人消费的 `isolateStartedAt` / `startedAt` / `startedAtNote` 一并删除（`statusPage` 早就没读它们）。守卫：`tests/unit.test.mjs`「上一级 parentOf(2.7.2)」（一级 / 多级 / 中文 / 根目录 + 两种对象键）、`tests/admin_pages_tools.test.mjs`「存储桶(2.4.6)」把「上一级」按钮的 href 断言到具体前缀 —— 只断言文案存在拦不住这个缺陷（原用例就是这么漏的）。

23. **素材库选择器的文件夹显示不全 + 路径双斜杠与「上一级」位置（2.7.3）**：两个根因。① **两处口径不一致**：选择器走 `browseLevel(..., { hideInternal: true })`，比治理页多一层"站内自有目录"过滤 —— 根层少列 `avatar/`、`avatar_uploads/`、`images/` 三个目录（与 2.6.7「一级子目录显示不全」同一类毛病：同一个桶、两处各带一层过滤）。现在 `hideInternal` 连同 `blocked`、`isInternalKey` 一起删掉，选择器的目录清单与治理页**逐字一致**：桶里有什么列什么，站内自有目录也能进去浏览（它们仍然只是"不算素材"，`listNewsMedia` 那套口径没动）。② **列举被截断**：R2 单次 `list` 的 `limit` 是"对象 + 目录"的**合计**配额，根下对象多时目录排在字典序后面会被整批截掉，只看第一页就永远列不全。现在 `listLevel` 遇 `truncated` 时按 `cursor` 继续翻页（最多 3 页）**只为把子目录收全**；对象仍只取第一页、`truncated` 仍按第一页算，所以"本层文件太多、只列了前一批"的提示语义不变。前端顺带修掉弹窗路径的**双斜杠**（原先每段自带尾斜杠、段间又插了一个分隔符 → `存储桶/admin//vendor//fonts/`），并把【上一级】从目录按钮排挪到路径末尾、与路径**同一行**：`存储桶/admin/vendor/fonts/`+【上一级】；根目录只显示「存储桶」、不显示按钮。守卫：`tests/unit.test.mjs`「单层列举(2.7.3)」（1000 个根下对象把三个目录挤到第二页 → 目录必须收全）、`tests/admin_pages_users_news.test.mjs`「素材库: 逐层浏览」（`admin/vendor/fonts/` 逐层列全 + 根层含 avatar/）、`tests/admin_pages_tools.test.mjs`「存储桶(2.4.6)」（选择器根层目录与治理页逐字一致、站内自有目录也能浏览）、`tests/admin_submit_action.test.mjs`「素材库弹窗(2.7.3)」（`new Function` 真跑 `media_library.js`，断言路径单斜杠与【上一级】的位置/目标前缀）。测试桩 `tests/admin_stub.mjs` 的 R2 `list` 同步按真语义实现（码元序 + 合计配额 + `cursor`），否则这类缺陷测不出来。

24. **素材库选择器的搜索范围与「搜索」按钮（2.7.4）**：① 原先关键词只在**当前这一层**过滤（`browseLevel` 拿的是 `listLevel` 的本层对象），站在根目录搜"封面"永远搜不到 `image/` 里的。现在搜索行多一个范围下拉：`scope=dir`（默认，行为与改前逐字相同）/ `scope=all`（忽略当前目录、扫整个桶）。全盘走的是**前缀扫描**而不是逐层遍历：`core/storage.js::scanObjects` 不带 `delimiter`、按 `cursor` 一页页读对象（每 1000 个一次 R2 子请求），上限 `SCAN_MAX=3000` 个对象（3 页）；逐层遍历是每层一次子请求，目录一多就撞 Worker 的子请求上限、面板明显变慢。到上限仍未扫完时接口回 `truncated`，状态行直接写"只扫了前 3000 个对象, 结果可能不全"，不假装搜全了。为免"把桶倒出来"，`scope=all` **必须带关键词**：服务端没关键词就回落成 `dir`（前端也先拦一道，一个请求都不发，只提示"先输入关键词"）。全盘结果里每行的名字是**完整相对路径**（跨目录同名文件否则分不清是哪张）、目录导航（上一级/子目录）在这时隐藏，面包屑仍显示"你从哪进来的"。过滤/排序/分页仍走 `browseLevel` 里同一段代码，两种范围零分叉；接口向后兼容（不传 `scope` 就是 `dir`，返回体只多 `scope`/`scanned`）。② 按钮从「刷新」改名「**搜索**」：它唯一的动作就是把当前的关键词/范围/目录提交查一次（`mediaFetch(1,false)`），**不会**重新列举目录 —— 叫"刷新"会让人以为"重读整个目录"；而全站搜索条的按钮约定就是 `<i class="bi bi-search"></i> 搜索`（`lib/partials.js::searchBar`），改名后图标与文案跟它一致。交互不变：点击、输入框回车、点输入框的「×」清空、切换范围（新增）走的都是同一个 `mediaFetch(1, false)`。**两个面板（图片/视频）本来就是同一个弹窗**（`partials.js::mediaLibraryModal` + `static/js/media_library.js` 各只有一份），所以范围与按钮天然一致，没有第二套实现。守卫：`tests/unit.test.mjs`「全盘扫描(2.7.4)」、`tests/admin_pages_users_news.test.mjs`「素材库: 逐层浏览」（同一关键词在两种范围下命中数不同、全盘带完整路径、无关键词回落）、`tests/admin_submit_action.test.mjs`「素材库弹窗(2.7.4)」（真跑脚本：默认 `scope=dir`、全盘无关键词不发请求、填关键词后带 `scope=all`、全盘时目录导航不画）。

8. **线上"又慢了"先看状态页的「D1 响应」**：它是一次真实 D1 往返的耗时（基线约 240ms）。接口/页面的耗时 ≈ **串行轮数 × 它**，所以"多了几百毫秒"基本都是多了一轮串行查询，而不是单条 SQL 变慢。
9. **怎么量"串行轮数"**：本地用 `tests/stub.mjs` / `tests/admin_stub.mjs` 的桩，把每条 D1 语句包一层 `await sleep(240)`，再跑一次该页面/接口 —— `耗时 ÷ 240ms` 就是串行轮数（后台全部 GET 路径可从 `app/admin/pages/index.js` 的 `PAGE_ROUTES` 列出来）。2.5.2 的对照：控制面板 7 轮 → 2 轮、`/config/get_app_config` 6 轮 → 1 轮（命中缓存 0 轮）、`/news/list` 3 轮 → 1~2 轮、`/news/detail` 4 轮 → 2 轮。
10. **配置类数据最多 30 秒延迟生效**：分类/首页板块/精选/文案/菜单/轮播图走 `core/ttlCache.js` 的 30 秒进程内缓存（跨 isolate 没法主动失效）。后台改完若在小程序侧没立刻看到，等半分钟或重启小程序再试。
8. **`notes/`、`out/` 已被 `.gitignore` 忽略**：`notes/` 是迁移/运维笔记，`out/` 是生成物，不要手动提交。
13. **老库升级到 2.5.9 / 2.6.0**：按顺序跑 `npm run schema:noticereceiver`（给 `app_notices` 加 `receiver_type` 并回填历史定向行）→ `npm run schema:noticetargets`（加 `target_user_ids` 并把老的单值列折进去）。漏跑 0009 的两条后果：① 公告接口与后台公告页报 `no such column: receiver_type`；② 不回填则 2.5.7 起发的定向消息会被当成「所有用户」**全员可见**（私信变广播）。漏跑 0010 的后果：**2.6.0 的代码只认 `target_user_ids`**，接口与后台一律报 `no such column: target_user_ids`（公告功能整体不可用）；即使手工把接口绕开，不折数据也会让已有的定向消息变成"没有收件人"—— 静默丢消息。两个脚本都不幂等，各只跑一次；新建库已含这两列，都不用跑。
