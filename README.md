# api-cf：对外 API（Cloudflare Workers + D1 + R2）

按 `Plan.md` 实现的对外 API（**不含管理功能**），33 条接口。零运行时依赖：只用 Web 标准 API + D1/R2 绑定。

> **要部署请看 `DEPLOY.md`**（网页端 Git 连接 / wrangler 命令行两条路线，含建库、建表、搬迁、素材、验证与回滚）。本文件讲本地怎么跑。

```
main.js                  入口(对照旧站 fastapi/main.py): 只做装配 —— 中间件 + 路由 + 媒体直出 + 异常兜底 + 定时任务
app/                     全部业务代码, 与 fastapi/app/ 逐层对应
├── api/                 对外接口(33 条): user / news / content / app_config / pages / service_status
│                        + helpers(鉴权与身份, 对照 fastapi/app/api/helpers.py)
│                        + schemas(参数口径常量与夹取, 对照 fastapi/app/api/schemas.py)
├── core/                平台能力(对照 fastapi/app/core/):
│                        config(配置唯一来源) / middleware(安全头·CORS·预检·请求体上限) / response(5 种响应形态)
│                        / logging(结构化日志+脱敏+审计) / db / router / health / metrics / ratelimit
│                        / storage(R2 素材) / overview(统计口径) / media_scheme / sanitize / wechat / timeutil / html / md5
├── admin/               管理后台(/admin 前缀): 见 admin/README.md
│   ├── index.js         入口分发 + 写路径分类守卫 + 会话
│   ├── pages/           各页面模块(每个模块导出 routes)
│   ├── lib/             entities(权限清单) / controlled(声明式 CRUD) / dbTool(数据库工具安全内核)
│   │                    / mediaUpload / partials / layout / nav / guard / session / password …
│   ├── assets/          生成物: 旧站 CSS/JS 的文本模块(Worker 与 Node 都能 import)
│   └── static/          旧站静态原件(生成来源与对照)
└── sql/                 D1 建表脚本(0001 业务表 / 0002 限流 / 0003 微信 token / 0004 管理员)
tools/                   导出、行数校验、对拍、真实数据冒烟、素材小抄、区域查询/新建
tests/                   node --test 用例(255 条), 用函数桩模拟 D1/R2, 不联网
```

> 改代码时的边界：**对外口径改 `app/api/` + `app/core/`，后台改 `app/admin/`**；`app/admin/` 只通过 `/admin` 前缀对外，不进 33 条路由表。
> `fastapi/` ↔ `app/api-cf/` 的逐目录对应关系见 `notes/structure-map.md`。

## 一、首次准备（都在你机器上执行）

```bash
# 0. 命名约定(固定不变): Worker/Pages = lyjxxapp-api ; D1 = lyjxxapp-d1 ; R2 = lyjxxapp-r2

# 1. 建库: 首次部署可交给 wrangler 自动建(wrangler.toml 里 database_id 留空), 部署后把控制台的 Database ID 回填
#    也可以先手动建: wrangler d1 create lyjxxapp-d1 → 把返回的 database_id 填回 wrangler.toml
#    控制台建库时 Location 选 Asia Pacific(亚太): 该位置建库后不可改

# 2. 建 R2 桶(Location 同样选 Asia Pacific)并绑定公开域 storage.250036.xyz(自定义域在控制台加)
#    绑定名固定 STORAGE(见 wrangler.toml 的 [[r2_buckets]])
wrangler r2 bucket create lyjxxapp-r2

# 3. 微信凭据: 编辑 .secrets.json(模板 .secrets.json.example), 然后一条命令推上去
npm run secrets:put
#    联调时可把 wrangler.toml 的 DEV_WECHAT_MOCK 改成 "1", 走假 openid, 不调微信

# 4. 建表(三段都要跑; 用 npm run schema:remote 一条命令等价)
npm run schema:remote

# 5. 搬数据(旧库只读不动; 切换前重跑一次)
python tools/export_sqlite.py ../../fastapi/data/lyjx.db out/seed.sql
wrangler d1 execute lyjxxapp-d1 --file=out/seed.sql --remote
python tools/verify_counts.py ../../fastapi/data/lyjx.db     # 配了 D1 凭据会直接比对, 必须 0 差异

# 6. 搬素材(见 tools/media_to_r2.md), 注意 app/images 里的 4 个文件放 images/ 前缀
wrangler r2 object put lyjxxapp-r2/images/user.jpg --file=../../fastapi/app/images/user.jpg

# 7. 部署
npm run deploy
```

**变量与密钥都已预置好，你只需要改值**：

| 类型 | 放在哪 | 你要做什么 |
|---|---|---|
| 变量（明文） | `wrangler.toml` 的 `[vars]`：`MEDIA_BASE`、`DEV_WECHAT_MOCK`、`UPLOAD_MAX_BYTES`、`ENABLE_PUBLIC_PROBE`、`OBSERVABILITY_ENABLED`、`ALLOWED_ORIGINS`、`ENABLE_SQL_TOOL` | 需要改就改值 → 重新部署，部署时自动写进 Cloudflare，**不用去控制台手点** |
| 密钥（密文，生产） | `.secrets.json`（模板 `.secrets.json.example`）：`WECHAT_APPID`、`WECHAT_SECRET`、`ADMIN_SESSION_SECRET` | 填值 → `npm run secrets:put`（= `wrangler secret bulk`）一条命令推三个 |
| 密钥（密文，本机） | `.dev.vars`（模板 `.dev.vars.example`）：同样三个 | 只给 `npm run dev` 用；**两个文件都要填，互不替代**（一个管本机、一个管线上） |
| 绑定 | `wrangler.toml`：D1 `DB` → `lyjxxapp-d1`、R2 **`STORAGE`** → `lyjxxapp-r2` | 只需先把库与桶建好（`wrangler d1 create lyjxxapp-d1` / `wrangler r2 bucket create lyjxxapp-r2`）；代码侧只读 `core/config.js` 的 `storage`（兼容早期绑定名 `MEDIA`） |

## 二、本地开发与自测

```bash
npm run schema:local   # 本地 SQLite 建表(0001+0002+0003 中的前两个 + 0003 按需)
npm run dev            # wrangler dev --local, 默认 http://127.0.0.1:8787
npm test               # node --test, 255 条用例, 不需要网络与云账号
```

手工验收（`wrangler dev` 起来后，把 33 条逐条打一遍；`/news/list` 要同时试带 `page` 与不带 `page`）：

```bash
curl -s 'http://127.0.0.1:8787/news/list'
curl -s 'http://127.0.0.1:8787/news/list?page=1&page_size=2'
curl -s 'http://127.0.0.1:8787/content/get_banners?format=json'
curl -s 'http://127.0.0.1:8787/config/get_app_config'
curl -s 'http://127.0.0.1:8787/health/ready'
curl -s 'http://127.0.0.1:8787/?format=json'
curl -s -X POST 'http://127.0.0.1:8787/user/login' -H 'content-type: application/json' \
  -d '{"login_type":"wechat","code":"dev-code","nickname":"测试"}'
```

## 二·五、真实数据端到端验证（切换前建议跑）

```bash
# 1) 先把旧库导出成种子(会写到 out/seed.sql)
python tools/export_sqlite.py ../../fastapi/data/lyjx.db out/seed.sql
# 2) 用真实 18 张表结构与真实数据, 在内存库里跑一遍全部关键流程(不联网、不动线上)
#    需要 Node 22+(用到内置 node:sqlite)
node tools/live_smoke.mjs
```

覆盖：列表/详情/点赞(含重复 403 与计数自增)/配额 429 与计数表/轮播/专题/公告/配置/用户资料/三个列表/登录注册/改资料/注销(半角后缀)/已注销登录 409/恢复/彻底删除/静态页/探针。
它比 `tests/` 里的桩测更狠：**SQL 会真跑**，列名写错、唯一索引冲突、`ON CONFLICT` 行为这类问题当场暴露。

## 三、新旧站对拍（切换前必做）

```bash
node tools/diff_api.mjs --old https://api0.250036.xyz --new http://127.0.0.1:8787 --token <测试账号token>
```

逐条比对同一请求在两个站上的 JSON（字段、类型、`code`/`msg`/`message` 键、分页字段），只打印差异。**有差异就必须先改到一致**，否则上线后小程序会表现异常。

## 四、响应形态的坑（已实现，别改坏）

| 接口 | 特例 |
| --- | --- |
| `/news/list` | 不带 `page` 时**只有 `{code,data}`**，没有 `msg` |
| `/content/get_banners` | `code=0`，且 `message` 与 `msg` 并存 |
| `/content/get_outdoor`、`/get_motorcycle` | `code+msg+status+message` 四键；非内部测试用户 **删掉 `video_url` 键**（不是置空），并带 `can_watch_video` |
| `/content/get_notices`、`/config/get_app_config` | 只有 `message`，没有 `msg`；notices 额外下发 `pageSize` |
| `/news/detail` | `author`/`author_nickname`/`is_admin` 三种情况按作者是否存在分别出现；正文图片补绝对地址 |
| `/news/get_comments` | `created_at` 截到分钟；不下发 `user_id`；`user_avatar` 是绝对地址 |
| 用户三个列表 | 时间字段转 **Unix 秒**；`has_more` 按"取回行数够一页"判定 |

## 五、已知差异与待确认（要新旧对拍复核）

1. **成功文案**：已按线上对拍改齐 `/apitest`（`API测试成功`）、`/content/get_outdoor`（`获取户外精选数据成功`）、`/content/get_motorcycle`（`获取摩旅精选数据成功`）、`/news/check_user_action` 的 404（`笔记不存在`）、`/` 与 `/health` 的文案/结构。
   仍待复核：`/news/like`、`/news/favorite`、用户三个列表的 `msg` —— 这些分支要带 `--token` 才能对拍（`diff_api.mjs` 的 POST 用例）。只影响提示文字，不影响数据。
