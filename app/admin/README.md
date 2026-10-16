# `admin/`：管理后台（同一个 Worker，`/admin` 前缀）

对外 API 的经营后台。与 `../api/`（33 条对外接口）**分开管理**：两者的鉴权方式、改动节奏、可访问范围完全不同，
放一起会让 `app/` 变成杂物间。来源是旧站 `fastapi/app/admin/`（79 条路由 + 58 个 Jinja2 模板）。
逐文件对应关系见 `../notes/structure-map.md`。

## 一、目录结构

```
app/admin/
├── index.js            # 入口: /admin 前缀分发 + 静态资源 + 写路径权限拦截
├── routes.js           # 控制面板(2.6.9 精简: 5 卡 + 趋势 + 最新列表)
├── pages/              # 17 个页面模块(不含 index.js), 每模块导出 { methods, path, handler } 的 routes 数组
│   ├── index.js        # 汇总成 PAGE_ROUTES 交给入口分发
│   ├── banners.js notices.js categories.js appHome.js
│   ├── appVersion.js appText.js topics.js
│   ├── users.js adminUsers.js news.js comments.js
│   ├── settings.js systemInfo.js media.js(上传与素材库弹窗)
│   ├── dbTools.js      # 数据库工具 / 数据库管理(表浏览 + SQL 执行, ENABLE_SQL_TOOL 开关)
│   ├── mediaGovern.js  # 素材库治理(占用 / 引用 / 删除, 仅超管)
│   └── deleteConfirm.js(通用删除确认页)
├── routes/
│   └── auth.js         # 登录 / 登出 / 首次初始化
├── lib/
│   ├── entities.js     # 实体注册表 + 四份写权限清单 + classifyWritePath
│   ├── status.js       # 状态切换注册表(12 个 kind) + applyStatus
│   ├── listPage.js     # 列表页取数+分页骨架 listController(7 个列表页共用)
│   ├── utils.js        # 分页/回跳/幂等(onceOrError)/时间归一/localtime 等唯一实现
│   ├── catalog.js      # 文案分组/内置文案 key/版本默认值等常量
│   ├── categorySource.js # 分类真值来源(名称映射/启用集合/下拉选项)
│   ├── newsContent.js  # 正文视频 <wx-video> ↔ <video> 转换 + 摘要
│   ├── mediaUpload.js  # 上传校验(白名单+内容嗅探) + R2 写入 + 素材库列举
│   ├── dbTool.js       # 数据库工具安全内核(单语句/白名单表/脱敏) + D1 元信息与分页
│   ├── guard.js session.js password.js auth-store.js base64url.js http.js
│   ├── layout.js       # 页面外壳(替代 base.html)
│   ├── partials.js     # 页面宏: 页头/统计条/列表骨架/表单字段/编辑外壳/删除确认卡 + 图片兜底(imageTag/IMG_FALLBACK_ATTR)
│   └── nav.js          # 侧栏菜单唯一来源(status: ready/todo)
├── assets/
│   └── static-assets.js # 生成物: static/** 自有资源(css/js)的 JS 文本模块; vendor/(编辑器+图标字体)从 R2 直出(见 DEPLOY 7.5)
└── static/             # 样式与脚本原件(生成来源与对照, Worker 不直接读它)
    ├── css/admin.css  js/{sidebar-groups,admin-shell,infinite_scroll,status-toggle,image_upload,media_library,live_time}.js
    └── vendor/{bootstrap.min.css,bootstrap-icons.min.css,bootstrap.bundle.min.js,fonts/*.woff*,wangeditor/{index.js,style.css}}
```

## 二、迁移状态

| 分类 | 页面 | 说明 |
|---|---|---|
| **已迁移（16）** | 控制面板、用户管理、管理员管理、笔记管理（含编辑/预览/回收站/批量）、留言管理、分类管理、轮播图、通知公告、首页板块（含原「首页精选」，见下）、专题精选（摩旅/户外）、版本配置、运营文案、管理员设置、系统信息、**数据库工具 / 数据库管理**、**素材库管理** | 与旧站同路由、同文案、同口径（平台差异见第四节） |

两页"超管工具位"的实现口径：