2. **分享 3 秒去重**、**浏览量 60 秒去重**：旧站在进程内做，Workers 无进程内状态；浏览量去重我按"同用户 60 秒"实现，分享未做去重（每次都计数）。
3. **`access_token` 缓存**放 D1 表 `wechat_tokens`（不是 KV，不额外加绑定）。
4. **昵称送审**（微信 msg_sec_check）：拿不到 token 或接口异常时放行，只有明确判定违规（87014）才拒绝。
5. **`/health` 的 `uptime_s` 固定 0**（Worker 没有进程概念）；`/health/ready` 返回裸结构，未就绪 503；`checks` 字段是 `database/media`（旧站是 `serving_cache/cache_backend`，Worker 无缓存概念）。
6. **`/metrics`** 仅在 `OBSERVABILITY_ENABLED=1` 时输出最小 Prometheus 文本（指标集比旧站小）。
7. **`/pages/download`** 是本次新增页面（旧站没有），文案可用 `app_texts` 的 `download.tip` 覆盖。
8. **素材目录分新老两套**：新上传按类型落 `image/`（图片）、`video/`（视频）、`avatar/`（小程序头像）；历史素材仍在 `news_uploads/`、`avatar_uploads/`。列举、引用判定与 Worker 直出**同时覆盖两套**（真值在 `app/core/storage.js` 的 `MEDIA_PREFIXES` / `SERVED_PREFIXES`），数据库里的相对路径一个都不用改、R2 对象也不用搬。**缩略图规则 = 目录随原图走**（`image/a.png` → `image/_thumb/480/a.webp`，子目录扁平到 `_thumb/<宽>/`；历史 `news_uploads/a.png` → `news_uploads/_thumb/480/a.webp`，所以历史缩略图照旧命中、不用重生成）。Cloudflare 侧**只读不生成**：探不到就不下发 `image_thumb`、回退原图；新目录要补缩略图时用 `tools/thumb_plan.mjs` 算出期望 key（`--check` 报缺哪些），生成与上传由离线侧执行。旧站工具（`fastapi/app/core/storage.py::ensure_news_cover_thumb`）仍写死 `news_uploads/_thumb/`，**本次未改旧站代码**，差异见 `DEPLOY.md`「素材目录」节。
9. **`/images/*`、`/image/*`、`/video/*`、`/avatar/*`、`/news_uploads/*`、`/avatar_uploads/*` 都由 Worker 从 R2 直出**（旧站是 `StaticFiles` 挂载，同样支持 Range/206），所以 `app/images` 的 4 个文件必须上传，否则菜单图标会 404。
10. **素材对外域名 `MEDIA_BASE` 可填两种**：① R2 公开域 `https://storage.250036.xyz`（**推荐**，不经 Worker，不吃请求额度）；② Worker 域名 `https://lyjx.250036.xyz`（少维护一个域名，但每条图片/视频请求都算一次 Worker 请求）。换法只是改 `[vars]` 后重新部署，代码与数据都不用动。
11. **管理功能**：**已全量迁移**（17 个页面，含数据库工具与素材库治理；2.2.5 起「首页精选」并进「首页板块管理」，不再是独立页面），见 `app/admin/README.md`；仍未实现的是 ffmpeg（旧站也没有）与进程内缓存（先不加）。
12. **框架层状态码与旧站一致**：未知路由 = 真 HTTP 404（`{code:404,msg:"接口不存在"}`）、未捕获异常 = 真 HTTP 500、请求体 >5MB = 413、`/apitest` 关闭 = HTTP 404 + `code:404` + `接口已关闭`。**业务失败仍是 HTTP 200 + `body.code`**（这条是硬口径，别改）。
13. **CORS**：`ALLOWED_ORIGINS` 默认 `*`（与迁移前一致，小程序不带 Origin 不受影响）；填域名后只回白名单内的 Origin，且不启用 `allow-credentials`（旧站也是 `False`）。
14. **参数语义对齐**：`intOf` = 旧站 `intval`（`int(float(v))`、溢出夹 `±2^31`、非法回退）；`/news/list` 的 `page` 夹到 1000；`/content/get_notice_unread` 未登录回 **200 + `未登录` + 空数据**（旧站口径，不是 401）；请求体上限 5MB（旧站 `BODY_LIMIT_BYTES`），multipart 豁免。
15. **R2 绑定名是 `STORAGE`**（`wrangler.toml` 的 `[[r2_buckets]].binding`）：代码只从 `core/config.js` 的 `storage` 取值，那里兼容早期的 `MEDIA`；改绑定名时只改 `wrangler.toml` 一个字段。
16. **站点图标按真实格式下发**：`app/favicon.ico` 实际是 800×800 的 **PNG**（前 8 字节 PNG 魔数），所以响应与页面 `type=` 都声明 `image/png`；页面引用统一带 `?v=<内容指纹>`（`core/favicon.js` 的 `FAVICON_HASH`）—— 浏览器按**站点**记"有没有图标"，不带指纹就换不掉内联之前 404 留下的旧结论。
17. **弹窗类静态脚本由外壳统一引**：`image_upload.js`（弹窗里「上传」走 XHR + 回填字段）与 `media_library.js`（素材库弹窗拉列表 + 回填字段）在 `app/admin/lib/layout.js` 的 `MODAL_SCRIPTS` 里统一引入。旧站是 `_image_upload_field.html` / `_media_library_modal.html` **各自**带 `<script src>`，而 `partials.js` 只渲染弹窗的 HTML（不带标签）——漏引时的表现是"点上传整页刷新、素材库弹窗空白"，且**服务端直出的 `/admin/media_manage` 照常正常**（因为它不依赖脚本），很容易误判成后端问题。两个脚本都自带幂等守卫（`window.__imageUploadBound` / `window.__mediaLibraryBound`）；`tests/admin_submit_action.test.mjs` 里有一条"资源包里不许有孤儿脚本"的检查防止再漏。
18. **正文富文本编辑器 = 自托管 wangEditor v5.1.23**（与旧站同版本、同初始化逻辑，但资源不走 CDN）：源码在 `app/admin/static/vendor/wangeditor/`（与旧站 CDN 上那份逐字节相同），随 `tools/embed_admin_assets.mjs` 打进生成物，编辑页按 `style.css → index.js → js/news_editor.js` 顺序加载；资源缺失或初始化抛错时回退普通文本域并在页面上告警，编辑页不会打不开。内容格式不变（图片存相对路径、视频存 `<wx-video>`；编辑器的 `data-w-e-*` 与容器在入库前清掉）。另两处与旧站一致的坑已在 `news_editor.js` 里处理：① 回显时把顶层图片各包一层 `<p>`、保存时拆回（wangEditor 解析"顶层图片+视频"会丢图甚至报错）；② 插入改为"插完校验、失败重聚焦重试"（编辑器对失效选区是静默失败）。顺带把 `newsContent.js` 的站内素材前缀从"只有 news_uploads/avatar_uploads"改成引用 `core/storage.js` 的 `MEDIA_PREFIXES`，新目录（`image/`、`video/`）的素材进出库也能正确来回转换。
19. **笔记的预览页与编辑页按旧站结构对齐**：两页共用 `admin.css` 的「小程序尺度统一层」（`.mp-frame` / `--mp-w=800px`），所以**预览所见 = 编辑所见**。
    · 预览页（`/admin/news_preview`）按旧站模板重建：`.mp-preview.mp-frame` + `.mp-card`/`.mp-meta`/`.mp-chip`/`.mp-author`/`.mp-video`/`.news-content` + 两个居中返回按钮；正文管线是"净化 → `wx-video`→`<video>`（绝对地址）→ 图片绝对化 → **正文配图换 800px 缩略图**"（`core/media_scheme.js` 的 `previewBodyThumbs`/`previewThumbUrl`，探不到就回退原图；只给只读的预览页用，**不要**用在编辑页，否则会把缩略图路径回存进正文）；只读、不加前台浏览量。
    · 编辑页（`/admin/news_edit`）改成旧站的单列布局（`col-lg-8 mp-frame` 居中，不再用两列的 `editShell`）：字段顺序 标题→分类→封面→视频地址→摘要→正文，正文下方是「发布设置」卡（立即显示/发布时间/活动时间/保存/返回）与「数据统计」卡（仅编辑已有笔记时显示）。
    · 三个带状态筛选的列表（笔记/留言/公告）补上了 `data-status-filter-param="status"`，行内改状态后不再匹配当前筛选的行会**就地隐藏**（旧站行为，原先 CF 侧这段判断是死代码）。
    · **有意不"补"的差异**见 `DEPLOY.md` 的「与旧站的差异（有意为之）」节（如 2.1.4 按需求裁掉的用户笔记审核、未迁的 SQL 工具等）。
20. **D1/R2 的区域（Location）建后不可改，而且不能靠"自动创建"**：`wrangler.toml` 里 `database_id` 留空、R2 桶不存在时，首次部署会被 wrangler **自动补建** —— 自动创建**不带 location hint**，落到账号默认区域（本项目拿到的是西欧）。D1 的 primary location 与 R2 的 location hint **建完就改不了**，只能"新建一份 + 迁数据 + 改绑定"，步骤见 `DEPLOY.md`「区域（Location）与资源重建」。查现状：`node tools/cf_region.mjs report`（需 `CLOUDFLARE_API_TOKEN`）或控制台的 Location 列；`wrangler.toml` 注释与 A2/A3 步骤已改成"必须手动建 + 回填 ID"。区域只影响往返延迟，**不影响功能正确性，也不需要改任何代码**。
21. **五个管理页的筛选控件统一**（留言管理是基准）：留言管理 `?status=`、笔记管理 `?category=`、专题管理 `?topic=`、首页板块管理 `?section=`、素材库管理 `?kind=image|video`，全部由 `app/admin/lib/partials.js` 的 `filterButtons` **一份实现**渲染 —— 结构与「留言管理」上那一组逐字一致：`.btn-group.btn-group-sm > a.btn.btn-outline-secondary`（当前项 `.active` + `aria-current="page"`）、外层卡片头部最左（`app_home` 没有列表壳，放在同构的一行里）。
    · **URL 行为也一致**：连"全部"也带参数（`?status=all` / `?kind=all` / `?section=all`），所以刷新、复制链接、浏览器回退都能定位到同一筛选态；参数名与取值按各页原有语义保留（不是统一成 `status=`）；触底加载与跳页（`infinite_scroll.js` 复制 `location.search`）自动带着这些参数，切筛选不带页码 → 回到第 1 页。
    · 笔记页的状态/关键词表单用 hidden `category` 把分类带过去（与专题页 hidden `topic` 同一手法），`?category=all` 等价于"全部分类"。
    · 历史：2.2.3 先统一成"URL 参数 + `.nav-pills` 胶囊"(当时只有专题/素材库/笔记三页)，2.2.6 按留言管理页的按钮组把外观与位置也统一，`pillFilter` 与其两条 `.nav-pills` 样式已删除；手机端在适配层给 `.btn-group` 加了 `flex-wrap`（Bootstrap 默认不换行，4 个以上标签会横向溢出），桌面端观感不变。
22. **素材引用判定必须"每个 `LIKE` 都带列名"，且失败不许静默**：`scanReferences` 的粗筛 SQL 由素材目录清单拼出，曾经拼成 `image LIKE ? OR LIKE ? OR LIKE ?`（后两个没有列名）→ SQLite 判语法错 → 被 `.catch(() => [])` 吞掉 → **引用列整列显示"未引用"**、连"删除前复查"也一起失效（2.2.4 修；桩测试按正则回数据，看不出语法错，所以补了"用 `node:sqlite` 真解析一遍粗筛 SQL"的用例 + 失败时 `console.error` 出来）。判定来源仍是 `pages/mediaGovern.js` 的 `scanReferences` **一处**：列表列 /「查看引用」/ 删除前复查共用它，笔记三列（`image`/`video_url`/`content`）+ 8 个其它来源（轮播/摩旅/户外/首页板块/首页精选/我的页菜单），回收站里的笔记同样算引用。用真实旧库（`fastapi/data/lyjx.db`）跑过：185 个被引用路径 100% 被认出来（修复前是 0/185）。
    · 判定是**等值比较规范化后的相对路径**（含大小写敏感）：真实数据里有 8 处引用写的是大写扩展名（`.JPG`/`.MOV`）。若当初上传 R2 时把文件名改成了小写，这几条仍会显示"未引用" —— **待确认**（要确认 R2 里的实际 key 大小写；真不匹配的话那几条引用本身就是坏的，图片会 404）。另有 8 处正文里的路径含空格（HTML 中截断）——真实数据里**没有**这种情况，未改抽取规则。
素材库页的"R2 列举 / 引用扫描（内部 9 条）/ 占用统计"
    · **2.2.8 补充（重要）**：`batch` 与 `Promise.all` 省掉的是 **HTTP 往返**；D1 对同一个库是**单线程串行执行**，语句在库侧仍要逐条排队。所以"把互不依赖的查询并发发出"只解决一半问题，**另一半（往往更大）是减少语句条数**：`db_tools` 就是这么改的（看某张表时不再统计全库行数、索引列一次读 DDL 本地解析、行数据按需取），页面从"看结构 39 条 / 看数据 41 条语句"降到 **8 条**。
24. **列表页的"标题/文件名"列是固定宽度**：`.cell-title { width/min-width/max-width: 360px }`（手机端 200px），里面套 `text-truncate` + `title="完整内容"`（悬停看全文）。360px ≡ 既有 `clamp-lg` 档 ≈ 25 个汉字；取值依据是同表其余固定列合计约 940px（封面 128 + 状态/计数/时间 + 操作列 ≥300），桌面 shell 满宽时仍有余量。不这么写时，超长标题会把其它列挤出去（`news_manage` 的标题列、`media_manage` 的文件列都会）。
25. **「首页精选管理」已合并进「首页板块管理」**（2.2.5）：`/admin/app_featured_manage` 的路由与侧栏菜单项都删了（老地址落到统一 404 页），原页面内容成为 `/admin/app_home_manage` 的第三块「精选项目」；切换沿用 2.2.3 的方式（`?section=main|ext|featured`，空 = 全部，`.nav-pills` 标签条 + `aria-current`，整页跳转）。三块内容的列头、行渲染、新增/编辑/删除入口全部来自 `app/admin/lib/homeSections.js` 的**唯一描述表**：主题/拓展 = `app_home_sections` 的两个 `section_key`（分类名实时取自分类表），精选 = `app_featured_items`（**表、字段、数据一个字都没改**；2.3.8 起编辑页也并进 `/admin/app_home_edit?section=featured`，删除仍走 `/admin/app_featured_delete` 与确认页 `kind=featured`）。写权限登记（两个删除端点仍是"登录即可"，编辑走 `/admin/app_home_edit`）、状态类型（`home_section`/`app_featured`）、对外接口（`/app_config` 仍读 `app_featured_items`）全都没变；唯一被改的关联入口是删除确认页的返回地址（改为 `?section=featured`）与分类删除页的那句提示文案。
26. **数据库工具（`/admin/db_tools`，2.2.7 增强、2.2.8 按"D1 单线程串行"重做一遍）**：表清单（行数走 D1 `batch` 一次往返；**只有"表清单"这一屏默认统计**，`?counts=0` 关掉、`?counts=1` 强开；表名可本地筛选、可一键复制）／表结构（列·类型·可空·**默认值·主键·索引及索引列**，可复制列名与建表语句；索引列改由**一次** `sqlite_master` 查询拿 DDL 后在本地解析，不再一条索引一次 `PRAGMA index_info`）／数据（`?sort=&dir=` 点列头排序、`?col=&val=` 按字段筛选、`?q=` 跨列关键字搜索、20|50 行一页、第一列是隐式 `rowid`、行尾按钮**按需取整行**后复制 JSON/INSERT 或生成 UPDATE 填进控制台）／SQL 控制台（常用语句快捷入口、执行历史存**本机 localStorage**（不上传、不改库）、结果表格化可翻页并复制 TSV/JSON、**显示 D1 用量 `读 N 行 · 写 N 行 · N ms` 用于成本估算**、写语句二次确认、**无 WHERE 的 UPDATE/DELETE 额外告警**）。安全边界没动：仍是"单条语句 + 白名单业务表 + DDL/事务/PRAGMA 一律拒绝 + 敏感列打码 + 超管 + `ENABLE_SQL_TOOL` 开关"，也**不做**行内编辑表单（只生成 SQL，写操作仍走被审计的 `exec`）与任何结构变更。**唯一口径调整**：执行失败时除统一文案外多回一句截断到 200 字的数据库原文（`detail`），因为它只给超管看、而"语焉不详的报错"是这一页最费时间的坑；原文同时进 Workers 日志与审计。容量/超时/写入速率这些 D1 平台限制与页面上的应对见 `DEPLOY.md`「D1 平台限制与页面上的应对」。
    · **2.2.7 的问题（2.2.8 修）**：那一版把三件事一起做了，结果是**语句数与页面体积双双上涨**（用真实旧库量化过）：① 打开**任何**一张表都先跑 23 条逐表 `COUNT(*)`（全表扫描，与当前操作无关）；② 索引列"一条索引一次 `PRAGMA index_info`"（`news` 9 个索引 = 9 条串行语句）；③ 把**整行 JSON 内嵌进 `data-row`**（`news` 带正文：20 行 = 139KB、50 行 = **269KB** HTML，其中 146KB 是这份内嵌数据），每次翻页都重传。2.2.8 的修法：统计按视图裁剪（看结构/看数据 = 0 条逐表 COUNT，只查当前表 1 条）、索引列一次解析、行数据**不内嵌**（点按钮才按 `rowid` 取那一行，同页缓存）→ 结构页 39 → **8** 条、数据页 41 → **8** 条、`news` 50 行页面 269KB → **125KB**，而且复制/生成 SQL 拿到的是**完整值**（不再是被截断的一份）。
    · **对外接口的变化（都只是可选参数，未新增路由、未改数据库字段）**：`GET /admin/db_manage/table` 的 `rowid=`（2.2.8，取单行完整数据）与 `rowids=1,2,3`（2.2.9，批量取行，一条 `rowid IN (…)`、上限 50）；不传时行为与之前完全一致。
    · **2.2.9「数据库管理页面」**：页面与菜单文案改成**数据库管理**（地址 `/admin/db_tools`、`/admin/db_manage` 与权限键 `currentPage=db_tools` 一个字没改），能力在 2.2.8 的底子上补了三块 ——
      (a) **字段总览**（新视图 `?view=columns`）：**一条** SQL（`sqlite_master JOIN pragma_table_info`）把全库"表 + 字段"列在一屏（真实库 23 表 / 189 字段 / **1 条语句**；`?table=` 只看一张表且不额外查库）；D1 若不支持这个表函数就回退逐表 PRAGMA，并在页面上如实写出当前取法（降级标记带 60 秒 TTL，不会因一次偶发错误永久退化）；
      (b) **单行查看与编辑 / 批量操作**：行尾"编辑"打开行内表单（敏感列不进表单、NULL 用勾选框表达、空串与 NULL 分开），保存即生成**一条** `UPDATE`、删除即一条 `DELETE`；行首复选框 + 全选 → 复制所选 JSON/TSV（一条 `rowid IN` 取数）与"删除所选"（一条 `DELETE … WHERE rowid IN (…)`，天然原子，不删一半）；结果就地刷新/移除，并回显**影响行数 + D1 用量**；
      (c) **成本可见**：新增「成本与额度」卡（账号用量**参考快照** + 本机会话累计（读/写/次数，存本机 localStorage，可清零）+ 这一页的省额度做法清单），数据页/接口响应都显示 `读 N 行 · 写 N 行 · N ms`；
      (d) **元数据缓存**：表清单/列/索引/建表语句/字段总览在 isolate 内缓存 60 秒（键为 D1 绑定对象；**行数不进缓存**，数据在变不能显示过期数字）—— 实测同一分钟内再点开结构视图从 6 条语句降到 **1 条**、字段总览降到 **0 条**（只读一次的任务几乎是零成本）；
      (e) **仍然一个写入口**：编辑/删除/批量删除**没有新增任何写接口**，都是前端按主键/rowid 生成一条 SQL 再 POST `/admin/db_manage/exec`（同一条安全内核：白名单业务表 + `confirm=1` + `无 WHERE` 告警 + 审计 + 用量回传）。路由登记数量与权限口径因此完全没变（对外 33 条路径 / 73 条方法组合，后台页面路由 70 条）。
27. **`route_super` 类写路径现在有两道闸**：`app/admin/index.js` 分发前按 `entities.js` 的清单拦一道（原先只靠页面自查，管理员页漏了自查 → 任何登录账号都能增删管理员/重置口令），页面内仍可再自查。
28. **页头不再有"返回控制面板"按钮**（2.3.1）：全站排查过一遍，页面内容区里指向 `/admin/dashboard` 的按钮共 5 处，**全部删除**：管理员设置页那张只放一个按钮的卡片（整张 card 删掉）、系统信息页底部那排按钮里的"返回控制面板"（同排的"查看实时时钟脚本"保留）、数据库管理页与素材库管理页页头的 `actions: backButton('/admin/dashboard')`、版本更新配置页 `editShell` 的 `backUrl/backLabel`。顺带修掉一个隐患：`editShell` 之前**无条件**渲染返回按钮，`backUrl` 为空时会吐一个 `href=""` 的死按钮，现在改成"给了地址才渲染"。
    · **没动的**（逐一核对过跳转目标）：各编辑页/删除确认页的"返回列表"（目标是各自的列表页）、笔记预览页居中那两个"返回编辑/返回列表"、素材库删除页的"返回素材列表"、以及**外壳里的侧栏导航** —— 侧栏 logo（`<a class="brand" href="/admin/dashboard">`，只去掉了它 title 里的"返回控制面板"文案）与「控制面板」菜单项都保留：它们是应用导航，不是页面里的返回按钮；删掉会真的断掉回控制面板的路。回控制面板的入口现在有：侧栏菜单项、侧栏 logo、登录后自动跳转（以及非超管/无效请求的错误重定向）。
    · 回归用例在 `tests/admin_sidebar_menus.test.mjs`：四个页面渲染后**内容区**不再含 `href="/admin/dashboard"`、页面里不出现"返回控制面板"字样，且"没给 backUrl 的 `editShell` 不渲染返回按钮 / 给了就照旧渲染"。

29. **列表页"新增"按钮与编辑页骨架各只有一份实现**（2.3.2，只动样式与布局，功能/字段/提交逻辑/路由/权限全未动）：
    · **列表页按钮**：抽出 `partials.addButton(url, label, extraClass)`（`btn btn-primary` + `bi bi-plus-lg` + 文案），
      8 处"添加/新增/发布"全部改用它 —— 轮播图 `添加轮播图`、我的页菜单 `添加菜单项`、运营文案 `添加文案`、
      分类管理 `添加分类`、通知公告 `添加公告`、专题精选 `新增摩旅路线|户外活动`、笔记管理 `发布笔记`，
      以及首页板块管理里每块的 `添加入口` / `添加精选`（靠右用 `extraClass=' ms-auto'`）。
      位置本来就是一致的（都在列表卡片顶部 `d-flex flex-wrap align-items-center gap-2 mb-3` 工具条里，与筛选组同排）；
      这次真正改掉的是首页板块那两处：原来用 `btn-sm`（比别处小一号），现在与其它页**同尺寸**。
      顺带修一个隐患：`lib/homeSections.js` 的 `addUrl` 里原本写的是 `&amp;`（提前转义），改由 `addButton` 统一
      `escapeHtml` 后会被**二次转义**成 `&amp;amp;` → 链接失效，现在改回写裸 `&`（回归用例里有断言）。
    · **编辑页骨架**：`partials.editShell` 重写为与 `news_edit` 同一套骨架 —— 外层仍是 `<div class="card">`，
      里面改成 `row g-3 justify-content-center` + `col-lg-8 mp-frame`（宽度 = `--mp-w` = **800px**、水平居中，与
      笔记编辑页/预览页同一"小程序尺度"），设置项从**右侧栏**收成一张"发布设置"卡放在字段**下面**，保存/返回按钮都在
      卡内 `d-grid gap-2`；页面级提示（`top`，目前只有分类页的"改标识"警告）跟着字段同列，与表单对齐。
      受益页面（全部走 `editShell`）：轮播图、我的页菜单、运营文案、分类管理、通知公告、专题精选（摩旅/户外）、
      首页板块入口、首页精选、版本更新配置；笔记编辑页本身就是这套骨架（未改）。手机端不用额外适配：
      `.mp-frame` 自带 `max-width: 100%`，窄屏随屏收缩（与改动前一致）。
      复用的 `.mp-frame` 只取它的"宽度 + 居中"两条规则 —— 手册式字号缩放都在 `.mp-title`/`.mp-meta`/`.mp-frame-hint`
      那些类上，配置类编辑页不会跟着变字号（`admin.css` 未改动一个字节）。
    · 回归用例在 `tests/admin_pages_config.test.mjs`：7 个列表页 + 首页板块 2 个按钮**逐字**等于 `addButton()` 输出、
      按钮都在工具条里、首页板块不再出现 `btn-sm`、链接无二次转义；10 个编辑页都含
      `row g-3 justify-content-center` + `col-lg-8 mp-frame`、**不再有** `col-lg-4` 右栏、且设置卡标题与主按钮文案逐页核对。
30. **列表页头部改成"固定三行"**（2.3.3；2.3.2 的"统一按钮位置"其实没改到位置，见下面的复盘）：
    新增共用结构 `partials.listToolbar({ primary, filters, search, meta })`，**三行的职责与 class 只写一处**，
    `listShell` 与手写卡片的页面都调它：
    · **第一行 `primary`**：新增/发布按钮（`addButton()`，`btn btn-primary` + 对应图标）＋ 附带动作（笔记页的「回收站」、
      我的页菜单页的「补齐内置菜单项」），右侧仍是原有的统计条（`ms-auto`）；
    · **第二行 `filters`**：分类/状态筛选标签条（`filterButtons()` 生成的 `.btn-group.btn-group-sm`，
      参数名与取值**保留各页原有语义**，不照抄笔记页的分类）；
    · **第三行 `search`**：搜索/筛选表单（关键字 + 状态下拉 + 搜索按钮）。
    没传的行**不渲染**（不留空行）；只有一行的页面也走这里，class 与间距一致。
    **本次改动的 4 个页面**（原来都是"标签条 + 新增按钮 + 搜索表单"挤在同一行 `flex-wrap` 里）：
    笔记管理（发布笔记 + 回收站 / 分类标签条 / 状态+关键字表单）、专题精选（新增摩旅/户外 / 专题标签条 / 搜索表单）、
    通知公告（添加公告 / — / 关键字+状态表单）、运营文案（添加文案 / — / 分组筛选表单）。
    **本来就是单行的 3 个页面未动**（轮播图、我的页菜单、分类管理：只有第一行，走 `listToolbar` 后 class 与位置不变）。
    · **不在本次范围**（这几页没有 `_edit?id=0` 新增按钮，按需求只改"有新增按钮的列表页"）：用户管理（搜索表单在第一行）、
      留言管理（只有状态标签条）、素材库管理（标签条 + 表单）、笔记回收站（只有搜索表单）、数据库管理页。
      若希望它们也套三行结构，说一声（**待确认**）。
    · **首页板块管理的判断**：它没有页面级新增按钮（三个板块各有自己的「添加入口/添加精选」），
      页面级的板块标签条本来就已经是独立一行（= 行 2 的位置）—— 2.3.3 当时**未改**；
      **2.3.7 按同一条规则补齐**（把三个板块的新增按钮提到页面第一行，见第 35 条）。
    · **回归用例**：`listToolbar` 的三行顺序/缺行不渲染/只有统计也出行；四个页面的"新增按钮在最前、标签条在其后、
      搜索表单再往后"逐页断言。真实 Chromium 视觉核对（1400px 桌面 + 390px 手机，16 项全过）量的是**几何位置**：
      笔记页 新增 208 → 标签条 224 → 表单 271（`bottom` / `top`）、专题页 143 → 159 → 206，
      两页新增按钮与其它行**左对齐**（x 都是 286），单行的轮播图页确认只有一行、不多空行，手机端三行不横向溢出。
31. **复盘：2.3.2 的"统一按钮样式/位置"为什么等于没改**（这条写下来免得再犯）：
    · 2.3.2 只做了两件事：把 8 处新增按钮的**标记**收敛到共用宏 `addButton()`（`btn btn-primary` + `bi bi-plus-lg`），
      以及把首页板块那两处从 `btn-sm` 改成默认尺寸。**元素位置和所在容器一行没动** —— 那 7 个列表页的按钮本来就都在
      同一条 `d-flex flex-wrap align-items-center gap-2 mb-3` 工具条里，标签条与搜索表单也挤在**同一行**里靠 `flex-wrap`
      换行；所以屏幕上看到的东西**完全一样**，被判失败是合理的。
    · 测试也帮不上忙：2.3.2 的用例断言的是 `html.includes(addButton(...))`（**标记**逐字相同）与"按钮在工具条行里"，
      它永远不会因为你把标签条挪到另一行而变红 —— **断言了实现细节，却没断言用户看到的结构**。2.3.3 因此改成断言
      "三类元素的**相对顺序**" + 浏览器里量**几何位置**。
    · 也不是"没部署"：线上 `/health/ready` 当时回的就是 `version: "2.3.2"`（已确认），部署是成功的 —— 改的东西视觉上不可见而已。
      （顺带确认：这条结论的取证方式是 curl 线上版本 + 本地渲染比对，不是猜。）