| 项 | 做法 |
|---|---|
| 数据库管理（原「数据库工具」）`/admin/db_tools`、`/admin/db_manage` | 表清单（行数走 D1 `batch` 一次往返；**只有表清单这一屏默认统计**，`?counts=0/1` 控制）＋ **字段总览**（`?view=columns`：一条 SQL 关联 `pragma_table_info` 列出全库表与字段，`?table=` 只看一张表；不支持则回退逐表 PRAGMA 并在页面写明取法）＋ 表结构（列/类型/可空/**默认值/主键/索引列**，可复制列名与建表语句；索引列由**一次** `sqlite_master` 查询在本地解析；每列可一键跳"按此列排序/筛选"）＋ 数据分页（`?sort=&dir=` 点列头排序、`?col=&val=` 按字段筛选、`?q=` 跨列关键字搜索、20/50 行一页；第一列是隐式 `rowid`；行尾按钮**按需取整行**后复制 JSON/INSERT、生成 UPDATE 或**直接编辑这一行**，行首复选框支持批量复制与批量删除）＋ SQL 执行（`?size=` 不改语义；只允许 SELECT/INSERT/UPDATE/DELETE 的**单条**语句、只能操作白名单业务表；写语句必须 `confirm=1`，无 WHERE 的 UPDATE/DELETE 额外告警；结果显示 D1 用量 `rows_read/rows_written/duration`；错误在统一文案之外**多回一句数据库原文**，见下）；**默认关闭**，需把 `ENABLE_SQL_TOOL` 设为 `1` |
| 素材库管理 `/admin/media_manage` | 素材来自 **R2 列举**（旧站是 `os.walk`）；类型（`?kind=all\|video\|image`，标签条）/文件名/排序筛选 + 占用统计 + 引用情况；删除走服务端确认页，**有引用一律拒绝**（引用含回收站笔记，避免"删素材→恢复回收站→裂图"）；返回地址收敛，防开放重定向。**目录导航（2.6.5）**：桶根逐层浏览 + 面包屑（`存储桶 / 各级目录`，每一段可点回那层）+「上一级」按钮；目录按钮跟着当前位置动态一层（常态 =「存储桶根目录」（在根时高亮）+ 根下子目录，进了子目录就换成它的子目录；原写死的 `image/`、`video/`、`news_uploads/` 按钮并入这一层）。上传卡片的「目标路径」下拉由 `core/storage.js::listLevel` **只列桶根下的一级子目录**（2.6.6；2.6.5 曾扫全桶把各级目录都列出来，选项太长所以收回），**2.6.7 起与上面那排目录按钮逐字一致**（站在根目录直接复用本页 `browseQuery` 的根层数据、不再多一层"站内自有目录不进"的过滤），更深的层级仍可选「其它（手动填写）」写任意干净相对目录。**2.6.8**：命名默认值改成「保留原名」（重名顺延 `_1`/`_2`，「自动生成」仍是可选项），选完文件/文件夹后多一份可滚动的**待上传清单**（缩略图/图标 + 相对路径 + 大小/类型/状态，可按单个文件或整个文件夹移除，未传完的才能移除） |
| 引用判定 | `pages/mediaGovern.js` 的 `scanReferences()` 是**列表列 / 查看引用 / 详情 / 删除与改名前复查**的唯一实现（旧站 v2.3.4 的 BUG 就是两处判定不一致）。粗筛 SQL 每个 `LIKE` 都要带列名、失败要 `console.error` 出来：2.2.4 修的事故就是拼成 `image LIKE ? OR LIKE ?` → SQLite 语法错 → 被 catch 吞成"零引用" → 引用列整列显示"未引用"、删除前复查一起失效（桩测试看不出语法错，补了用 `node:sqlite` 真解析的用例）。真实旧库实测 185/185 全部认出（修复前 0/185）。**2.6.5 修误判**：根目录素材原先用 `text.includes(name)`（子串）判命中 → `image/food/2017-2018.jpg` 会把根目录的 `2018.jpg` 判成被引用；现在 `core/storage.js::relPathsIn` 只认"整段路径相等"（片段剥离协议/主机/`?`/`#` 后比对 + 一条边界匹配兼容带空格的文件名），两条回归用例分别在 `tests/unit.test.mjs` 与 `tests/admin_pages_tools.test.mjs` |
| 管理页的 D1 查询必须并发 | 互不依赖的查询一律 `Promise.all`（笔记列表：总数/列表/分类选项；素材库：R2 列举/引用扫描/占用统计）。**Why**：每条查询各占一次 D1 往返，D1 在西欧时顺序发就是 9 × RTT（接近 2 秒），并发发只要一趟 |
| **但并发只省 HTTP 往返 —— D1 单线程串行执行，语句数才是大头** | `batch`/`Promise.all` 只让 N 条语句"同时排队"，库侧仍逐条执行。所以在**没必要**的语句上省钱更划算：不要为了看一眼结构就把全库行数数一遍、不要一条索引一次 `PRAGMA`、不要把行数据塞进页面。2.2.7 的 `db_tools` 三件事全占了（结构页 39 条 / 数据页 41 条语句、`news` 50 行 269KB HTML），2.2.8 按视图裁剪后降到 **8 条 / 8 条 / 125KB**，2.2.9 加元数据缓存后同一分钟内再打开结构视图只剩 **1 条**（本表行数）、字段总览 **0 条** | `lib/dbTool.js`（`tableMeta` 的索引列解析、`countRows`、`tablePage`、`allColumns`、元数据缓存）、`pages/dbTools.js`（按视图决定统计、行数据按需取）；测试用"语句数上限"、"列表不内嵌整行"、"缓存命中后不再读 sqlite_master"守住 |
| **页面的写能力只有一个入口：`POST /admin/db_manage/exec`** | 2.2.9 的行内编辑、单行删除、批量删除**都不新增写接口** —— 前端按主键/`rowid` 生成一条 `UPDATE`/`DELETE` 再交给 exec，这样"能改哪里、怎么改"的口径只有一处（白名单业务表 + `confirm=1` + 无 WHERE 告警 + 审计 + 用量回传），也不会出现"页面能改但 SQL 不能改"的两套判定。批量删除用 `DELETE … WHERE rowid IN (…)` 一条语句（D1 没有交互式事务，一条语句才谈得上原子） | `pages/dbTools.js` 的 `editorSql()` / 批处理分支；`lib/dbTool.js` 的 `classifyStatement`（DDL/事务/多语句一律拒绝）；测试断言"页面里的写操作都 POST 给 exec"且"db 系列只有一个 POST 路由" |
| **元数据可以缓存，行数不能** | 表清单/列/索引/建表语句/字段总览是"结构不变就永远一样"的东西，缓存 60 秒（键为 D1 绑定对象，只缓存结构）；**行数与数据一律不进缓存** —— 缓存行数会让页面显示过期数字。额度有限（读取行 5M）时这条最省钱：来回切视图不再重复读 `sqlite_master` | `lib/dbTool.js` 的 `storeOf/tableNamesCached/tableMeta/allColumns`；测试断言"表清单/列结构走缓存，但本表行数每次都重数" |
| 列表页"标题/文件名"列固定宽度 | `<td class="cell-title"><div class="text-truncate" title="完整内容">`；`.cell-title` 桌面 360px / 手机 200px。**Why**：不固定时超长标题会把封面、状态、操作列挤出屏幕（360px ≡ 既有 `clamp-lg` 档，≈25 个汉字） | `static/css/admin.css`（桌面 + 手机端适配层各一处）；`pages/news.js`、`pages/mediaGovern.js`；`tests/admin_submit_action.test.mjs` 连生成物一起检查 |
| 两页的闸 | 页面 GET 自己判超管（中间件只拦写方法）；写路径 `/admin/db_manage`、`/admin/media_manage_delete` 已在 `entities.SUPER_ONLY_WRITE_PATHS` 登记 |

## 三、鉴权（与旧站同一套做法，只有哈希算法换了）

| 环节 | 做法 | 说明 |
|---|---|---|
| 账号 | D1 表 `admin_users`（`app/sql/0004_admin.sql`，与旧库同构） | 字段含 `username`/`password`/`role`/`last_login_time` |
| 口令 | **PBKDF2-SHA256**（`crypto.subtle` 原生实现，零依赖），哈希串 `pbkdf2_sha256$<迭代数>$<salt>$<hash>` 自描述 | 迭代数 10000，将来要提高不用改代码（旧哈希照样能验） |
| 会话 | **HMAC-SHA256 签名 Cookie**，载荷含 `id/username/role/exp/口令指纹` | `HttpOnly; SameSite=Strict`；**`Secure` 只在 https 下发**（http 下浏览器会丢弃它，本地预览会"登录成功却回到登录页"）；改口令即踢下线 |
| 防跨站 | `SameSite=Strict` + 登录/登出/初始化的 `Origin` 校验 | 不再另发 CSRF token |
| 登录限速 | **复用 `app/core/ratelimit.js`**：IP 级 5 次/15 分钟锁定，外加"同一账号 10 次/15 分钟" | 计数落在 D1 的 `rate_limit_counters` |
| 页面权限 | `lib/entities.js` 四份写路径清单：`super`（分发前拦）/`route_super`（页面内自查）/`normal`/`exempt`；**未登记一律拒绝并记日志** | `node --test` 里有"写入口是否都登记了口径"的自检 |
| 会话密钥 | 密文 `ADMIN_SESSION_SECRET` | **没配时登录页直接提示"后台未就绪"**，不会用默认值放行 |

### 为什么不是 bcrypt（旧站用的那个）

Workers **免费套餐 CPU 只有 10ms/请求**（超了报 Error 1102）：纯 JS bcrypt 要 100~300ms、连 PBKDF2 十万轮也会超。
所以迭代数压在 10000，并用登录限速补偿。要让哈希强度回到 bcrypt 级别，只能开 Workers 付费（CPU 上限 30 秒）。

### 首次初始化与"旧库密码为什么不能用"

1. 建表（`app/sql/0004_admin.sql`）后表是空的 → 浏览器打开 `/admin/bootstrap`，填用户名/昵称/口令（**≥10 位**）→ 建出 `role=super` 的账号。
2. 旧库 `admin_users` 里的口令是 **bcrypt** 哈希，免费套餐下无法校验，因此**不能直接沿用**；要保留原来的用户名，
   在 bootstrap 时填同样的用户名即可。表非空后 `/admin/bootstrap` 自动失效。

### 忘记口令怎么办

没有"找回密码"通道（也不该有邮件/短信那条路）。D1 Console 里执行下面这句清空后，重新访问 `/admin/bootstrap` 重建：

```sql
DELETE FROM admin_users;   -- 清掉全部管理员(通常只有 1 个)
```

验收与排查（`/admin` 该回什么、登录页提示"后台未就绪"是什么意思）见 `../DEPLOY.md` 的 A8。

## 四、与旧站的差异（有意为之）

| 项 | 旧站 | 这里 |
|---|---|---|
| 模板 | Jinja2 58 个模板 + `base.html` | 手写 HTML 生成（`lib/layout.js` + `lib/partials.js`），零模板引擎 |
| 口令哈希 | bcrypt（轮数 10） | PBKDF2-SHA256 10000 轮（免费套餐 CPU 限制） |
| **口令长度下限** | 前端模板写 6、后端判 10（旧站已知缺陷 B9） | **前后端统一 10 位** |
| 管理员头像 | 无（设置页从未做过头像编辑） | **保持一致：也没有** |
| 会话 | Starlette 签名 Cookie（含会话复核 TTL） | 自己的 HMAC 签名 Cookie（含口令指纹，等价于"改口令即失效"） |
| 上传素材 | Pillow 上传时预生成缩略图 + CLI 补跑 | **不生成任何派生文件**；2.4.0 起缩略图功能整体移除，列表/详情/预览/对外接口一律用原图（原图 8MB / 视频 64MB，按文件头判类型） |
| 进程内缓存 | `invalidate_entity_cache` 真清缓存 | 无进程内缓存，`invalidateEntityCache()` 是**有意空实现**（将来上 Cache API 只改这一处） |
| 表单一次性防重 | 进程内缓存 `add_if_absent` | 落 D1 `rate_limit_counters` 抢键（`INSERT OR IGNORE`） |
| 审计 | 写日志文件 | `app/core/logging.js` 的结构化 `admin.audit` 事件进 Workers Logs（**不建审计表**，需要可查询审计时再补） |
| 侧栏交互 | 折叠记忆 + 滚动位置恢复（~250 行 JS） | **原样复用**（`static/js/sidebar-groups.js` 从 base.html 提取） |
| 列表加载 | 触底加载行片段 | **原样复用** `infinite_scroll.js`（契约一致：`{success, rows}`）；2.4.1 起素材库页也从"上一页/下一页"并到这套（新增行片段端点 `/admin/media_manage_rows`），"跳至 N 页"做成共用开关（`listShell`/`pagerScript` 的 `jump:false`，笔记页与素材库页关掉） |
| 数据库工具 | 支持 SQLite/MySQL 双驱动、库文件备份、表结构自愈、VACUUM、行内编辑数据 | 只有 D1：无备份/无自愈/无压缩/无 VACUUM（导出用 `wrangler d1 export`）；浏览范围是全部表，执行 SQL 仍限白名单业务表；**默认关闭**（`ENABLE_SQL_TOOL`）。2.2.7 起把"日常查数据"这一半补齐（结构给全默认值与索引列、数据可排序/筛选/跨列搜索、单行可复制或生成 UPDATE、SQL 快捷语句与本机历史、失败给数据库原文），比 D1 控制台少来回跳；**不做**行内编辑表单（只生成 SQL）与任何结构变更 |
| 素材库治理 | `os.walk` 扫本地目录 + 15 秒进程内扫描缓存 | **R2 列举**（无进程内缓存，每次真扫元信息）；占用统计只算"文件总数与总字节"（2.4.0 起不再分派生缩略图一栏）；**2.4.6 起这页是整个桶的资源管理器**：按前缀逐层列举（`list({prefix, delimiter:'/'})`，一次一层、每层 ≤1000），素材范围仍按素材口径（`listNewsMedia`：`image/`+`video/`+`news_uploads/` 与根目录树里的图片/视频，排除站内自有的 `avatar/`、`avatar_uploads/`、`images/`），而**桶浏览器本身能看/管全部对象**（引用扫描只对素材路径做） |
| 素材删除 | `os.remove`（同样不可恢复） | R2 `delete`（无回收站）；同样"有引用一律拒绝 + 服务端确认页" |

## 四·五、十处实现约定（改这里之前先读）

| 约定 | 为什么 | 改哪里 |
|---|---|---|
| **版本号只有一个来源**：`main.js` 的 `API_VERSION`；入口用 `handleAdmin(request, env, { version })` 注入，侧栏 `.ver` 与静态资源 `?v=` 都读它 | 版本号若各页自己读 env/配置，就会出现"首页正常、后台侧栏只显示一个 v"这种不一致（2026-10-06 的线上故障就是入口漏传参） | `main.js`（注入）；`lib/layout.js`（版本为空时**不渲染** `.ver`，宁可没有也不留裸 `v`） |
| **表头要放真 HTML 必须显式声明**：`listShell` 的列支持 `{ label, html: true }`，其余一律转义 | 默认转义是安全底线；笔记列表的"全选"复选框曾因此被显示成 `&lt;input …&gt;` 源码文本 | `lib/partials.js` 的 `listShell`；调用方如 `pages/news.js` 的 `COLUMNS` |
| **列表页取数/分页只有一个入口**：`lib/listPage.js` 的 `listController(ctx, { table, from, where, columns, orderBy, parallel, label })`（7 个列表页共用，页面只给表名/筛选/排序/行渲染；带 JOIN 的留言页用 `from`+`columns`，笔记页的分类下拉用 `parallel` 与 COUNT/取行一起并发） | 这 7 页原先各写一份 `COUNT → firstScreenLimit → LIMIT 取行`，分页边界与口径的修复要同步 7 处（历史上的越界/跳页就是这么分散修的），且各页写法已经开始分叉（有的按当前页取行、有的按首屏上限取行再裁） | `lib/listPage.js`；调用方 `pages/{news,users,comments,banners,notices,topics,adminUsers}.js` |
| **写操作防重只有一个入口**：`lib/utils.js` 的 `onceOrError(ctx, action, parts, ttl)` —— 命中重复提交时返回可直接回显的文案，正常放行返回空串（会话 id 由它自己拼进 key） | 同一段 `idemKey` + `isDuplicateSubmit` + 同一句文案原先在 15 个写操作里各写一份，改文案或换口径必漏；`parts` 里再拼会话 id 也容易各页写法不一 | `lib/utils.js`（含唯一文案常量 `DUPLICATE_SUBMIT`）与各页写入口 |
| **图片加载失败的兜底只有一份**（2.6.9）：后台展示素材图的 `<img>` 要么走 `partials.js` 的 `imageTag(env, key, { className, style, attrs })`，要么挂同一份 `IMG_FALLBACK_ATTR`；失败换 `/lucky.jpg`，若当前地址本来就是兜底图（说明它也没加载到）才 `visibility:hidden` 收起 | 原先各页各写一套：`visibility:hidden` / `display:none` / `classList.add('d-none')` 三种写法共存，用户看到的是"整块图没了"而不是一张占位图；换兜底图或改兜底行为要改七处。兜底图由 Worker 内联字节直出（`app/core/lucky.js`，生成物；路由见 `main.js` 的 `LUCKY_PATH`），与 favicon 同一手法 —— 不依赖 R2 有没有那张对象，未登录的登录页也能取 | `lib/partials.js`（`imageTag`/`IMG_FALLBACK_ATTR`/`IMAGE_FALLBACK_SRC`）；调用点 `pages/{news,banners,topics}.js`、`lib/homeSections.js`（首页三块内容的列表封面）、`imageUploadField` 的封面预览，以及正文编辑器 `static/js/news_editor.js`（地址由页面经 `data-img-fallback` 下发，编辑中新增的图片由 MutationObserver 补挂）；`tests/admin_pages_config.test.mjs` 六个页面逐张数 `img` 守住 |
| **页面脚本不许写进模板字符串**：脚本一律放 `static/js/*.js`，引用走 `partials.js` 的 `staticScript(file, version)`，模板里最多注入配置（如 `window.__mediaGovernCfg`） | 模板字符串里写脚本会被求值吃掉反斜杠、被反引号截断（2026-10-10 两次教训）；搬成真文件后才有语法检查，`tests/admin_pages_config.test.mjs` / `admin_pages_tools.test.mjs` 也改成按文件内容断言 | `static/js/{media_govern,db_tools,news_batch}.js`；引用点 `pages/{mediaGovern,dbTools,news}.js` |
| **素材目录只认 `core/storage.js` 的常量**：新上传落 `image/`、`video/`、`avatar/`（素材库页 2.4.1 起由入口决定类型：图片→`image/`、视频→`video/`）；列举/引用判定/直出都要覆盖历史目录 `news_uploads/`、`avatar_uploads/`；2.4.0 起**不再有任何派生文件**（缩略图整体移除，一律用原图） | 目录散落在多处各写一份时，会出现"传上去但素材库里看不到""老素材被判成未引用而误删"这类静默事故（旧实现就是 `mediaUpload.js` 与 `core/storage.js` 各有一份 `news_uploads/`） | `app/core/storage.js`（`MEDIA_PREFIXES`/`SERVED_PREFIXES`）；调用方只 import，不自己拼 |
| **上传弹窗靠 `static/js/image_upload.js` 认领**：表单只写 `data-endpoint/data-purpose/data-kind/data-target/data-insert`，发请求的是那个脚本（capture 阶段监听 submit） | 这段绑定原先在旧站模板里，抽静态脚本时漏掉了 → 点「上传」变成整页提交，表现为"上传没反应/上传失败"（`tests/admin_submit_action.test.mjs` 会拦回退） | `app/admin/lib/partials.js`（渲染表单）；`static/js/image_upload.js`（绑定与回填） |
| **弹窗类脚本由外壳统一引**：`image_upload.js`、`media_library.js` 在 `lib/layout.js` 的 `MODAL_SCRIPTS` 里引入；`partials.js` 只渲染弹窗 HTML，**不带** `<script>` | 旧站是 `_image_upload_field.html` / `_media_library_modal.html` 各自带 `<script src>`，抽成 `partials.js` 时标签丢了 → 页面有弹窗有表单却没人处理 submit/拉列表：**点「上传」变整页提交、素材库弹窗点开空白**；而服务端直出的 `/admin/media_manage` 不受影响，极易误判成后端问题（`tests/admin_submit_action.test.mjs` 有一条"资源包不许有孤儿脚本"的检查） | `lib/layout.js`（`MODAL_SCRIPTS`）；两个脚本各自带幂等守卫（`__imageUploadBound` / `__mediaLibraryBound`） |
| **编辑器资源与初始化脚本只服务编辑页**：`vendor/wangeditor/{style.css,index.js}` 与 `js/news_editor.js` 在 `pages/news.js` 的 `scripts` 里按序引；脚本内部的一切插入都走"插完校验"（编辑器对失效选区是静默失败） | 编辑器是 1.27 MB 的库，挂到外壳上会让**每个**后台页面都多背这份体积；而"点上传没反应""素材库插不进去"这类问题全都出在初始化/插入这条链上，只有编辑页需要 | `pages/news.js`（`scripts`、容器三件套 `#contentToolbar/#contentEditor/#contentRaw`，并向编辑区下发 `data-media-base`（`core/media_scheme.js::mediaBase`）与 `data-img-fallback`（`IMAGE_FALLBACK_SRC`））；`static/js/news_editor.js`（初始化 + 回显/入库转换 + 两个插入落点）：正文图片在编辑器里一律用**媒体域绝对地址**（与后端 `assetUrl` 同口径，否则"上传到存储桶最外层"的素材在 `/admin/` 下会解析成 404 而裂图），提交时还原成相对记录值；外链、`data:`、兜底图原样不动 |
| **"小程序尺度"只有一份**：编辑页与预览页都用 `.mp-frame`（`--mp-w=800px`），`news_edit` 因此不用两列的 `editShell` 而是自己的单列布局 | 预览框就是 800px 宽，所以"预览所见 = 编辑所见"；宽度/字号只有一处定义，改一处两边一起变 | `lib/partials.js` 的 `mpFrame`/`admin.css` 的 `.mp-frame`/`pages/news.js` 的 `previewPage` |
| **列表页要"就地隐藏不再匹配筛选的行"必须声明属性**：`listShell({ tableAttrs: ' data-status-filter-param="status"' })` | `status-toggle.js` 靠这个属性判断本页按哪个参数筛选；不声明时它会静默跳过这段逻辑（功能像"没实现"，实际是没接上） | 各列表页的 `listShell` 调用；`lib/partials.js` 的 `tableAttrs` |
| **筛选项一律用共用筛选组 `partials.filterButtons`**（基准 = 留言管理页上那一组）：`.btn-group.btn-group-sm > a.btn.btn-outline-secondary`，当前项带 `.active` + `aria-current="page"`；参数名与取值按各页语义（`?status=` / `?category=` / `?topic=` / `?section=` / `?kind=`），**"全部"也带参数**（`?status=all` 这一口径） | 旧站每页一套形态（专题 pills、素材库按钮组、笔记下拉），换页就得重新找筛选器；各写一套还会各自拼错地址（切筛选丢页码/丢其它筛选）。筛选态进 URL 后刷新/直链/回退都能定位，分页与触底加载也自动带着它 | `lib/partials.js` 的 `filterButtons`；六个调用点 `pages/comments.js`、`news.js`、`topics.js`、`appHome.js`、`mediaGovern.js`、`notices.js`（2.5.9 起公告页按接收人筛选）（`tests/admin_submit_action.test.mjs` 有一条"六页只许引用共用实现、且不许自己写 `btn-group`/`nav-pills`"的检查） |
| **R2 的写入规则只有 `core/storage.js` + `lib/mediaUpload.js` 两处**（2.3.9 定规则、2.4.0 补上传策略、2.4.1 补"入口即类型"、2.4.2 补"目录整棵保留"、2.4.3 补"目标路径可选"、2.4.4 补"根目录 + 可选下拉"、2.6.5 放宽目标路径）：新对象 `<目标路径>/<相对路径目录>/<文件名>`（图片入口 `purpose=cover`→默认 `image/`、视频入口 `purpose=video`→默认 `video/`；目标路径来自 `target_dir`（缺省=类型根目录，`/`=存储桶根目录即"空前缀"；**2.6.5 起任何"干净的相对目录"都收** —— `root` 只当默认值，仍拒 `..`/绝对路径/`//`/空段/特殊字符/超长，代价是写进素材库不扫的目录（如把图片写进 `video/`）时那些对象列不出来，公开域直读不受影响）与 `rel_path`（**两种命名模式都保留**，`auto` 只换文件名那一截；**2.6.8 起上传卡片默认 `keep`（保留原名）**，默认值只是页面上的勾选，服务端两种都照收））、上传时写死 `CACHE_CONTROL_MEDIA`（7 天 immutable）、**写前 `head` 查重、重名顺延 `_1`/`_2` 绝不覆盖**（顺延按完整 key 算，含目录 → 不同子目录的同名文件各自独立计数）；改名 = 读→写→删（`moveMediaFile`，流式，R2 没有 rename）；批量删除 = `removeMediaFiles`（`delete(key[])`，一批 1 次子请求，页面按 20 封顶）；**缩略图已整体移除（2.4.0）**，一律用原图 | R2 的能力边界（无 rename/copy、无图片处理、无"建目录"、单次 list/delete 各 1000、子请求 50、key 上限 1024 字节）决定了只能这么用；把这些规则散在各页面会立刻出现"有的批量逐个删、有的不写缓存头、有的会覆盖同名文件"这类不一致 | `core/storage.js`（`moveMediaFile`/`removeMediaFiles`/`CACHE_CONTROL_MEDIA`、`isRootMediaName`/`normRel`/`relPathsIn`/`listLevel`/`listNewsMedia` 的根目录口径）、`pages/mediaGovern.js`（唯一的素材治理页：上传/详情/改名/批量删除都在这里，但都不自己碰 R2 SDK）、`lib/mediaUpload.js`（目标目录与命名策略、`safeRelPath`/`safeTargetDir` 清洗、上限） |
| **搜索区一律用 `partials.searchBar` / `searchInput` / `searchSelect`**（2.3.4）：结构 = `form.search-bar.d-flex.flex-wrap.align-items-center.gap-2` + `form-select-sm` + `form-control-sm` + `btn.btn-sm.btn-outline-secondary`（`bi bi-search` + 「搜索」）；宽度只在 `admin.css` 的 `.search-input`(12rem)/`.search-select`(9rem)/`.search-select-lg`(12rem) 定义；手机端按钮与输入框同高 38px、每项独占一行 | 统一前 9 处各写一套：换行（有的没 `flex-wrap`）、垂直对齐、宽度手法（`max-width` / `width:auto` / 内联 `width`）、控件顺序、图标（`bi-search` vs `bi-funnel`）与文案（搜索 vs 筛选）**六项各不相同**，改一处忘八处；高度这类"用户能看出差别"的东西必须由共用结构与共用样式决定 | `lib/partials.js` 的 `searchBar`/`searchInput`/`searchSelect`；调用点 `pages/news.js`（2 处）、`notices.js`、`topics.js`、`users.js`、`appText.js`、`mediaGovern.js`、`dbTools.js`、`partials.js` 的素材库弹窗（`.search-group`）；`admin.css` 的 `.search-input`/`.search-select` 与手机适配层；`tests/admin_pages_config.test.mjs` 用"源码扫描 + 渲染断言 + CSS/生成物同步"三条守住 |
| **列表页头部一律用共用三行结构 `partials.listToolbar`**（2.3.3；2.3.7 补齐「首页板块管理」—— 它的三块内容各是一张卡片，没有页面级新增按钮，所以当时被留成待确认；现在三块的新增按钮提到第一行、板块标签条第二行，卡片头部只留板块名与条数）：第一行 = 新增/发布按钮（`addButton`）+ 附带动作 + 右侧统计；第二行 = 筛选标签条（`filterButtons`）；第三行 = 搜索/筛选表单。没传的行不渲染 | 2.3.2 只统一了按钮**标记**，新增按钮/标签条/表单仍挤在同一条 `flex-wrap` 里 —— 屏幕上与改前完全一样，被判"等于没改"。位置这类"用户看到的结构"必须由**共用结构**决定，不能靠各页自觉；顺带也让"新增按钮永远在最前、筛选与搜索永远在它下面"成为一条不会漂移的约定 | `lib/partials.js` 的 `listToolbar`（`listShell` 已内置它：`actions` = 第一行，新增 `filters`/`search` 两个槽）；调用点 `pages/news.js`、`topics.js`、`notices.js`、`appText.js`、`categories.js`（`tests/admin_pages_config.test.mjs` 断言三行顺序与"缺行不渲染"，另有浏览器几何核对） |
| **首页三块内容只认 `lib/homeSections.js` 的描述表**：主题项目/拓展项目/精选项目各自的表名、状态类型、列头、行渲染、新增/编辑/删除入口都在那一个文件里；合并页只负责"取数 + 按板块分组 + 渲染卡片"，**编辑页（2.3.8 起也只有一个）按 `?section=` 决定字段集与要写的表** | 2.2.5 把「首页精选管理」并进「首页板块管理」时，若三块各写一套表格，字段差异（精选有"标识/跳转页面"）会散成三份代码，改一处忘两处；三个编辑页各写一套也是同一个问题（合并后 `pages/appFeatured.js` 整个删掉） | `lib/homeSections.js`（`SECTIONS`/`SECTION_TABS`/`sectionLabel`/`sectionOf`/`sortSectionRows`）；`pages/appHome.js`（合并页 + **唯一的编辑页** `/admin/app_home_edit`：`?section=main\|ext` 写 `app_home_sections`、`?section=featured` 写 `app_featured_items`；另含精选删除端点）、`pages/deleteConfirm.js`（`kind=featured` 回 `?section=featured`） |
| **数据库工具的错误原文只回给超管**：`runStatement` 失败时，除统一文案外**额外**回一句截断到 200 字的数据库原文（同一份同时进 `logWarn` 与服务端审计） | 旧站口径是"错误详情只进日志"，但这一页的使用者本来就是能浏览全库的超管，而 "no such column: xxx" / "UNIQUE constraint failed" 这类原文是定位语法与约束问题最快的线索；页面默认关闭且仅超管，放开的是可诊断性而不是权限 | `lib/dbTool.js` 的 `runStatement`；`pages/dbTools.js` 的 `execHandler`（回 `detail` 字段） |
| **单行"编辑"只生成 SQL，不做行内表单**：行尾三个按钮是"复制 JSON / 复制 INSERT / 生成 UPDATE"（UPDATE 直接填进 SQL 控制台） | 任意列的行内编辑要动态表单 + 拼整行 UPDATE（宽表极易漏列或写错类型），还会多开一条写路径；生成语句后仍走唯一那条被白名单与审计拦着的 `exec`，安全边界不变。生成时会跳过敏感列（展示值已打码，照抄会覆盖真值） | `pages/dbTools.js`（前端拼语句 + `data-sensitive-columns`）；`lib/dbTool.js`（`tablePage` 回传 `__rowid` 与 `pkColumns`） |
| **超管专属入口要有第二道闸**：`entities.js` 的 `SUPER_ONLY_WRITE_PATHS` 与 `ROUTE_SUPER_ONLY_WRITE_PATHS` 都在分发前拦；页面内自查只是补强 | `ROUTE_SUPER_ONLY` 原本约定"页面自己判"，而管理员页漏了判 → 任何登录账号都能 POST 增删管理员/重置口令（2.1.6 修）。写路径清单是唯一权威，页面自查不能替代它 | `app/admin/index.js`（分发前的 403）；`lib/entities.js`（清单）；`pages/adminUsers.js`（整页仅超管） |
| **超管标识与登录名一律从 `ctx.session` 派生**：`adminLayout` 同时接受显式 `isSuper` 与摊开的 `ctx.session`（`session.isSuper`），顶栏用户名同理 | 页面里两种调用风格并存（`{ isSuper: ctx.session.isSuper, … }` 与 `Object.assign({}, ctx, …)`），只认显式那一种时，超管专属菜单会在"只摊 ctx"的页面（控制面板、错误页、工具页自身）整体消失 —— 表现为"有时看不到" | `lib/layout.js` 的 `adminLayout`；新增页面两种风格都能用（自检见 `tests/admin_sidebar_menus.test.mjs`） |
| **动作字段一律用隐藏域**：`<input type="hidden" name="action" value="restore_user">` 或 `name="delete_admin" value="1"`，**不要**把动作挂在提交按钮的 `name/value` 上 | 表单数据是在 submit 事件**走完之后**才构造的，"提交时被禁用/被脚本锁定的按钮"不进表单数据 → 那个字段整条丢失 → 后端只回"未识别的操作"（2026-10-06 线上：用户管理两个按钮只发出 `user_id`/`page`，真实 Chromium 实测复现）。同理 `admin-shell.js` 锁按钮**只能**用 `aria-disabled` + `pointer-events`，绝不能设 `btn.disabled = true`（`tests/admin_submit_action.test.mjs` 会拦回退） | `lib/partials.js` 之外的各页表单；`static/js/admin-shell.js` 的 `lockButton` |
| **用户管理两个写操作的语义**（下表） | 它们直接对应小程序侧判定，改错会连带影响小程序 | `pages/users.js` 的 `writeSubmit` / `restoreUser` |
| **公告「接收人」搜人用普通提交按钮**（`name="action" value="search_user"`，全后台唯一一处把动作挂在按钮上；2.5.9）：它只是"带当前草稿重画本页"，不落库也不新增接口/静态资源 | 上一条禁的是"**多个**按钮都靠 value 区分 + 提交时被脚本禁用"，而这里只有一个按钮靠 value，`admin-shell.js` 的 `lockButton` 又**只**用 `aria-disabled` + `pointer-events`（`static/js/admin-shell.js` 里写明了原因：表单数据在 submit 事件之后构造），value 一定进表单，且 `lockButton` 锁的是 `e.submitter`（真正被点的那个按钮），所以它排在「保存」前面也不会在保存时变成转圈；换成隐藏域则"保存"也会带上它，反而分不出两个动作 | `pages/notices.js` 的 `receiverCard`（渲染）与 `editPage`（认 `form.action`）；`static/js/admin-shell.js` 的 `lockButton`（**不要**改成 `btn.disabled = true`） |

用户管理两个写操作（与旧站 `users_admin.py` 同口径）：

| 操作 | 落库 | 语义与判定依据 |
|---|---|---|
| **恢复账号** | `UPDATE users SET status=0, nickname='<原昵称>(已恢复)', raw_nickname='<原昵称>'`；**`deleted_at` 保留** | `status != 0` = 已注销（不能再登录）；恢复后该用户可用微信重新登录；`deleted_at` 留作"曾被注销过"的标记，列表据此显示"已恢复"。**与对外 `/user/deleted_account_action` 的 restore 不同**：那个给小程序用，会换 token 并清 `deleted_at` |
| **设为 / 取消内部测试** | `UPDATE users SET is_trusted = 1 / 0` | `users.is_trusted`（1=内部测试）就是判定依据，小程序侧三处生效：① 专题视频可见（`app/api/content.js` 仅 `is_trusted=1` 才下发 `video_url`）；② 留言免审（`app/api/news.js` 里 `is_trusted=1` 直接 `approved`，否则 `pending`）；③ 登录载荷带 `is_trusted`（`app/api/user.js`）供前端区分（「我的」页菜单的图标与可见性也从这里派生的身份字段判定，见小程序 `app.js` 的 `APP_MENU`） |

两个按钮都是：仅超管可见（`actionCell` 判 `isSuper`，另有 `entities.SUPER_ONLY_WRITE_PATHS` 的 `/admin/users` 拦一道）→ 点击先 `confirm()` → `POST /admin/users`（隐藏域 `action=set_trusted|remove_trusted|restore_user` + `user_id`）→ 成功 302 回列表并带 `message`（整页刷新即最新状态），失败带 `error` 显示在页面顶部。

## 五、样式与脚本怎么改

原件在 `app/admin/static/`，Worker 读的是 `app/admin/assets/static-assets.js`（**生成物，别手改**）。改了原件后重新生成：

```powershell
cd cfapi
node tools\embed_admin_assets.mjs
```

生成规则：`static/**` 全部资源转成 JS 文本模块；字体（`.woff/.woff2`）用 base64 包成 `data:` URL（`serveStatic` 解码后按二进制返回）；转义风格与旧生成物一致（`< > & '` 走 `\u00xx`），所以重生成只会改动真正变过的资源。

改完记得改 `main.js` 的 `API_VERSION`（资源地址带 `?v=`，不升版本号浏览器会用旧缓存）。

> 关键提醒：**页面模块（`pages/*.js`）改完直接生效；`static/**` 改完必须重跑上面这条命令** —— 只改源文件不改生成物，线上拿到的还是旧脚本（"点了没反应 / 未识别的操作"这类现象就是漏了这一步）。

## 六、本地怎么测

- `cd cfapi && node --test`：**304 条**用例，覆盖三件套(权限归类/工厂/工具)、外壳(守卫/状态切换/宏/版本号注入/动作字段防回退/侧栏超管菜单/route_super 双闸/JSON 体解析/上传表单绑定/弹窗脚本引用与孤儿脚本检查)、数据库管理(表清单 batch 与按视图裁剪统计、字段总览一条 SQL 取全库字段与快路失败回退 PRAGMA、元数据缓存命中后不再读 sqlite_master 但行数每次重数、结构含默认值/主键/索引列且索引列一次 DDL 本地解析且语句数≤8、数据排序/字段筛选/跨列搜索且非法列名被忽略、列表不内嵌整行且按 rowid 取完整行、批量取行走一条 rowid IN 且上限 50、行内编辑/批量删除都生成 SQL 交给 exec 且 db 系列只有一个 POST 路由、非白名单表只读、成本与额度卡、写法 SQL 语句的告警、失败原文)、首页三块内容(合并页三张表与标签条/精选项增删改都回 `?section=featured`/添加时预选板块/旧地址 404 且菜单与路由表都不再引用)、筛选组(五页共用实现且结构与留言管理页同款 + "全部"也带参数 + 选中态/直链/过滤/翻页带筛选/手机端换行)、搜索区(共用 searchBar/searchInput/searchSelect 的结构与按钮三统一、7 页渲染出"有且只有一条搜索条"且参数与 placeholder 不变、源码扫描不许再手写 type="search"/bi-search/max-width 定宽、CSS 规则与 static-assets 生成物同步、素材库弹窗搜索行 sm 等高)、分类显示(标签条/列表分类列/编辑下拉/回收站/迁移下拉都只显示名称, 标识只留在 URL 参数与取值里)、列表分页(把 infinite_scroll.js 真跑一遍: 带 URL 参数时只拼一个 ? 且带着 category 与 page=2、追加第二页、页码前进; 各页 rowsUrl 必须是纯路径)、首页板块头部同构(四个 section 视图的第一行逐字等于共用 addButton 拼出的按钮串、第二行是唯一一条标签条、新增按钮排在标签条之前、选中态正确、卡片头部不再有靠右按钮)、首页内容编辑页三合一(?section= 决定字段集与写入的表、老地址 ?id= 仍能打开、精选只写精选表/板块入口只写板块入口表、已删除的 /admin/app_featured_edit 落到 404 而删除端点仍在)、素材库 2.3.9(上传复用既有端点且新对象带缓存头、详情页、改名四种路径、批量删除 1 次 R2 调用/整批拒绝/超上限、目录与引用状态筛选)、缩略图移除(2.4.0: media_scheme/storage/mediaUpload 不再导出任何缩略图助手、五个关键文件的源码扫描、/news/list 不再下发 image_thumb 且一次 head 都不发、预览页全是原图)、上传命名与落目录(2.4.0: safeRelPath 挡路径穿越、purpose=auto 按内容分流、重名顺延 _1/_2 不覆盖、端点透传 name_mode/rel_path; 2.4.1: 入口即类型、图片/视频各带文件+文件夹、类型对不上被拒; 2.4.2: rel_path 两种模式都生效、目录整棵保留含顶层文件夹、不同子目录同名互不顺延、safeRelPath 的 ?#%/盘符清洗; 2.4.3/2.4.4: safeTargetDir 认本入口根目录及其子目录与根目录 `/`、跨入口/穿越/绝对路径/空段/特殊字符/超长逐条拒绝且不写对象、target_dir 与 rel_path 叠加)、根目录素材(2.4.4/2.4.5: isRootTreePath 的范围=根下文件与根下自定义目录(已知前缀一律不算, 且要图片/视频扩展名)、normRel 认根目录记录值、listNewsMedia 按 delimiter 拿根下对象与顶层目录并对非已知前缀的目录各扫一趟(去重)、dir 为空串、relPathsIn 按候选名单命中、站内自有目录不进库、根目录素材能被列出/筛选/搜索/判引用/详情/改名(根目录档允许带目录)/删除, 另有"按真 R2 delimiter 语义"的列举用例)、上传前端(2.4.0~2.4.4: XHR upload.onprogress 顺序上传 + 重试/跳过 + 两个文件夹入口 + 按钮文案"选择文件/选择文件夹" + 隐藏 input + 目标路径下拉(根目录/本入口根/现有目录/手动兜底) + 开跑前校验)、页面内联脚本语法(2.4.2: 模板字符串生成 <script>，逐段 new Function 解析)、滚动加载(2.4.1: 素材库页去上一页/下一页并接上 AdminListLoader、行片段端点与首屏同源取数渲染、带筛选翻页不串参数、越界行片段回空串、非超管拿不到行片段、笔记页去掉跳页控件而其它页保留、listFoot/pagerScript 的 jump 开关)、桶浏览器(2.4.6: checkObjectKey 的对象键校验、listLevel 逐层列举(真 delimiter 语义, 桩也实现了)、listUnder 目录级操作取数、removeObjects/copyObject/moveObject 泛化到任意键、逐层浏览+面包屑+上一级、层内筛选/排序/分页与统计条、详情页的对象键/所在层/ETag、改名·移动(任意前缀)/复制(不覆盖)、目录级移动 ≤10 与删除 ≤20 的确认与整批拒绝、非超管 403)、引用判定(来源清单/含回收站/列表列与查看引用一致/粗筛 SQL 能被 `node:sqlite` 真解析)、管理页查询并发(延迟 15ms 看并发峰值)、标题列固定宽度与样式生成物、正文编辑器(容器与资源引用、回显转换、新目录素材进出库)、笔记预览与编辑页(结构/类名/原图地址/字段顺序/统计卡)、列表页状态筛选就地隐藏、素材目录(新旧目录列举、引用判定、历史 _thumb 对象照列、各页图标)、媒体直出与 R2 绑定名
- 2.5.0 新增的覆盖：列表骨架（7 个列表页改走 `listController` 之后，各页的分页边界、筛选参数与"首屏取够再裁"的行为仍逐页守住）、幂等防重（`onceOrError` 命中拒绝、非重复放行、会话 id 入键）、三处页面脚本落地成 `static/js/*.js`（逐份 `new Function` 可解析 + 页面里只剩引标签与配置注入）。
- `node tools/live_smoke.mjs`：真实库结构与数据下的对外接口端到端（后台改动不该影响它）。
- 浏览器实测：可以用内存桩起一个本地预览服务（把 `handleAdmin` 接到 `http.createServer`），
  用 playwright 逐页看渲染与响应式 —— 注意会话 Cookie 的 `Secure` 只在 https 下发，所以 http 预览也能正常登录。