32. **搜索区（输入框 / 下拉框 / 搜索按钮）全站统一到一份实现**（2.3.4）：新增共用宏
    `partials.searchBar({ action, hidden, body, extra })` + `searchInput()` + `searchSelect()`，
    结构固定为 `form.search-bar.d-flex.flex-wrap.align-items-center.gap-2` + `select.form-select-sm`
    + `input.form-control-sm` + `btn.btn-sm.btn-outline-secondary`（`bi bi-search` + 「搜索」）。
    **盘点结果（统一前各页各写一套，逐项差异都不同）**：
    · 换行：4 个页面的表单**没有** `flex-wrap`（专题精选、运营文案等），窄屏会挤压错位；3 个页面有。
    · 垂直对齐：只有素材库/数据库管理两页写了 `align-items-center`。
    · 宽度手法：混用 `max-width:130/150/160/200/220px/14rem` 与 `width:12rem/10rem/auto` ——
      `max-width` 下输入框实际宽度取决于浏览器默认 `size`，`width:auto` 的下拉框宽度还会随最长选项变化，
      一排控件看着参差不齐。
    · 控件顺序：多数是"下拉 → 输入框"，通知公告/用户管理是"输入框 → 下拉"。
    · 按钮：图标 `bi-search`（7 处）与 `bi-funnel`（2 处）混用，文案「搜索」与「筛选」混用。
    · 高度：素材库弹窗里的筛选输入框还是**默认尺寸**（比页面搜索区高一档）。
    **统一后**（改动 9 处调用点 + 1 处弹窗）：控制顺序统一为"下拉 → 输入框 → 搜索按钮"，
    图标与文案统一为 `bi-search` + 「搜索」，宽度统一为**.search-input 12rem(192px)**、
    **.search-select 9rem(144px)**、选项很长的下拉用 `.search-select-lg`(12rem)，全部写在 `admin.css` 一处；
    各页只保留自己的参数名与取值（`?category=`/`?status=`/`?source=`/`?topic=`/`?trusted=`/`?search=`/`?group=`/`?col=&val=&q=`）。
    **高度为什么是 31px（桌面）/ 38px（手机）**：本地 bootstrap 5.3 里 `.form-control-sm`/`.form-select-sm`
    与 `.btn-sm` 都是 `font-size:.875rem; padding:.25rem .5rem; border:1px` → `1.5×14 + 8 + 2 = 31px`，
    桌面端本来就等高；而本项目 `admin.css` 的**手机端触控层**把 `.btn-sm` 抬到 34px、sm 输入框是 38px
    （差 4px 就会"按钮矮一截"），所以只在手机层补一条 `.search-bar .btn{min-height:38px}` 把按钮拉回同高
    （38px 仍高于"小按钮 ≥34px"的触控底线）。
    **换行规则（明确并一致）**：桌面端一行（`flex-wrap` 兜底，超长时才换行）；
    `≤767.98px` 每个控件**独占一行**（宽度铺满，与手机适配层既有的「筛选条每项一行」同一策略），
    三档都实测过：桌面 7 页控件 31px 等高/同一行/宽 192·144px；手机 390px 全部 38px 等高、逐行排列、
    不横向溢出；素材库弹窗那一行桌面 31/31、手机 38/38。
    · **只动样式与布局**：字段名、参数取值、提交方式（`method="get"`）、隐藏字段（笔记页的分类、专题页的 topic、
      素材库的 kind、数据库管理的 table/view/size/sort）与路由权限全部未变（对外仍 33 条路径 / 73 条方法组合）。
      素材库页顺手把"标签条与搜索条"拆成两行（原来挤在同一行，窄屏互相穿插），与其它页的三行结构一致。
    · **保留的例外（有意为之）**：数据库管理页表头那个"用这一列筛选"的**链接**仍用 `bi-funnel`
      （它是跳转链接、不是搜索提交按钮，漏斗更达意）；"每页 N 行"的选择器不属于搜索区（无输入框、无提交按钮，
      `onchange` 自动提交），未纳入统一。
    · **守卫**：`tests/admin_pages_config.test.mjs` 新增 4 条 —— 共用宏的结构/类名/按钮三统一断言；
      7 个页面的搜索条逐个断言"有且只有一条、参数与 placeholder 不变、没有 `max-width`/`width:auto`/漏斗图标"；
      **源码扫描**：`app/admin/pages/*.js` 里不许再出现 `type="search"`、`bi bi-search` 或 `max-width` 定宽，
      且 7 个页面必须调用 `searchBar()`；CSS 规则与 `assets/static-assets.js` 生成物同步断言
      （改 `static/**` 必须重跑 `tools/embed_admin_assets.mjs`，否则线上拿到的还是旧样式 —— 这是 2.3.2 教训的另一半）。
33. **分类一律只显示名称**（2.3.5；原来多处是「名称（标识）」，运营看着啰嗦，标识只有排查时才需要）：
    · **筛选标签条**（`/admin/news_manage` 第二行那个 URL 参数切换的按钮组）：`户外（outdoor）` → `户外`，
      `摩旅（motorcycle）` → `摩旅`；**取值与 URL 参数不变**（`?category=outdoor`、选中态 `aria-current="page"`、
      切换/联动照旧 —— 标签本身是 `<a href>`，没有 JS 参与）。
    · **列表「分类」列**：笔记管理（`/admin/news_manage`）与笔记回收站（`/admin/news_recycle`）原来**直接显示标识**
      （`outdoor`），现在显示名称（`户外`）；未知/已删除的标识由 `nameFor` 回退成标识本身（便于发现历史脏数据，
      与预览页同一口径）。
    · **一处改动覆盖多页**：`lib/categorySource.js` 的 `optionsForSelect()` 标签由 `${name}（${key}）` 改成 `${name}`，
      于是"笔记编辑页的分类下拉 + 首页板块管理（主题/拓展入口）的编辑下拉 + 上面的筛选标签条"同时统一；
      `pages/categories.js` 里"删除分类 → 把笔记迁移到"那个自建的同类标签也一并改成只显示名称。
    · **成本**：笔记列表页的名称映射直接复用**已有的**那条分类查询结果（`Object.fromEntries`，**0 条额外语句**）；
      触底加载片段与回收站页各多 1 条 `getNameMap`（放在原有并发里，不多等一次往返）。
      ⚠️ 保留 `key（已停用或已删除）` 那条兜底项 —— 那种情况下没有名称可用，只能显示标识 + 状态。
    · **有意保留**（不是漏改）：分类删除确认页的标题「名称」（`<code>标识</code>`）与「分类管理」列表的**分类标识**列 ——
      这两处的标识就是"要管理/要删除的那个对象"本身；`appMenu` 的 `key（label）` 与分类无关。
    · **已知取舍**：若建了两个同名不同标识的分类，标签条/下拉里显示的字样会一样（标签条本身按标识跳转，
      功能不受影响；要分清标识请到「分类管理」页）。
    · **用例**：新增 1 条（标签条/列表列/编辑下拉/回收站/迁移下拉共 5 个断言点）并更新 2 条旧断言；
      真实旧库核对：标签条渲染为 `全部分类 | 户外 | 集 | 摩旅 | 健身 | 滑板 | 足球 | 游泳 | 潜水 | 聚餐 | 其它`，
      列表「分类」列与编辑页下拉（`<option value="outdoor" selected>户外</option>`）都只出名称。
34. **列表"上划加载"在带 URL 参数时必须用同一套参数**（2.3.6 修线上 bug）：
    · **根因**（不是猜的，两层证据）：`news_manage`/`comments_manage`/`users` 三个页面下发给前端的
      `rowsUrl` **自带当前查询串**（`/admin/news_manage_rows?category=outdoor`），而 `infinite_scroll.js` 的
      `loadNext()` 又按 `location.search` 拼了一个 `?`，于是请求变成
      `/admin/news_manage_rows?category=outdoor?category=outdoor&page=2` —— **第一个 `?` 之后的整串被吞进
      `category` 的值里**，后端收到的是 `category='outdoor?category=outdoor'`，一行都查不到 →
      行片段为空 → 前端按"没有数据了"处理，显示「已全部加载」并什么都不追加
      （用户看到的就是"带参数后上划加载失败"）。不带参数时 rowsUrl 没有查询串，所以从来不触发 —— 与现象吻合。
      真实旧库实测：`category='outdoor'` **16 行**，`category='outdoor?category=outdoor'` **0 行**。
    · **修法（一处根因 + 三处止血）**：`loadNext()` 只取 `rowsUrl` 的**路径部分**
      （`opts.rowsUrl.split('?')[0]`），查询参数一律以 `location.search` 为准；三个页面同时把 `rowsUrl`
      改成纯路径（`/admin/news_manage_rows` 等，并删掉只为此存在的 `query` 变量），让"rowsUrl 只给端点"成为明确契约。
    · **影响范围**：`news.js`（含触底片段）、`comments.js`、`users.js` 三个页面此前都带查询串、都有这个问题；
      `notice_manage`/`banner_manage`/`topics_manage`（`config.rows` 本来就是纯路径）不受影响，行为不变。
    · **验证**：真实旧库 + 真实 SQL + 真实 handler 端到端 —— `?category=outdoor` 首屏 10 行（`103,38,…,31`）、
      第 2 页 6 行（`30,28,27,26,7,73`），**累计 16 行、去重后 16**（不重复、不跳回第一页、筛选没丢）；
      修复前的拼法请求同一端点 → **0 行**；不带参数时第 2 页照旧 10 行（原行为不变）。
      另外把 `infinite_scroll.js` 直接放进测试里跑（它只依赖 `window/document/fetch`），断言"地址里只能有一个 `?`"、
      "带着 category 与 page=2"、"追加一次第二页的行"、"页码前进"；并断言 7 个列表页下发的 `rowsUrl` 一律不含 `?`。
    · ⚠️ 静态脚本被内嵌进 `assets/static-assets.js`，本次已重跑 `tools/embed_admin_assets.mjs`
      （否则线上跑的还是带 bug 的旧脚本）。
35. **首页板块管理的头部补齐成 news_manage 那样**（2.3.7；2.3.3 时这一页被明确"待确认"留下了）：
    · **改了什么**：`/admin/app_home_manage`（`?section=all|main|ext|featured`）的头部改成与笔记管理页同构的
      **两行**（这一页没有搜索表单，所以没有第三行）：**第一行 = 新增按钮**（`addButton`，`btn btn-primary` +
      `bi bi-plus-lg`，左对齐；当前可见的板块各一个 —— 「全部」视图给三个：主题/拓展的「添加入口」+「添加精选」，
      `?section=main` 只给一个），**第二行 = 板块标签条**（`filterButtons`，`.btn-group.btn-group-sm`、
      当前项 `.active` + `aria-current="page"`）。两行都用 2.3.3/2.3.4 的共用结构 `listToolbar` 输出，
      页面自己不再拼 class。板块卡片头部因此只留「板块名 + 共 N 条」。
    · **参数与联动没动**：参数名仍是 `section`，取值仍是 `all|main|ext|featured`；标签条本身就是 `<a href>`，
      切换/直链/刷新照旧；每个新增按钮的 href 仍带 `&section=`（表单预选对应板块），`?section=all` 与不带参数等价。
    · **与 2.3.3 的关系是"延续"不是"改写法"**：2.3.3 定了"新增按钮第一行、标签条第二行"这条规则，
      当时因为这一页的按钮长在各自卡片里而没有改；2.3.7 只是把同一规则应用到位，`listToolbar`/`addButton`/
      `filterButtons` 三个共用实现都没改一行。**与 2.3.4（搜索区）无关**：这一页没有搜索条。
    · **编辑页按钮本来就已经统一**（2.3.2 的成果，本次未动；2.3.8 又把这两个编辑页并成了一个，见第 36 条）：
      两个编辑页走同一份 `editShell`，主按钮逐字一致 —— `<button class="btn btn-primary" type="submit">` +
      `<i class="bi bi-check-lg">` + 文案（添加入口 / 添加精选），下面跟同款的「返回列表」；测试里逐字比对过。
    · **容器差异（有意保留）**：笔记管理页的三行在**列表卡**里（卡片内边距 18px），首页板块管理页的头部两行
      **直接放在内容区**（2.3.3 之前这里本来就是裸的标签条行，本次没给它加卡片）。所以两页的按钮**绝对左缘差 18px**，
      但"第一行与第二行左对齐"这条口径两页一致（实测 news 286=286、appHome 268=268）。
      若要求连容器都一样（给头部套一张卡），说一声即可（**待确认**）。
    · **视觉核对**（桌面 1400 + 手机 390，28 项全过）：appHome 新增按钮 `bottom=125` → 标签条 `top=141` → 卡片 `top=188`
      （第一行 → 第二行 → 内容），按钮高度与 news_manage 一致（均 38px）；手机端不横向溢出、按钮 ≥40px 可点；
      编辑页主按钮在「返回列表」之上、两者等宽。
    · **用例**：`tests/admin_pages_config.test.mjs` 新增 1 条（四个 section 视图逐一断言"第一行逐字等于共用 `addButton`
      拼出来的那串按钮、第二行是唯一一条板块标签条、新增按钮排在标签条之前、当前 section 选中态正确、
      卡片头部不再有靠右的新增按钮"），并更新 2.3.2 的首页板块断言（原来断言带 ` ms-auto`，现在不该再有）。
36. **首页内容的三个编辑入口与三个编辑页也合并成一个**（2.3.8；2.3.7 那次只合并了列表页的按钮位置）：
    · **三个页面的字段差异（合并前逐个读过）**：
      | | 主题项目 / 拓展项目（`app_home_sections`） | 精选项目（`app_featured_items`） |
      |---|---|---|
      | 板块 | `section_key`（下拉：main/ext，同一张表内可改） | 无（表的归属即"精选"这一块） |
      | 分类 | `item_id` **必填**，必须是「分类管理」里**启用中**的分类 | 无 |
      | 名称 | 不可编辑：写入时由分类名派生（分类改名后自动跟随） | `name` **必填**，手填 |
      | 标识 | 无 | `item_key` **必填** + 格式（`^[a-z][a-z0-9_]{0,39}$`）+ 本模块内唯一 |
      | 图片 | `image_url` 必填 | `image_url` 必填 |
      | 跳转页面 | 无 | `page_path` 必填 |
      | 排序 / 启用 | `sort_order` / `status` | 同（唯一的两个共用字段） |
    · **合并方式**：一个页面 `/admin/app_home_edit`，**类型由 `?section=` 决定** —— `main|ext` → 板块入口字段集、
      写 `app_home_sections`；`featured` → 精选字段集、写 `app_featured_items`。两套字段集不混排（不做"JS 显示/隐藏"，
      服务器按类型直接渲染对应表单，校验与写入也各走各的分支），所以**不串改、也不丢字段**：
      合并后仍可编辑原来能编辑的每一个字段（见上表），主按钮文案与保存后的回跳（`?section=`）逐字照旧。
      · **参数**：沿用 `section`，取值仍是 `main|ext|featured`；新增时 `?section=` 决定类型（缺省 = 主题项目），
        编辑时先按 `id` + `section` 定位到对应表；**老地址 `?id=N`（不带 section）仍能打开** —— 先按板块入口表找，
        找不到再去精选表找一次（板块入口表的 id 优先，保持合并前 `/admin/app_home_edit?id=N` 的语义）。
      · **新增时的类型切换**：合并前列表页上有三个"添加"按钮，现在只有一个（按当前视图决定类型）；
        要在另一种类型下新增，编辑页顶部有一条链接（「改为添加精选项目」/「改为添加板块入口」）一次点击切换 —— 不用 JS。
    · **列表页**：第一行由三个 `addButton` 变成一个 —— 文案取当前板块的 `addLabel`（`添加` / `添加入口` / `添加精选`），
      `href` 带上当前 `section`（「全部」视图默认 `?section=main`）；标签条、位置与 2.3.7 一致，未动。
    · **清理**（删前确认过依赖：全仓 grep 只有 6 处引用，且都在本次会一起改的文件里）：
      删掉路由 `/admin/app_featured_edit`（老地址现在 404）、删掉 `app/admin/pages/appFeatured.js` 整个文件、
      删掉 `entities.NORMAL_WRITE_PATHS` 里的 `/admin/app_featured_edit`、删掉 `pages/index.js` 里的导入与展开；
      **保留** `/admin/app_featured_delete`（路径不变，实现搬进 `pages/appHome.js` 的 `deleteFeaturedSubmit`）与
      状态类型 `app_featured`、审计前缀 `admin.app_featured.*`、`invalidateEntityCache('featured')` —— 删除与行内启停不受影响。
      编辑页样式沿用 2.3.2 的 `editShell`（单列居中 + `col-lg-8 mp-frame` + 设置卡），未改一行。
    · **验证**（真库真 SQL + 真实 handler + 浏览器）：`?section=main|ext` 字段集为
      `section_key,item_id,image_url,sort_order[,status]`、`?section=featured` 为 `item_key,name,image_url,page_path,sort_order[,status]`；
      真库各写一条：板块入口 10 → 11 行且 `name` 由分类名派生为「户外」，精选 3 → 4 行，回跳分别是 `?section=ext` 与 `?section=featured`，
      审计事件分别是 `admin.app_home.create` / `admin.app_featured.create`；`/admin/app_featured_edit?id=0` → **404**，
      `/admin/app_featured_delete` 仍 302 回列表；老地址 `?id=5` 与 `?id=9`（自定义桩里 id=9 只属于精选表）都能打开对应表单。
      浏览器（桌面 1400 + 手机 390，21 项全过）：列表页第一行**只有一个**主按钮且与标签条左对齐；两种编辑页都是 2.3.2 骨架
      （`mp-frame` + 无右栏）、主按钮在「返回列表」之上且等宽、手机端不溢出、按钮 ≥40px。
      用例由 225 增至 **253 条全绿**（新增 1 条覆盖字段集/老地址/互不串改，并更新 5 处引用旧地址的断言）。
37. **素材库管理页扩成"可运维"**（2.3.9；R2 的用法结论见上面「R2 用法」一节，全部复用既有接口，没有另造一套）：
    · **上传**：页面上加了「上传素材」卡（图片/视频两个小表单），走**既有** `POST /admin/image_upload`（`purpose=cover` → `image/`、
      `purpose=video` → `video/`）；前端 fetch 上传 → 成功后带消息回列表（列表自动刷新）；上限沿用 8 MB / 64 MB（只认内容不认扩展名）。
    · **详情页**（`GET /admin/media_manage_detail?path=`）：预览 + 体积 / 类型 / 上传时间 /
      `Content-Type` / 缓存口径 / ETag / 公开地址 + **引用明细**（笔记引用直接链到编辑页）。
      （2.3.9 时预览"有缩略图用缩略图"，2.4.0 缩略图整体移除后改成直接用原图 —— 见第 38 条。）
    · **改名 / 移动**（`GET+POST /admin/media_manage_rename`，写路径已登记）：新 key = 目标目录 + 新文件名；
      图片只能进 `image/`、视频只能进 `video/`、历史 `news_uploads/` 两者都收（用它把历史素材归位）；
      **源或目标任一被引用就拒绝**（"源有引用"会改坏别人的引用，"目标有引用"会把别人在用的路径换掉），
      本站**不做**引用同步改写（那要重写笔记正文），拒绝页把引用逐条列出来并给"先去笔记里改引用"的指引。
    · **删除扩成批量**：同一个端点新增 `paths=`（逗号列表，单个 `path=` 仍兼容）；确认页列清单、提交前复查引用，
      **有一个被引用就整批拒绝**（避免"部分成功"的错觉）；**一批只花 1 次 R2 子请求**（`delete` 收数组）。
    · **筛选**：新增「目录」（`?dir=image|video|news_uploads`）与「引用状态」（`?ref=used|unused`），
      沿用 2.2.3/2.3.4 的统一方式（标签条 + `searchSelect`，参数进 URL、切筛选/翻页都带着）；
列表补了预览列与行内「详情 / 改名 / 删除」（预览列当时是缩略图，2.4.0 起改成"小图直出原图、大图占位"）。
    · **接口与权限的变化（只这两处）**：新增两个路由 `GET /admin/media_manage_detail`、`GET|POST /admin/media_manage_rename`，
      并把 `/admin/media_manage_rename` 登记进 `entities.SUPER_ONLY_WRITE_PATHS`（未登记的写路径会被分发层直接拦下）；
      页面本身仍是"仅超管"（GET 自查）。**未改**任何数据库字段、上传端点、对外接口（对外仍 33 条路径 / 73 条方法组合）。
    · **R2 平台限制与应对（都是既有事实，不是选择）**：`list` 单次上限 1000（超了标"至少这么多"）；
      `delete` 收数组单次上限 1000（所以批量很快，但仍按 20 封顶以守住子请求预算）；免费套餐单请求子请求上限 50
（所以批量删除按 20 封顶）；Workers 不产派生文件（缩略图已在 2.4.0 整体移除）；
      删除/改名后公开域上的旧副本最长保留一个缓存 TTL（原图 7 天）。
      ⚠️ `delete(key[])` 与 `put(stream)` 是 Workers R2 API 的既有能力（本地只能验证**调用形状**，真机上按 `DEPLOY.md` 的验收清单实测一次 —— **待确认**）。
    · **用例** 226 → **253 条全绿**（上传含缓存头断言、详情页、改名四种拒绝/成功路径、批量删除的"1 次 R2 调用 + 整批拒绝 + 超上限"、目录与引用状态筛选）。
      **真库核对**：真实被引用的 `news_uploads/news/lyhy-01.png`（真库 1 处引用）在改名页被拒（**不渲染表单**）、
      批量删除确认页与提交都整批拒绝且 **R2 删除调用 0 次**。
**浏览器核对 17 项全过**：上传卡、勾选联动批量计数、目录/引用状态下拉、预览列、详情页预览与引用链、
      改名表单与"被引用无表单"、批量确认页、页面脚本无报错、手机端不横向溢出。

38. **缩略图（派生文件）整体移除**（2.4.0；这是需求明确要求的"删功能"，不是优化）：
    · **删了什么**：`core/storage.js::thumbKeyOf`（"目录随原图走"的 key 规则）、`core/media_scheme.js` 的
      `thumbKey`/`hasThumb`/`previewThumbUrl`/`previewBodyThumbs`/`existingThumbs` + 两个宽度常量、
      `lib/mediaUpload.js` 的 `thumbKeyOf` 转发与 `thumbUrlOf`、`CACHE_CONTROL_THUMB`、
      离线计划工具 `tools/thumb_plan.mjs`（整个文件删除）、以及所有前端的缩略图引用。
    · **依赖它的位置（逐一处理过）**：① 素材库列表的「缩略图」列 → 改成「预览」列（≤512KB 的图直出原图，
      大图显示「无预览」，避免一页拉几十 MB）；② 素材详情页 → 预览直接给原图；③ 笔记预览页 → 封面/主视频/正文配图
      全部用原图地址（原来会换成 800px）；④ 素材库弹窗（`media_library.js` + `/admin/media_library`）→ 删掉 `thumb` 字段，
      列表与预览用原图；⑤ **对外接口 `/news/list` 不再下发 `image_thumb`** —— 小程序侧本来就是"没有这个键就回退原图"，
      老客户端不用改，代价是流量变大（这一点必须让端上知道）。
    · **生成侧**：本来就不在 CF 侧（旧站有 `make_cover_thumbs.py`，Workers 没有 Pillow），所以"删除生成"= 删掉规则、
      工具与文档说明；`tools/media_to_r2.md` 里的缩略图章节同步改写。
    · **存量历史缩略图（没有自动删）**：桶里 `<素材目录>_thumb/` 的对象仍在。清单现在**不再跳过**它们
      （`listNewsMedia` 去掉了 `_thumb` 过滤），所以它们会作为普通素材出现在素材库页里 —— 用「目录」筛选 + 批量删除即可；
      量大时也可以 `wrangler r2 object delete lyjxxapp-r2 --prefix=image/_thumb`（三个素材目录各一次）。
      删除后公开域上可能还有最长 7 天的边缘缓存副本（`CACHE_CONTROL_MEDIA` 的 TTL）。**待确认**：是否现在就执行清理。
    · **代价（写清楚）**：预览页与小程序都要自己扛原图流量（本站素材单张可达数十 MB，旧站实测 65~83 秒）；
      若以后压力大，要么重新引入"离线生成 + 上传"的派生文件，要么上 Cloudflare Images / Image Resizing（另外的功能与计费项）。
    · **守住的边界**：数据库字段、素材目录、引用判定、上传接口、路由与权限都没动；对外接口数量不变（仍 33 条路径 / 73 条方法组合），
      只是列表响应里少了一个可选键。
    · **守卫与实测**：新增守卫断言"`media_scheme`/`storage`/`mediaUpload` 不再导出任何缩略图助手、五个关键文件里没有缩略图代码"；
      对外接口用例改成断言"两个条目都没有 `image_thumb` 且**一次 `head` 都不发**（每页省最多 20 次子请求）"；
      笔记预览用例改成断言"封面与正文都是原图、页面里不出现 `_thumb`"。
39. **素材上传升级：文件夹、命名策略、进度条**（2.4.0；接口仍是既有的 `POST /admin/image_upload`，只多了三个可选参数）：
    · **参数**：`purpose` 增加 `auto`（服务端按**文件内容**分流到 `image/` 或 `video/`；素材库页自 2.4.1 起改为显式类型入口、
      不再用它 —— 见第 40 条，接口保留供脚本调用）、
      `name_mode=keep`（保留原名）、`rel_path`（相对路径；2.4.2 起**两种命名模式都用**）。不传 = 完全原来的行为
      （封面/正文/视频三条老路径一字未改）。
      · **命名规则**：`auto` → `<用途前缀>_<时间戳>.<ext>`（图片 `image/img_*`、视频 `video/video_*`；封面/正文仍走 `cover_`/`content_`）；
      `keep` → 用上传时的相对路径。目录结构在**两种模式下都保留**（2.4.2 起，只换文件名那一截）。
      **重名绝不覆盖**：写前 `head` 探一次，已存在就顺延 `_1`/`_2`…（最多 20 次），自动生成模式带时间戳正常不会撞。
      · **安全（trust boundary）**：`safeRelPath()` 清掉 `..`/空段/控制字符/盘符段、把 `?`/`#`/`%` 换成 `_`（公开域是
      `${MEDIA_BASE}/${路径}` 直拼，名字里带 `#` 会把后半截当锚点、带 `%` 会被当转义 → 传上去也点不开）、
      每段 ≤120 字、总长 ≤300 字 —— 出不了素材目录；
      扩展名仍是白名单（图片 jpg/jpeg/png/gif/webp、视频 mp4/mov/m4v/webm），**类型只认文件头**（改扩展名蒙不过去）；
      大小上限沿用图片 8 MB / 视频 64 MB。
      · **文件夹上传**：浏览器原生 `webkitdirectory`（不引第三方库），一次选中整个目录；**整棵目录树原样保留**
      （2.4.0 会剥掉顶层那层，2.4.2 起不剥了）—— 每个文件成为 key 的一部分（R2 没有真目录、公开域照常访问）。
    · **进度条**：用 `XMLHttpRequest.upload.onprogress`（**fetch 没有上传进度**，这是浏览器的事，与服务端无关）；
      **一次请求一个文件、顺序上传**，所以能显示"当前文件名 + 单文件百分比 + 整体字节进度 + 成功/失败/跳过计数"，
      失败项留在页面上可**重试**或**跳过**。服务端不上报进度（Workers 没有"已接收字节"的进度接口，不臆造）。
    · **R2 / Workers 限制与应对（都是平台事实）**：单请求体上限免费套餐 100 MB（`bodyTooLarge` 对 multipart 直接放行，
      所以 64 MB 视频能传）；子请求预算 50 次/请求 —— 每次上传只花 2 次（`head` 查重 + `put`）；
      R2 key 上限 1024 字节（相对路径按 300 字符封顶，中文最多约 900 字节，留有余量）；
      Workers 还有单请求时长与并发限制，所以**顺序上传**既对进度友好、也不会自己打满并发（文件夹里文件特别多时建议分批选）。
    · **用例**：`safeRelPath` 的穿越/空段/控制字符/URL 破坏字符(`?#%`)/盘符/长路径断言；`purpose=auto` 的"图片进 image/、
      视频进 video/、内容与扩展名不符时以内容为准、白名单外拒绝"；重名 `_1`/`_2`；端点透传 `name_mode`/`rel_path`；
      页面静态特征（XHR 进度、顺序、重试/跳过、文件夹入口）；**浏览器实测 14 项全过** —— 真页面 + 真上传接口 + 桩 R2：
      多选文件上传得到 `image/img_*.png` 与 `video/video_*.mp4`；文件夹上传得到 `image/图一.png`、`image/子目录/图二.png`、
      `video/深层/再深/片子.mp4`（顶层目录已剥掉）；传 `.txt` 会列出失败原因并可跳过（统计显示"跳过 1"）；进度条到 100%。

40. **素材库上传拆成"图片 / 视频"两个入口；两页列表统一滚动加载**（2.4.1）：
    · **上传拆分（为什么拆）**：2.4.0 是"一个入口 + 服务端按内容嗅探分目录"，选**文件夹**时图片与视频会各自散到
      `image/`、`video/`，用户在页面上看不出"这批会去哪"。现在拆成两个入口，**类型由入口决定**：
      图片入口 → `purpose=cover` → 一律 `image/`；视频入口 → `purpose=video` → 一律 `video/`。
      复用既有 purpose 规则（**没有新增接口、没有新增参数**），服务端仍按文件头校验内容 —— 图片入口塞视频会被拒（有断言）。
    · **子目录保留规则（与 2.1.7 的目录约定如何对应）**：key = `<类型目录(入口决定)>/<相对路径…>`，
      2.4.1 时只保留内部子目录、剥掉你选中的那层顶层文件夹名；**2.4.2 起整棵树都留（连顶层那层一起）**、且两种命名模式
      都保留目录 —— 见第 41 条。历史素材仍在 `news_uploads/`（本页新上传只写 `image/`、`video/`）。
    · **一个队列混两种类型**：每个文件带上自己入口的 purpose，所以可以先选图片再选视频、点一次「开始上传」，
      进度条只有一条、失败仍可重试/跳过。`purpose=auto`（2.4.0 的按内容分流）**接口上保留**，但素材库页不再用它。
    · **滚动加载（两页与其它 6 个列表页同一实现）**：不新写一套 —— 复用既有的 `static/js/infinite_scroll.js`
      （`AdminInfiniteScroll` 触发 + `AdminListLoader` 取行片段 + `AdminPagerBar` 工具栏）。素材库页这次从"上一页/下一页"
      换成它：新增行片段端点 **`GET /admin/media_manage_rows`**（与页面同一条超管闸、只回 `<tr>` 片段、
      越界请求按 `min(page, totalPages)` 夹到最后一页、没有命中回空串让前端停手），并抽出共用的
      `partials.listFoot`（哨兵 + 回到顶部/跳页）与 `mediaQuery`/`mediaRows`（首屏与行片段共用取数与渲染，
      否则两处的列与筛选口径会各走各的）。
    · **筛选联动（2.2.3/2.2.6 的 URL 参数口径 + 2.3.6 的修复结论）**：行片段请求的查询串**完全取自 `location.search`**，
      `rowsUrl` 只给端点路径（`/admin/media_manage_rows`，**不带 `?`**）—— 这正是 2026-10-08 那个线上 bug 的修复口径
      （rowsUrl 自带 `?...` 再拼一次 `?` 会把筛选参数吞进前一个参数里，表现为"上划加载没有数据"）。
      实测：`?dir=image&sort=name_asc` 下第 2 页请求是 `…/media_manage_rows?dir=image&sort=name_asc&page=2` ✓ 不串数据。
    · **笔记管理页去掉「跳至 N 页 / 跳转」**：滚动加载下跳到第 N 页只会看到第 N 页的行（前面没加载出来），看起来像丢数据；
      这次把跳页做成共用件的开关（`listShell`/`pagerScript` 的 `jump:false`），**笔记页与素材库页关掉，其余 6 页照旧**。
      分页逻辑本身没动（`AdminPagerBar` 对拿不到的 id 本来就是跳过）；`/admin/news_manage_rows`、页码同步、筛选保留都不受影响。
      ⚠️ 素材库页同样关掉了跳页（与笔记页口径一致）—— 这是**待确认**的一处：若你要在素材库页保留"跳至 N 页"，
      把 `listFoot`/`pagerScript` 的 `jump:false` 删掉即可（其余不用动）。
    · **R2 / Workers 限制与影响（不臆造，按实现数下来）**：素材库页是从 R2 列举 + 内存切页（R2 没有服务端分页），
      所以**每一次滚动加载 = 2 趟 R2 列举**（`kind=all` 时图片/视频各一趟，单趟上限 1000 个对象）
      **+ 9 条 D1 引用扫描**（并发）≈ 11 次子请求，仍在免费套餐 50 次/请求的预算内；代价是"每翻一页重列一遍全量"，
      素材上千后单页会变慢（**待确认**：真到那一步就把列举结果做个短期缓存或改成分页列举）。
      上传侧限制与 2.4.0 相同（图片 8 MB / 视频 64 MB、免费套餐单请求体 100 MB、multipart 不受 5 MB body 限制、
      **一个文件一个请求的顺序上传**），拆分入口不改变这些；文件夹只是"一次选中多个文件"，仍然逐个上传，
      所以不存在"一次请求体太大"的问题。

      41. **上传按钮文案修正 + 文件夹目录结构整棵保留**（2.4.2）：
      · **文案**：原来每个入口是两个原生 `<input type="file">`，浏览器把它们**都**渲染成"选择文件"
      （`webkitdirectory` 只影响弹出的对话框，按钮文字改不了）—— 于是同一栏里出现两个"选择文件"。
      现在把两个 input 隐藏（`visually-hidden`，仍可被键盘聚焦），用 `<label class="btn btn-sm btn-outline-secondary" for=…>`
      显示自己的文案：**「选择文件」/「选择文件夹」**，两个入口不再重复。`for` 关联在任何位置都生效，点击仍然拉起
      系统选择框（**浏览器实测**：`expect_file_chooser` 能收到对话）。
      · **目录结构整棵保留（这是本次的功能修正）**：2.4.1 只有「保留原名」才发 `rel_path`，而默认的「自动生成」**根本不上传相对路径**，
      所以选文件夹时（尤其是默认模式）看起来"只传了文件"。现在：
      - 前端 `relOf()` 直接取 `file.webkitRelativePath` 整条（**不再剥掉顶层文件夹名**，`\` 归一交给服务端）；
      - **两种命名模式都发 `rel_path`**：目录部分在服务端拼进 key，只有**文件名那一截**跟着命名策略走；
      - 后端 `saveUpload` 把相对路径拆成 `<目录>/<文件名>`（新的 `splitRel()`）：`keep` 用原文件名、`auto` 换成
        `<用途前缀>_<时间戳>.<ext>`，**目录照带**。
      · **落点与边界（逐条回答）**：
      - key = `<入口决定的类型目录>/<相对路径>`：图片入口 `image/…`、视频入口 `video/…`；
        选文件夹「素材」→ `image/素材/根目录图.png`（**直接放在所选文件夹里的文件落在该文件夹这一层**）、
        `image/素材/相册/子目录/深图.png`（子目录原样保留，**没有层数限制**，只受 300 字符总长约束）。
      - **空文件夹不保留**：R2 没有目录（key 里的 `/` 只是名字的一部分），浏览器也不会把空目录列进 `FileList` —— 两边都没有它的位置。
      - **重名**：仍按最终 key 探重（写前 `head` + 顺延 `_1`/`_2`…，绝不覆盖）。**不同子目录里的同名文件互不影响**
        （`image/相册一/图.png` 与 `image/相册二/图.png` 各用原名），同目录同名才顺延（有断言）。
      - **非法字符 / 路径穿越 / 分隔符**：`safeRelPath()` 一处兜住 —— `\` 归一成 `/`、去掉空段与 `.`/`..`（出不了素材目录）、
        剥控制字符与 Windows 盘符段、把 URL 会打断链接的 `?`/`#`/`%` 换成 `_`；每段 ≤120 字、总长 ≤300 字（超出丢最外层目录）。
        ⚠️ 之所以连 `?#%` 也要换：公开域是 `${MEDIA_BASE}/${路径}` 直拼，名字里带 `#` 浏览器会把后半截当锚点、带 `%` 会被当百分号转义 → 上传成功也点不开。
      · **没动的**：`POST /admin/image_upload` 的参数与语义没加新字段（只是 `rel_path` 在 `auto` 模式下也开始生效，
      而**只有素材库页**会发它 —— 编辑页/弹窗/封面/正文/视频那几条老路径一字未改）；进度条（2.4.0）、滚动加载与回到顶部（2.4.1）、
      筛选/路由/权限、`image/`+`video/` 目录约定全部照旧。
      · **R2 / Workers 限制对本功能的影响**：多文件带目录上传**不会**放大单次请求 —— 一个文件仍是一个请求（1 次 `head` + 1 次 `put` = 2 次子请求），
      文件夹只决定"选中多少个文件"；单请求体上限（免费套餐 100 MB、本站图片 8 MB/视频 64 MB）与目录无关；
      真正的成本是**文件数量**（顺序上传，几十上百个要等），所以仍建议分批选；R2 key 上限 1024 字节，300 字符的相对路径（中文约 900 字节）留有余量。
      · **用例与实测**：新增/改写断言 —— 两个入口的按钮文案与"4 个 input 都隐藏"、`rel_path` 不再按命名模式分叉、
      不再剥顶层文件夹名、`safeRelPath` 的 `?#%`/盘符清洗、**两种模式都保留目录**（`keep` → `image/素材/子目录/图.png`；
      `auto` → `video/素材/子目录/video_<ts>.mp4`）、不同子目录同名不互相顺延、无 `rel_path` 的老调用方行为不变；
      另加一条**"页面内联脚本必须能解析"**的守卫（见下面那段踩坑记录）。**浏览器实测 20 项全过**：真目录（两层子目录）分别走
      图片入口（保留原名）与视频入口（自动生成）落进 R2、图片入口里的 `.mp4` 被拒并给出原因、列表与详情页能显示并打开带子目录的 key、
      滚动加载/回到顶部/无 JS 报错/手机端不溢出都正常。
      · **⚠️ 本次踩到并加了守卫的坑**：页面脚本是**用模板字符串生成**的，我在里面写了 `.replace(/\\/g, '/')`，
      经过模板字符串一层转义后变成 `/\/g` → 整段内联脚本 SyntaxError → **素材库页的上传与批量选择全废**（页面看起来完全正常）。
      已改为"分隔符归一交给服务端"，并加了一条对 4 个列表页逐段 `new Function(code)` 的语法检查 —— 以后这类问题会被测试拦住。
      影响面提醒：`pages/*.js` 里凡是 `PAGE_SCRIPT`/`<script>` 模板，写正则里的反斜杠都要按"两层"来想。

42. **上传目标路径可选（默认仍是固定位置）**（2.4.3；交互方式在 2.4.4 改为下拉，规则与校验沿用）：
   · **交互方案**：2.4.3 是"文本输入 + `<datalist>` 建议"，**2.4.4 起改为下拉可选**（见第 43 条），这里保留当时的取舍记录：
     不引第三方组件、不自己做目录树，`<input list>` 是当时"既可选已有、又能新建"的最小实现。
   · **默认值 = 原来的固定位置**：图片 `image/`、视频 `video/`，两个输入框预填的就是它；**用户不碰它 → 行为与 2.4.2 一字不差**（有实测）。
   · **与 2.4.2 的目录结构叠加**：key = `<目标路径>/<相对路径的目录>/<文件名>` —— 目标路径当根，选文件夹时那棵树**在它下面**继续保留。
     例：路径 `image/2026-10/` + 文件夹「素材」（内有 `子/深图.png`）→ `image/2026-10/素材/子/深图.png`；
     只改路径、不选文件夹 → `image/2026-10/图.png`。
   · **路径校验（前后端都做，权威在后端）**：
     - 只允许**本入口自己的根目录及其子目录**（图片 `image/…`、视频 `video/…`），**跨入口直接拒绝** ——
       素材库列举是按类型扫 `image/` + `news_uploads/`（或 `video/` + `news_uploads/`），把图片写进 `video/` 会让它"列不出来"；
       `avatar/`、`news_uploads/` 同样不在允许范围（2.1.7 的约定：新上传只落 `image/`、`video/`）。这就是"禁止写入非素材目录"的落点。
     - 复用 2.4.0 的 `safeRelPath` 清洗，并要求"**清洗结果必须与输入完全一致**"—— 不一致就**拒绝并说明原因**，
       而不是静默改写到别处：`..`、绝对路径（前导 `/`）、盘符、空段（`//`）、`.`、控制字符、`?#%`、超长（>300 字符）一次全挡住；
       `\` 归一成 `/`、尾斜杠自动补齐（`image\素材` → `image/素材/`）。
     - 前端只拦两条最要命的（必须在本入口根目录下、不含两个点），**开跑前**拦掉，免得整批文件各失败一次；其余以后端为准（两处一致有断言）。
   · **对已有功能的影响（逐项核过）**：

     | 功能 | 是否受影响 | 说明 |
     |---|---|---|
     | 素材库列表与筛选 | 不受影响 | 仍按 kind 扫 `image/`(+`news_uploads/`) 或 `video/`(+`news_uploads/`)；「目录」筛选仍是顶层目录（2.3.9 口径），子目录一直显示在「文件」列的路径里 |
     | 素材选择器（图片/视频素材库弹窗） | 不受影响 | 读同一个 `listNewsMedia`，`item.name` 就是含子目录的相对路径，插入时回填同一个值 |
     | 引用判定 `scanReferences` | 不受影响 | 归一化等值 + `LIKE '%image/%'` 粗筛，与目录深浅无关（2.4.0 起就有子目录） |
     | 小程序端访问素材 | 不受影响 | 小程序存的是相对路径、下发时拼 `MEDIA_BASE`；子目录 2.4.0 起就支持（详情页/直出同一拼法） |
     | 上传弹窗 / 编辑页 / 封面 / 正文 / 视频 | 不受影响 | 它们不传 `target_dir`（只有素材库页传），继续走默认根目录 |

   · **限制（平台事实，不臆造）**：选路径**不产生额外请求**，也不改变"一个文件一个请求"的形态（每文件仍是 1 次 `head` + 1 次 `put`）；
     目录深度受 key 总长约束（R2 key 上限 1024 字节，这里按 300 字符封顶）；深目录不多花子请求 ——
     Cloudflare/R2 **没有**"按前缀建目录"这种能力（"目录"只是 key 里的斜杠），所以不该也不需要去"创建目录"。
   · **用例与实测**：`safeTargetDir` 单测（默认/子目录/漏尾斜杠/反斜杠归一/跨入口/穿越/绝对路径/空段/特殊字符/超长）、
     端点透传与拒绝（被拒时**一个对象都不写**）、与 2.4.2 结构叠加、页面侧默认值与"建议只给本入口那棵树"、前端开跑前校验。
     **浏览器实测 19 项全过**：不碰路径时图片/视频仍落 `image/`、`video/` 根；选 `image/2026-10/` + 选文件夹 →
     `image/2026-10/素材/顶图.png` 与 `image/2026-10/素材/子/深图.png`；选 `video/活动/` → `video/活动/video_<ts>.mp4`；
     datalist 只给本入口的现有目录；跨入口/穿越路径被前端拦下且不发起上传；后端对 `avatar/`、`news_uploads/`、
     `image/../video/`、`/image/x/` 逐条拒绝；2.4.1/2.4.2 的滚动加载、回到顶部、按钮文案与手机端布局都没被碰坏。

43. **上传目标路径改为"可选择项"并支持根目录**（2.4.4；默认值不变，仍是 `image/` 与 `video/`）：
   · **问题一 · 支持写入存储桶根目录**：界面上是下拉的**第一项**「根目录（存储桶最外层）」，**提交值就是 `/`**
     （空串已经被"没传 = 默认根目录"占用，不能复用）。落到 R2 时它表示"空前缀"：key 就是文件名或相对路径本身
     （`logo.png`、`素材/子/图.png`），不带 `image/`、`video/` 任何前缀。`safeTargetDir(raw, root)` 里 `'/'` 直接返回空前缀，
     其余规则（只能在本入口根目录下、禁止穿越等）一字未改。
   · **问题二 · 由手动填写改为可选择**：两个入口各一个 `<select>`，**可选项 = 根目录 + 本入口根目录(默认) + 桶里已存在的各级目录**，
     用 `&nbsp;` 缩进表示层级（`image/` → `　image/素材/` → `　　image/素材/相册/`），**另留一项「其它（手动填写）」**：
     选中它才露出文本框（默认状态页面只有一个下拉，不会多一个空框），用来归档到一个**还不存在**的新目录（如 `image/2026-10/`）——
     纯下拉无法表达"新建目录"，而这是真实需求，所以保留手动兜底。
   · **可选项的来源**：**桶里已有的目录**，而且是从素材库页**已经做过的那次 R2 列举结果**里推导（每个素材的各级父目录都算候选），
     **不额外发任何请求**；页面按当前 kind 列举，所以筛选到单一类型时，另一类型的下拉只有「根目录 + 它自己的根目录」
     （**待确认**：要"两边的完整目录清单"就得再发一次列举，当前没做，因为这只是建议而非约束，手填兜底也在）。
     不做"目录浏览器"（后台没有树组件，写一套一两百行 JS 只为低频操作不划算）。
   · **根目录素材能不能在素材库里看到 —— 这次把配套调整一并做了**（这是本条的重点）：
     | 环节 | 原状 | 2.4.4 的调整 |
     |---|---|---|
     | 素材库列表 / 占用统计 | 列不出来（只按 `image/`+`news_uploads/` 或 `video/`+`news_uploads/` 前缀扫） | `listNewsMedia` 增加**根目录一趟列举**（`list({prefix:'', delimiter:'/'})` 只取"根下直接的对象"，再按"不含斜杠"兜一道）→ 根目录素材按扩展名归进图片/视频，`dir` 为空串，列表里「目录」列显示**根目录** |
     | 素材选择器（图片/视频素材库弹窗） | 同上，看不到 | 同一个 `listNewsMedia` → **自动能看到**（`item.name` 就是文件名，插入编辑器回填的也是这个相对路径） |
     | 目录筛选 | 只有 image/video/news_uploads | 增加「根目录」选项（URL 里的值是 `?dir=/`，哨兵值，和"全部"的空串区分开） |
     | 详情 / 改名 / 删除 | `normRel()` 只认带素材前缀的路径 → 根目录素材一律"参数错误" | 新增 `isRootMediaName()`：**不含斜杠且扩展名是图片/视频**的纯文件名才算根目录素材（`logo.png` ✓、`index.html`/`robots.txt` ✗）—— 这样详情/改名/删除才对根目录素材生效，同时不会把任意字符串变成"万能删除入口"；改名页的目标目录下拉也加了「根目录」 |
     | 引用判定（删除/改名的安全闸） | 粗筛按 `image/`/`video/`/`news_uploads/` 前缀 LIKE，`relPathsIn` 也只认带前缀的路径 → 根目录素材**永远算"未引用"**（真被引用也会被删掉，最危险的一种漏判） | ① 粗筛在"本次要查的集合里真有根目录素材"时**多一组按扩展名的 LIKE**（`%.png`/`%.mp4` 等，与根目录里有多少文件无关）；② `relPathsIn(value, rootNames)` **按候选名单**精确命中（只认名单里出现过、且字段里出现的名字；**不从任意文本里猜裸文件名**，避免噪音）。 |
     | 小程序端 / 编辑页 / 上传弹窗 / 封面 / 正文 | — | **不受影响**：下发仍然是把相对路径拼 `MEDIA_BASE`（`assetUrl` 不要求前缀），这些入口也都不传 `target_dir`；根目录素材与其它素材一样走公开域直读（Worker 的直出白名单 `/images/`、`/image/` 等**不含根目录**，但媒体本来就不走 Worker） |
   · **限制与代价（不臆造）**：根目录列举是**多发一趟 R2 list**（`delimiter:'/'` 只回根下对象，响应很小）；引用粗筛在含根目录素材时**会多取一些行**（LIMIT 2000/500 的口径没变，
     且多取到的行仍由精确匹配判定）；根目录文件名与正文里的普通文字同形时**可能多报引用**（方向是安全的：宁多勿漏）。
   · **用例与实测**：单测覆盖 `isRootMediaName`/`normRel`/`relPathsIn(value, names)`/`listNewsMedia` 的根目录列举、
     `safeTargetDir('/')`、根目录上传与"文件夹结构在根目录下照样保留"、被拒路径不写对象；页面侧覆盖下拉可选项（含根目录、缩进、手动兜底、默认仍是 `image/`/`video/`）、
     根目录素材在列表/筛选/引用/详情/删除/改名各环节的行为。**浏览器实测 23 项全过**：默认不碰下拉行为不变；选根目录后图片/视频的 key 就是文件名；
     根目录 + 选文件夹 → `素材/顶图.png`、`素材/子/深图.png`；手动填 `image/2026-10/` 可用、填 `video/x/` 被前端拦下且不写对象；
     根目录素材出现在清单、目录列显示「根目录」、引用算作 1 处、删除被拒、详情页写明根目录；2.4.1/2.4.2/2.4.3 的滚动加载、回到顶部、按钮文案与手机端布局都没被碰坏。

44. **修：传上根目录的素材在素材库页看不见**（2.4.5）：
   · **根因（有依据，不是猜）**：2.4.4 的"根目录那一块"只收**根下不带斜杠的对象**
     （`list({prefix:'', delimiter:'/'})` 的 `objects`），而**"根目录 + 选文件夹"**传出来的对象键是
     `素材/子/图.png` 这种**带斜杠**的 —— 按 Cloudflare 的 R2 语义（Workers API reference：`prefix:''` + `delimiter:'/'` 时
     **根级键进 `objects`、含 `/` 的键折叠进 `delimitedPrefixes`**），它们**根本不会出现在 `objects` 里**；
     同时它们又不以 `image/`、`video/`、`news_uploads/` 开头，所以下面的素材前缀循环也扫不到 → **上传成功，页面两头都不认**。
     这也解释了"单独传一个文件到根目录时看得见、选了文件夹就看不见"的现象。
   · **修法（把"根目录"从一层扩到整棵树）**：列举先做一趟根下列举拿到 `objects`（根下裸文件）与 `delimitedPrefixes`（根下顶层目录），
     把**已知前缀**排除后（素材目录由各自前缀单独扫；`avatar/`、`avatar_uploads/`、`images/` 是站内自有目录 ——
     Worker 直出的用户头像与站点图标，**不进素材库**），对剩下的每个根级目录**整棵树各扫一趟**（带 cursor 翻页，和素材前缀同一套写法）。
     同一条 key 只收一次（`seen` 去重）——真 R2 上两条路不会重叠，但桩 R2 忽略 `delimiter` 会把整桶回给我们，所以兜一道。
   · **配套改动（不然列出来也点不动）**：
     - `isRootMediaName` → **`isRootTreePath`**：范围从"裸文件名"扩到"根下自定义目录里的路径"（仍然要求**扩展名是图片/视频**，
       且不在任何已知前缀下、不含空段与 `..` —— `index.html`、`images/icon.png` 依旧被挡住，不会变成万能删除入口）；
       `normRel` 认这类记录值 → **详情 / 改名 / 删除**对根下目录里的素材生效。
     - **改名页**在"目标目录 = 根目录"这一档允许填**整条相对路径**（如 `素材/子/图.png`）——否则没法保持或调整结构
       （媒体目录那一档仍不允许带斜杠）；引用判定按候选名单命中，名单现在也含带斜杠的根目录路径。
   · **影响面**：素材库列表、占用统计、素材选择器（图片/视频素材库弹窗）、引用判定**都走同一个 `listNewsMedia`/`scanReferences`**，
     所以一并覆盖；小程序端不受影响（仍按相对路径拼 `MEDIA_BASE`）；上传入口、路径下拉、进度条、滚动加载、回到顶部、路由与权限都没动。
   · **限制与代价**：根目录那块每趟列举 = 1 次根下列举 + 每(非已知)根级目录 1 次列举（通常 0~1 个，代价很小）；
     **排除名单**是写死的（`image/`、`video/`、`news_uploads/`、`avatar/`、`avatar_uploads/`、`images/`）——
     桶里将来若多出别的**内部**顶层目录，它会被当成"用户的根目录素材"列进素材库（**待确认**：真出现时把它加进
     `core/storage.js` 的 `INTERNAL_PREFIXES` 即可）。
   · **用例与实测**：单测覆盖 `isRootTreePath` 的范围（裸文件名 ✓、根下目录 ✓、各种已知前缀 ✗、空段/`..` ✗）、
     `normRel` 对根目录树路径的接受与对非素材扩展名的拒绝、`relPathsIn` 按名单命中带目录的路径、
     以及**两套列举实现**（桩 R2 忽略 delimiter / 按真 R2 delimiter 语义折叠）下都能列出"根目录整棵树"且不重复；
     页面侧覆盖列表不重复、`?dir=/` 与关键词搜索覆盖根目录、站内自有目录不进库、引用算得出且删除被拒、
     详情页可打开、改名页默认"根目录"且能改成带目录的路径、素材选择器接口同样含根目录整块。
     **浏览器实测 24 项全过**（桥里的 R2 list 按真 delimiter 语义实现）：`logo.png`、`素材/顶图.png`、`素材/子/深图.png`、
     `素材/子/片段.mp4` 都在列表里且各一行、目录列显示「根目录」、`?dir=/` 与搜索正确、引用显示 1 处、删除被拒、
     上传到根目录后详情可开、改名成 `素材/子/改名后.png` 成功、选择器接口（图片/视频）都含根目录整块、滚动加载与手机端正常、无 JS 报错。

45. **`media_manage` 升级为 R2 存储桶的完整资源管理页**（2.4.6）：
   · **浏览模型（取代"全桶素材清单"）**：页面变成**按前缀逐层浏览** —— `?prefix=<dir/>` 决定"当前这一层"，
     一次 R2 列举（`list({prefix, delimiter:'/'})`）拿到该层的**子目录**（`delimitedPrefixes`，渲染成目录行）与**直接对象**（渲染成文件行）；
     面包屑每段可点、「上一级」按钮回上层，根层就是存储桶本身。**不再全桶扫描**（2.4.1~2.4.5 那种"把 image/、video/、news_uploads/ 和根目录树全列一遍"的做法整块删掉了）。
   · **分页与滚动加载（与 2.4.1 兼容）**：层的列举以 1000 个对象封顶（R2 单次列举上限），页内按每页 10 条切片，
     触底继续追加（`rowsUrl` 仍是纯路径 + `location.search`，所以 `prefix`/`kind`/`ref`/`q` 翻页都不会串）；
     一层超过 1000 个时页面明确提示"已到单层上限，请用前缀/关键词缩小范围"。目录行只在首屏渲染，追加的只有文件行。
   · **能看到什么**：对象键（完整路径）、类型（按扩展名：图片/视频/其它）、大小、修改时间、ETag；
     详情页另有 Content-Type、缓存口径、公开地址与**所在层**（可点回该层）。公开地址 = `${MEDIA_BASE}/对象键`（R2 公开域直读，不经 Worker）。
   · **能做什么**：详情 / **改名·移动**（目标目录是**任意前缀**的自由文本，留空 = 桶根；绝不覆盖已有键）/
     **复制**（同一个页面上的勾选框：复制保留原对象，只多写一个新键）/ **删除**（单条与批量，走既有确认页）/
     **目录级移动**（一次 ≤10 个对象，每个对象 = head+get+put+delete 四次 R2 子请求，剩下多少会提示"可再次提交"）/
     **目录级删除**（一次 ≤20 个，走引用复查）。
   · **危险操作都有二次确认**：删除/目录删除是"不可恢复"确认页 + 提交前**再复查一次引用**（有一个被引用就**整批拒绝**）；
     目录移动先给出"这一批 N 个、合计 X、还有 M 个"再确认；移动/复制**绝不覆盖**目标（目标已存在就拒绝并说明）。
   · **被引用素材的处理口径没变**：涉及被引用素材时**不会擅自改写笔记**（改名/移动/删除一律拒绝，页面把引用逐条列出来）——
     新增的便利是：确认页直接给「改为复制」入口（复制不动原对象，因此不受引用限制）。
   · **引用检查的范围（2.4.6 收紧）**：只有**素材路径**才扫 —— 素材目录（`image/`、`video/`、`news_uploads/`）下的，
     以及根目录树里**带图片/视频扩展名**的；`avatar/`、`images/`、`assets/` 这类站内资源**不做引用扫描**（笔记引用不到它们），
     列表里引用列显示 `—`。粗筛仍是"前缀 LIKE（+ 根目录素材时补扩展名 LIKE）"，精确判定仍由 `relPathsIn` 完成。
   · **没做 + 原因（按实际情况取舍）**：
     - **新建空目录 / 删除空目录**：R2 里**没有目录实体**（`/` 只是键名的一部分，列举靠前缀+分隔符模拟），所以"空目录"根本不存在，
       也创建不出来。要"新建目录"就在上传卡片里把**目标路径**填成它（文件一落地，这一层就存在了）；删完里面的对象，这一层自然消失。
     - **服务端整体复制/移动一个对象**：R2 **没有** copy/rename，只能"读到 Worker → 写新键 →（移动时）删旧键"，所以目录级移动按批 10 个走。
     - **下载**：媒体本来就走公开域直读，点对象键就是预览/下载；**私有对象拿不到**（本项目没配签名 URL，**待确认**要不要加）。
     - **一次性删掉整个前缀**：`delete` 单次上限 1000，但列举 + 引用复查也花子请求，所以目录删除按 20 个一批（提示可继续）。
   · **R2 能力与限制（平台事实，不臆造）**：`list` 支持 `prefix` / `delimiter` / `limit(≤1000)` / `cursor` / `include`；
     带 `delimiter` 时根级键进 `objects`、含分隔符的折叠进 `delimitedPrefixes`（**本页的逐层浏览就靠它**）；
     **没有真正的目录**，也没有 rename/copy 服务端能力；`put`/`delete` 强一致，`delete` 单次可传 1000 个 key；
     对象键上限 1024 字节（页面按 300 字符封顶）；缓存与公开访问策略不变（新上传对象带 `Cache-Control: public, max-age=604800, immutable`，公开域直读）。
   · **影响面**：上传卡片**交互与逻辑未动**（只有「目标路径」的可选项来源改成"当前浏览层的子目录"，不再为它做全桶扫描）；
     素材选择器（编辑页的图片/视频素材库弹窗）与小程序取数**都没动**（仍走 `listNewsMedia`：`image/`、`news_uploads/` 与根目录树里的图片/视频），
     所以站点图标与头像**不会**跑进素材选择器；系统信息页的全桶媒体占用统计也不受影响（这里不再重复扫描）。
   · **用例与实测**：`node --test` **255 条全绿**（253 → 255）——新增/改写：对象键校验（`..`/空段/`#%?`/盘符/超长）、`listUnder`、
     逐层浏览（根层目录行 + 深层对象 + 面包屑/上一级 + 只列当前层 + 滚动加载 + 统计条）、类型/关键词/引用状态筛选在**本层**生效、
     详情页（对象键/所在层/ETag）、改名·移动（任意前缀）/复制（保留原对象、目标已存在拒绝）、
     目录级移动（一次 10 个、结构保留、剩余提示）与目录级删除（一批一次 R2 delete、被引用整批拒绝、非超管 403）；
     顺带把**桩 R2 的 `list` 补上真 `delimiter` 语义**（以前忽略它，会把子目录对象当成当前层，给出假通过）。
     **浏览器实测 36 项全过**（桥里 R2 按真 delimiter 语义）：逐层浏览/面包屑/上一级、只列当前层、滚到底补齐、四类筛选、
     详情页元数据、改名到任意前缀、复制保留原对象、目录级移动 10 个+剩余提示、目录级删除（含"被引用整批拒绝"与绕过页面直接 POST 也被拒）、
     上传卡片与滚动态未回归、素材选择器仍只给素材、手机端不溢出、无 JS 报错。

## R2 用法（结论，2.3.9 评估后定稿；2.4.0 的调整见下方标注）

一句话结论：**素材对象一律放公开自定义域直读（`storage.250036.xyz`，不经 Worker）；key 与库里的相对路径一字不差、带类型前缀、只新增不覆盖（重名顺延 `_1`）；不派生任何文件（缩略图已在 2.4.0 整体移除）；新对象在上传时写死长缓存头。私有访问与签名 URL 本项目不用。**

| 维度 | 结论 | 理由（结合本项目现状） |
|---|---|---|
| 对象键命名 | `<类型>/<用途>_<时间戳>.<ext>`：`image/cover_<ts>.jpg`、`video/video_<ts>.mp4`、`avatar/avatar_<ts>.png`；历史 `news_uploads/…`、`avatar_uploads/…` 一个都不动 | 库里存的就是这个相对路径（`normRel` 的归一化口径以它为准），改 key 等于同时改库；带时间戳 ⇒ **只新增不覆盖** ⇒ 缓存可以长、不需要版本号 |
| 公开 vs 私有 | 公开自定义域直读（**不经 Worker**） | 素材是公开内容（小程序列表/正文/封面都在用）；直读不占 Worker 请求额度；私有块会让 URL 变成临时地址，小程序缓存/分享/预览都要跟着改，收益为负 |
| 签名 URL | **不用**（本项目没有私有素材） | 签名 URL 只为"临时授权访问私有对象"存在；这里要的是"长期可缓存地公开访问"。将来若真有"未发布素材"再单独评估（**待确认**） |
| 缓存策略 | 上传时写死：`public, max-age=604800, immutable`（7 天）—— **2.4.0 起只剩这一档**（缩略图那档 1 年随功能一起删了） | key 不覆盖写（重名会顺延 `_1`，见下）⇒ `immutable` 安全；这也是旧站媒体口径。⚠️ 代价：**删除或改名后，边缘上的旧副本最长还要等这个 TTL 才彻底消失**；R2 自身没有"按 key 清 CDN 缓存"的能力（要清得上 Cloudflare 缓存 API 且需 zone 权限，本项目不做 —— **待确认**） |
| 缩略图 / 派生文件 | **2.4.0 起不派生、不存储、不下发**（规则、工具与所有引用都已删除）；列表/详情/预览/对外接口一律用原图。存量 `<素材目录>_thumb/` 对象按 README 第 38 条的方案清理（不自动删） | Workers 免费版没有图片处理能力（没有 Pillow/sharp；Cloudflare Images、Image Resizing 是另外的功能/计费项 —— **待确认**）；既然生成只能在离线做、又要多维护一套 key 规则，这次按要求整体移除，代价是原图流量变大（第 38 条写了） |
| 批量操作 | 删除用 `delete(key[])`（R2 单次上限 1000 个 key）；**页面按每批 20 个封顶** | 一批 = 9 条引用扫描（D1，本身并发）+ 1 次 R2 批量删除；免费套餐**单请求子请求上限 50**，要留余量给列表列举与缩略图探测（每次 `head` 算一次） |
| 改名 / 移动 | 读原对象 → 写新 key → 删旧 key（3 次 R2 操作，`get().body` 直传 `put()` 流式） | R2 **没有** rename/copy；流式避免把 64 MB 视频读进 128 MB 的 Worker 内存。派生缩略图**不跟着搬**：按新 key 查不到就回退原图，旧缩略图变成垃圾对象（会体现在"派生缩略图"计数里） |
| 列举 / 扫描 | `list({ prefix, limit: 1000, cursor })` 分页拉，**只读元信息**（不取对象体）；到扫描上限就标"至少这么多" | R2 单次 list 上限 1000；元信息列举便宜，但页面仍按每页 10 条分页展示，不做全量渲染 |
| 引用与写入 | 引用判定只有 `scanReferences()` 一处；删除与改名一律"**有引用就拒绝**"，**不自动改写笔记内容** | 素材路径散落在 `news.image/video_url/content` 与 8 张配置表里；自动改写要动笔记正文，是本项目最容易出事故的操作（旧站同样是拒绝 + 人工处理） |

> 这些结论都落在代码里：键名前缀、去重、改名与批量删除都在 `core/storage.js`（`CACHE_CONTROL_MEDIA`/`moveMediaFile`/`removeMediaFiles`）
> 与 `app/admin/lib/mediaUpload.js`（`saveUpload` 的命名策略、`safeRelPath` 清洗、`uniqueKey` 去重）；
> R2 的调用形状在 `tests/admin_pages_tools.test.mjs` 里有断言（真实 R2 语义需按 `DEPLOY.md` 的验收清单线上实测一次）。
>
> **2.4.0 的两处调整**：① 缓存只剩"原图 7 天 immutable"一档（缩略图那档随功能删除）；
> ② 上传新增 `purpose=auto`/`name_mode=keep`/`rel_path` 三个可选参数（不传 = 老行为），并在写入前用 `head` 查重（每次上传 2 次子请求）。

## 开源方案评估：db_tools 为什么不直接部署现成的 Web UI

2.2.8 评估过 Outerbase Studio（支持 Cloudflare D1 的查询/数据/Schema 编辑器）、D1 Manager（社区 Web UI：多库、表结构、SQL、数据编辑、自然语言查询）、d1-manager（可视化 Schema、ER 图、级联模拟、撤销、FTS5、定时 R2 备份）。**结论：不引入外部项目，继续在现有后台里自研增强**（2.2.7/2.2.8 走的就是这条路）。

| 维度 | Outerbase Studio | D1 Manager | d1-manager | 本项目自研 `db_tools`（2.2.8） |
|---|---|---|---|---|
| 功能覆盖 | 查询/数据/Schema 编辑器，最接近桌面客户端（**含 DDL**） | 多库、表结构、SQL、数据编辑、自然语言查询 | 可视化 Schema、ER 图、级联模拟、撤销回滚、FTS5、定时 R2 备份 | 表清单（按需统计行数）+ **字段总览**（一屏读全库表与字段）+ 结构（默认值/主键/索引列）+ 数据（排序/字段筛选/跨列搜索/按需取整行/**行内编辑**/**批量复制与批量删除**）+ SQL（快捷语句/本机历史/结果分页与复制/**成本用量**）+ 危险操作二次确认与审计 |
| 部署方式 | 独立进程 / 自有域名（Pages 或 Node 侧） | 独立 Worker + 页面 + 自己的域名 | 独立 Worker + 定时任务 + R2 | **就在现有 Worker 里**，`wrangler deploy` 一次搞定，零新增部署目标 |
| 鉴权与权限 | 自带凭据体系，**无法复用**现有超管会话 | 自带口令或 Cloudflare Access | 自带口令或 Cloudflare Access | 复用超管登录 + `ENABLE_SQL_TOOL` 开关 + `entities` 写路径闸 + `auditLog` 审计 |
| 数据安全 | 需要把 **D1 的 API Token 交给它**；公网可达 = 多一个能读写全库的入口 | 同左 | 同左 | token 只在 Worker 环境变量里；页面默认关闭、仅超管、单语句 + 白名单业务表、敏感列打码 |
| 与现有路由/菜单整合 | 做不到（独立服务，只能外跳） | 只能外跳 | 只能外跳 | 就是侧栏「数据库管理」，地址与旧站一致（`/admin/db_tools`、`/admin/db_manage`） |
| 维护成本 | 跟上游版本 + 第二套依赖 + 第二个部署目标，升级要重新核对 D1 兼容性 | 同左 | 同左 + 定时任务与 R2 备份的运维 | 无新增依赖；本次只改 2 个文件 |
| 与既定策略是否冲突 | **冲突**：它鼓励在页面里改 Schema，本项目要求结构变更走 `app/sql/*.sql` + `wrangler` | 冲突 | 冲突 | 一致（DDL/事务/PRAGMA 一律拒绝） |

**如果将来一定要上外部方案**（例如真的需要 ER 图或跨库管理），最小代价的接法：同账号另建一个 Worker/Pages 项目 → 开 **Cloudflare Access**（只放行你们的邮箱域）→ 先用**只读** D1 权限 → 侧栏只加一个"外跳"入口，不把它的写能力接进现有后台。**待确认**：三者的最新部署与鉴权细节（它们迭代很快；本仓库没有引入依赖，所以不写死命令，要用时以各自 README 为准）。

**真正值得"抄"的是交互，不是部署形态** —— 2.2.8/2.2.9 就从它们身上搬了这些：表与字段一屏可读（含默认值、索引列、字段总览）、数据页就地排序/筛选/跨列搜索、单行复制成 JSON/INSERT/UPDATE 与**行内编辑**、批量勾选操作、查询历史与结果导出、以及 **成本可见**（D1 的 `rows_read`/`rows_written`/`duration` + 本机会话累计）。

## 六、部署（你自己执行）

```bash
wrangler deploy
# 自定义域: api.250036.xyz 指向这个 Worker(控制台或 wrangler.toml 的 routes)
# 旧 api0.250036.xyz 保持不动, 作为回滚入口
```
