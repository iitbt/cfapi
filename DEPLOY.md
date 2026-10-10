# 部署到 Cloudflare（照着做即可）

> 项目：`app/api-cf/`（Workers + D1 + R2，**只有对外 API，没有管理后台**）。
> 迁移设计见 `Plan.md`，接口台账见 `notes/api-inventory.md`，限流方案见 `notes/limits-design.md`，运营改数见 `notes/ops-sql.md`，本地跑法见 `README.md`。
> 代码与自测已完成（33 条接口、255 条用例全绿），本文件只讲"怎么推上云"。部署动作全部由你执行。

## 0. 命名约定（固定，不要改）

| 东西 | 名字 | 谁在用 |
|---|---|---|
| Worker / Pages | **`lyjxxapp-api`** | `wrangler.toml` 的 `name` |
| D1 数据库 | **`lyjxxapp-d1`** | `wrangler.toml` → `database_name`，绑定名 `DB` |
| R2 桶 | **`lyjxxapp-r2`** | `wrangler.toml` → `bucket_name`，绑定名 **`STORAGE`**（代码只从 `core/config.js` 的 `storage` 取，那里兼容早期的 `MEDIA`） |

**变量与密钥都已经在项目里预置好了 —— 你只需要改值或填密文，不用去控制台一个个新建**：

| 类型 | 在哪 | 内容 | 你要做什么 |
|---|---|---|---|
| 变量（明文） | `wrangler.toml` 的 `[vars]` | `MEDIA_BASE`、`DEV_WECHAT_MOCK`、`UPLOAD_MAX_BYTES`、`ENABLE_PUBLIC_PROBE`、`OBSERVABILITY_ENABLED`、`ALLOWED_ORIGINS`（CORS 白名单，`*`=放开）、`ENABLE_SQL_TOOL`（数据库工具开关，默认 `0` 关） | 改值 → 部署时自动写进 Cloudflare（Git 连接部署也会自动带上） |
| 密钥（密文，推给生产） | `.secrets.json`（模板 `.secrets.json.example`） | `WECHAT_APPID`、`WECHAT_SECRET`、`ADMIN_SESSION_SECRET` | 填值 → `npm run secrets:put`（等价 `wrangler secret bulk .secrets.json`，一次推三个） |
| 密钥（密文，本地开发） | `.dev.vars`（模板 `.dev.vars.example`） | 同上三个 | 只给 `npm run dev`（本地 `wrangler dev`）用；不填则本地登录页会写"后台未就绪" |
| 绑定 | `wrangler.toml` | D1 `DB`→`lyjxxapp-d1`、R2 `STORAGE`→`lyjxxapp-r2`、Cron `17 3 * * *` | 只需先把库与桶建出来（下面第 2、3 步） |

> 版本号 `API_VERSION` **不是变量**：唯一来源是 `main.js` 顶部的 `API_VERSION`（与旧站 `fastapi/main.py` 的 `APP_VERSION` 同位置），
> 状态页 / `/health/ready` / `/apitest` 展示它，也是后台静态资源的 `?v=` 缓存键；**改了样式或脚本要顺手升它再部署**。

> ⚠️ **库名额**：账号内 D1 已用 **9 / 10**，新建 `lyjxxapp-d1` 会占掉最后一个名额。
> ⚠️ **R2 桶名与 backend-cf 不同**：backend-cf 用的是 `lyjxxapp-media`，本项目要 **`lyjxxapp-r2`**，需要新建（不是同一个桶）。
> ⚠️ 密钥不能进仓库：真值文件 `.secrets.json`、`.dev.vars` 已在 `.gitignore` 里，只提交 `.example` 模板。
> ⚠️ **区域都选亚太**：D1 建库时的 **Location**、R2 建桶时的 **Location** 都选 **Asia Pacific**（就近中国大陆，延迟最低）。
> D1 的 Location **建库后不能改**（要换只能新建库再导一遍数据），所以第一次建库就选对；R2 桶同理。
> ⚠️ **千万不能靠"自动创建"**：`wrangler.toml` 里 `database_id` 留空时，wrangler 首次部署会按名字把库/桶**自动建出来**，而自动创建**不带 location hint → 落到默认区域（西欧）**，之后无法修改。本项目踩过一次（线上 D1/R2 都在西欧），根治办法与迁移步骤见 **「区域（Location）与资源重建」**。
> ⚠️ **`.secrets.json` 与 `.dev.vars` 都要填，但用途不同**：前者推给 Cloudflare（生产），后者只作用于本机 `npm run dev`。

---

## 路线 A：只用网页端（GitHub 连接部署，不敲 wrangler）

### A1. 把代码放进 GitHub
1. GitHub → `+` → **New repository** → 名字填 **`lyjxxapp-api`** → **Private** → Create。
2. 把 `app/api-cf/` 里的这些传上去：`app/`、`app/sql/`、`tools/`、`tests/`、`wrangler.toml`、`package.json`、`README.md`、`DEPLOY.md`。
   > 网页版最省事：仓库页 **Add file → Upload files**，把目录整体拖进去 → Commit。
   > **不要**传 `node_modules/`、`.wrangler/`、`out/`、`.secrets.json`、`.dev.vars`（`.gitignore` 已忽略，手动上传时留意别勾）。

### A2. 建 D1 数据库
1. 控制台 → **Workers & Pages → D1**（有的界面叫 **Storage & Databases → D1**）→ **Create database**。
2. 名字填 **`lyjxxapp-d1`**，**Location 选 `Asia Pacific`（亚太）** → 创建。
   > 这个 Location 是**建库时定死的**：选错只能新建库 + 重新导数据（见 A4），别等导完才发现。
3. 复制那串 **Database ID**（UUID），回 GitHub 编辑 `wrangler.toml`：把 `database_id` 那行注释取消并填上真值 → Commit。
   > **必须在本步手动建库并回填 ID**（这是"选对区域"的唯一时机）。曾经的写法是"`database_id` 留空，让首次部署自动建库"——那样建出来的库**没有 location hint，默认落在西欧**，且建后不可改，只能按「区域（Location）与资源重建」重来一遍。自动建的库还有第二个坑：本地 `wrangler d1 execute`/`d1 export` 定位不到它。

### A3. 建 R2 bucket 并开公开域
1. **Storage & Databases → R2 → Create bucket**，名字填 **`lyjxxapp-r2`**，**Location 选 `Asia Pacific`（亚太）**（桶保持**私有**，公开读用自定义域单独开）。
   > 同样**必须手动建**：部署时若桶不存在，wrangler 会按 `bucket_name` 自动建一个**不带 location hint** 的桶（默认区域，建后不可改）—— 见「区域（Location）与资源重建」。
2. 进 bucket → **Settings → Public access → Custom Domain** → 填 **`storage.250036.xyz`** → 按提示加 DNS 记录。
3. 完成后 `https://storage.250036.xyz/<key>` 能直接打开对象（先把素材传上去才验证得了，见"素材上传"）。
4. 绑定名固定是 **`STORAGE`**（`wrangler.toml` 的 `[[r2_buckets]].binding`）：代码侧统一读 `core/config.js` 的 `storage`，改绑定时只改这一个字段即可（`MEDIA` 是早期名字，代码仍兼容，避免改绑定期出现空窗）。

### A4. 建表 + 导数据（都在 D1 控制台逐块粘贴）

D1 的导入只有 **wrangler 命令**与**控制台 Console** 两条路（官方**没有**"上传 SQL 文件"入口），而
`0001` 约 11 KB、整份数据 84 KB，一次性粘会被截断。所以先用 `split_sql.py` 把两者都拆成"每块 ≤ 6 KB"，再按序号逐块粘：

```powershell
cd app\api-cf
# 1) 拆建表 → out\schema（5 块，含后台用的 admin_users）
python scripts\split_sql.py out\schema app\sql\0001_schema.sql app\sql\0002_rate_limit.sql app\sql\0003_wechat_token.sql app\sql\0004_admin.sql
# 2) 导出数据并拆块 → out\seed（14 块）
python scripts\export_sqlite.py ..\..\fastapi\data\lyjx.db out\seed.sql
python scripts\split_sql.py out\seed out\seed.sql
```

进 `lyjxxapp-d1` 库 → **Console / Query**，按文件名的两位序号从小到大逐块粘贴 → Run：

| 阶段 | 文件 | 内容 | 预期 |
|---|---|---|---|
| 建表 | `out/schema/01_0001_schema.sql` | `0001` 的前 12 条语句 | 无报错 |
| 建表 | `out/schema/02_0001_schema.sql` | 余下 51 条（索引为主） | 无报错 |
| 建表 | `out/schema/03_0002_rate_limit.sql` | `rate_limit_counters` 限流计数表 | 无报错 |
| 建表 | `out/schema/04_0003_wechat_token.sql` | `wechat_tokens` 微信 token 缓存表 | 无报错 |
| 建表 | `out/schema/05_0004_admin.sql` | `admin_users` 管理员账号表（后台登录用） | 无报错 |
| 导数据 | `out/seed/01_seed.sql` … `14_seed.sql` | 196 行数据 | 逐块 Run 无报错 |

要点：

- **先建表再导数据**，否则数据块全部报 `no such table`。
- 每块**块头注释**写了"本块涉及哪些表"，出错时按它定位。
- 数据块是 `INSERT OR REPLACE`，**可以反复粘贴**（切换前重跑导出补新数据也安全）；建表块只在第一次成功，重跑会报 `table ... already exists`，属正常。
- 正文里的换行是**真实换行**（一条 INSERT 可能占多行），复制时整块全选，别只框一行。
- 校验：表共 **21** 张（18 业务 + 限流 + token + `admin_users`）；`SELECT COUNT(*) FROM news` = **69**、`users` = **4**、`banner_images` = **18**。
- 想少粘几次：加 `--max-bytes 30000` 拆成 3 块（约 33/32/21 KB，实测可执行）；粘不动或报错再回到默认的 14 块。
- 试错没有代价：数据块是 `INSERT OR REPLACE`，粘重复了也只是覆盖同一行；建表块重跑才会报 `already exists`。

> 不想手工粘：把 Database ID 回填 `wrangler.toml` 后，一条命令即可 ——
> `wrangler d1 execute lyjxxapp-d1 --remote --file=out/seed.sql`（建表同理，换成 `app/sql/0001~0003`）。

> `0001` 是**从旧库真实 DDL 导出**的：旧后端启动会补列补索引，静态 sql 文件比线上库少 1 列与 7 条索引，别用 `fastapi/app/sql/schema_sqlite.sql` 代替。

### A5. 建 Worker 并连 Git
1. **Workers & Pages → Create → Workers → Connect to Git**。
2. 选仓库 → 分支 `main`。
3. 构建设置（照填）：
   - **Build command**：留空（零依赖、零构建）
   - **Deploy command**：`npx wrangler deploy`
   - **Root directory**：把 `app/api-cf` 内容当仓库根传的 → 留空；整仓库传的 → 填 `app/api-cf`
4. **Deploy**。构建日志若报 *binding DB … database_id* 相关错误 → 回 A2：要么把真值填对，要么把那行**整行注释掉**让 wrangler 自动预置，再 push。
   > Git 连接部署时，`[vars]` 与绑定会**自动生效**（不用去控制台手点）；**Cron 也会跟着部署**。

### A6. 只需配三个密钥
Worker → **Settings → Variables and Secrets** → 加三个**加密**类型：`WECHAT_APPID`、`WECHAT_SECRET`、`ADMIN_SESSION_SECRET`（后台会话密钥，32+ 位随机字符）→ 配完 **Deployments → 最新一条 → Retry deployment**。

| 文件 | 作用范围 | 怎么生效 |
|---|---|---|
| `.dev.vars`（模板 `.dev.vars.example`） | **只作用于本机** | `npm run dev`（`wrangler dev`）启动时读取；不填则本地后台登录页写"后台未就绪" |
| `.secrets.json`（模板 `.secrets.json.example`） | **推给 Cloudflare（生产）** | `npm run secrets:put`（= `wrangler secret bulk .secrets.json`）；本地跑 `dev` 时它**不生效** |

> 两个文件都要填（同一个 3 项），但它们互不替代：一个管本机，一个管线上。Git 连接部署时，生产密钥仍要在控制台配一次（或用 B6 的命令推）。

#### 怎么生成 `ADMIN_SESSION_SECRET`

它是后台会话 Cookie 的 **HMAC 签名密钥**：只要一串**随机**字符（32 位以上），**不要**用有意义的口令。任选一种生成方式：

```powershell
# 方式一（推荐，项目本来就要求 Node 22+）：生成 64 位十六进制
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 方式二（Windows 自带 PowerShell / .NET，无需额外安装）
$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
-join ($b | ForEach-Object { $_.ToString('x2') })

# 方式三（装了 git 就有 openssl）
openssl rand -hex 32
```

拿到那串字符后三处任一（推荐前两处都填）：

| 放到哪 | 怎么做 |
|---|---|
| `.secrets.json`（生产） | 填 `"ADMIN_SESSION_SECRET": "<那串字符>"` → `npm run secrets:put` |
| `.dev.vars`（本机） | 填 `ADMIN_SESSION_SECRET="<那串字符>"` → 重启 `npm run dev` |
| 控制台（不想用命令行时） | Worker → **Settings → Variables and Secrets** → 加**加密**类型 `ADMIN_SESSION_SECRET` → Retry deployment |

注意：① 它是**密文**，别提交进仓库（`.secrets.json` / `.dev.vars` 已在 `.gitignore`）；② **换了它，所有已登录的后台会话立刻失效**（管理员要重新登录，小程序不受影响）；③ 不配它时后台登录页会写"后台未就绪"（不会用默认值放行）。

**想先用假微信走通全流程**：把 `wrangler.toml` 的 `DEV_WECHAT_MOCK` 改成 `"1"` 再部署（不调微信、不做昵称送审，任意 `code` 都能登录，便于验收）；正式上线改回 `"0"` 并配真密钥。

### A7. 自定义域

Worker → **Settings → Domains & Routes → Add → Custom domain**。本项目实际只用两个域名：

| 域名 | 指向 | 用途 |
|---|---|---|
| **`lyjx.250036.xyz`** | 这个 Worker（`lyjxxapp-api`） | 小程序接口 **+** 管理后台 `/admin`，同一域名 |
| `storage.250036.xyz` | R2 桶 `lyjxxapp-r2` 的公开域（见 A3） | 素材直读 |

> 早期规划中的 `api.250036.xyz` / `pages.250036.xyz` **没有采用**：`api.250036.xyz` 至今指向旧站 FastAPI（也是回滚线路），
> 而协议 / 隐私 / 下载等静态页由同一个 Worker 的 `/pages/*` 提供，不需要单独的 Pages 项目。

**顺手加白名单**：微信公众平台 → 开发管理 → 服务器域名 → **request 合法域名**：
`https://lyjx.250036.xyz`、`https://storage.250036.xyz`（旧线路 `https://api0.250036.xyz` 一起留着，回滚要用）。

### A8. 进管理后台（`/admin`）

后台与对外 API 在**同一个 Worker** 里，路径前缀 `/admin`（本项目实际域名：`https://lyjx.250036.xyz/admin`）。
**没有初始用户名/口令** —— 第一个管理员由你在下面第 3 步自己设定（默认口令是后台被扫号的头号入口，刻意不预置）。

| # | 做什么 | 说明 |
|---|---|---|
| 1 | 建 `admin_users` 表 | 见 A4 的第 5 块：`app/sql/0004_admin.sql` |
| 2 | 配会话密钥 | 控制台 **Settings → Variables and Secrets** 加一个**加密**变量 `ADMIN_SESSION_SECRET`（一串 32+ 位随机字符），或 `wrangler secret put ADMIN_SESSION_SECRET`；不配时登录页会写"后台未就绪"（不会用默认值放行） |
| 3 | 首次初始化 | 浏览器打开 `https://lyjx.250036.xyz/admin/bootstrap`，填用户名 / 昵称 / 口令 → 提交后回到登录页，用这套账号登录 |

第 3 步的字段规则：

| 字段 | 规则 |
|---|---|
| 用户名 | 表单预填 `admin`；只能用 `字母 数字 _ . -`，3~32 位 |
| 昵称 | 可留空（留空取用户名） |
| 口令 | **至少 10 位**（与旧站一致） |

**`/admin/bootstrap` 只在 `admin_users` 为空时可用**，建完自动失效（再访问会提示"已经初始化过"），不必担心被别人抢先建号。

### A8.5 两个"超管工具位"（数据库管理 / 素材库治理）

| 页面 | 地址 | 开关与闸门 | 能做什么 |
|---|---|---|---|
| 数据库管理（原「数据库工具」，2.2.9 改名，地址未变） | `/admin/db_tools`、`/admin/db_manage` | **默认关闭**：先把 `ENABLE_SQL_TOOL` 设为 `"1"` 再部署；另外仅超管可见（页面 GET 自查 + 写路径由 `entities` 拦） | 表清单（行数按视图按需统计、可一键关掉，表名可本地筛选）＋ **字段总览**（`?view=columns`：一屏列出全库表与字段，`?table=` 只看一张表）＋ 每表**结构**（列/类型/可空/默认值/主键/索引及索引列，可复制列名与建表语句，每列可跳"按此列排序/筛选"）＋ **数据分页**（点列头排序、按字段筛选、跨列关键字搜索、20/50 行一页、**按需取整行**后复制 JSON/INSERT、生成 UPDATE 或**直接编辑这一行**，行首可勾选**批量复制/批量删除**）＋ **SQL 执行**（只允许 SELECT / INSERT / UPDATE / DELETE 的**单条**语句、只能操作白名单业务表、写语句二次确认、无 WHERE 额外告警、结果可翻页/复制、**显示 D1 用量做成本估算**、失败给数据库原文）＋ **成本与额度卡**（参考用量快照 + 本机会话累计） |
| 存储桶资源管理（原「素材库管理」） | `/admin/media_manage` | 仅超管（菜单与页面都对普通管理员隐藏） | 2.4.6 起是**整个 R2 桶的资源管理器**：按前缀**逐层浏览**（`?prefix=<目录/>`，面包屑 + 上一级；根层 = 桶根），层内按类型（`?kind=all\|image\|video\|other`）/引用状态（`?ref=used\|unused`）/关键词（`?q=`）/排序（`?sort=`）筛选（都作用于**当前这一层**）；行内提供 **详情**（`/admin/media_manage_detail`）、**改名·移动**（`/admin/media_manage_rename`，目标目录可填任意前缀）、**复制**（同页勾选）、**删除**（确认页 + 批量 `paths=` 逗号列表），目录行提供 **移动**（≤10 个/次）与 **删除**（≤20 个/次，`/admin/media_manage_dir`）；**上传**仍复用 `/admin/image_upload`；素材路径（`image/`、`video/`、`news_uploads/` 与根目录树里的图片/视频）**有引用一律拒绝**（引用含回收站笔记）、提交前再复查一次；站内资源（`avatar/`、`images/`、`assets/` 等）不做引用扫描 |

> 为什么数据库工具默认关：这一页能浏览全表数据、也能执行 SQL —— 与旧站同一个口径（`ENABLE_SQL_TOOL` 生产默认关）。
> 用完建议改回 `"0"` 再部署一次。

#### 验收（照着打一遍）

| 请求 | 期望 |
|---|---|
| `GET https://lyjx.250036.xyz/admin` | **302** → `/admin/login?next=/admin/dashboard` |
| `GET /admin/login` | **200** 出登录表单（若写"后台未就绪"，说明第 2 步没配好） |
| `GET /admin/bootstrap` | 表空时 **200** 出表单；已初始化则提示"已经初始化过" |
| `GET /admin/dashboard`（不带 Cookie） | **302** 回登录页 |
| 登录后再访问 `/admin/dashboard` | **200**，右上角显示登录用户名，四个统计与 D1 行数一致 |

#### 忘记口令怎么办

后台没有"找回密码"通道（也不该有邮件/短信那条路）。最省的重置方式是在 D1 Console 执行：

```sql
DELETE FROM admin_users;   -- 清掉全部管理员(通常只有 1 个)
```

然后重新打开 `/admin/bootstrap` 建一次（用户名沿用 `admin` 即可与旧站一致）。

#### 口令与会话是怎么存的

| 项 | 做法 |
|---|---|
| 口令存储 | 只存 **PBKDF2-SHA256** 哈希（`pbkdf2_sha256$迭代数$salt$hash`），明文不落库，代码与文档里也没有 |
| 为什么不是 bcrypt | Workers 免费套餐 CPU 只有 **10ms/请求**，bcrypt 要 100~300ms（直接报 Error 1102），连 PBKDF2 十万轮也会超；当前用 10000 轮 + 登录限速补偿。旧库 `admin_users` 的 bcrypt 口令**不能沿用**，bootstrap 时用同样用户名重建一次即可 |
| 会话 | `HttpOnly; SameSite=Strict` 的 HMAC 签名 Cookie（`Secure` **只在 https 下发** —— http 页面下浏览器会直接丢弃带 Secure 的 Cookie，本地预览会表现为"登录成功却立刻回到登录页"），载荷含 `id / 用户名 / 角色 / 过期时间 / 口令指纹`（改了口令即踢下线） |
| 登录限速 | IP 级 5 次 / 15 分钟锁定，外加同一账号 10 次 / 15 分钟；失败提示统一"用户名或密码错误"（与旧站 `admin/auth.py` 逐字一致，不暴露账号是否存在） |
| 登出 | `POST /admin/logout`（只收 POST，避免第三方用 `<img src="/admin/logout">` 把人踢下线） |

> 目录结构、迁移进度、与旧站的逐项差异见 `admin/README.md`。

### A9. 后台能做什么（迁移后的功能清单）

| 分组 | 页面 | 备注 |
|---|---|---|
| 概览 | 控制面板 | 13 张统计卡 + 近 7 日用户/笔记趋势（纯 SVG，不引图表库）+ 最新用户/笔记/留言 |
| 用户与审核 | 用户管理（详情、设为/取消内部测试、恢复注销账号、删除）、管理员管理 | 敏感操作仅超管可见，服务端也拦 |
| 内容管理 | 笔记管理（发布/编辑/预览/回收站/批量）、分类、通知公告、留言 | 删除走服务端确认页，先摊开影响面 |
| 笔记预览 | `/admin/news_preview?id=<id>` | 任何登录管理员 | 800px「小程序尺度」预览框（`.mp-preview.mp-frame`）：封面 → 卡片（标题/副标题/分类·时间/管理员介绍）；正文走「净化 → `<wx-video>` 转 `<video>` → 相对地址拼媒体域」，**图片与视频一律用原图地址**（2.4.0 起不再替换 800px 缩略图） |
| 笔记编辑 | `/admin/news_edit?id=<id>` | 任何登录管理员 | 富文本编辑器 + 三种插图入口；字段顺序与旧站一致（标题→分类→封面→视频地址→摘要→正文→**发布设置卡**→**数据统计卡**），单列 800px 居中（与预览页同一套尺度） |
| 小程序配置 | 首页板块（含原「首页精选」——2.2.5 起合并到 `/admin/app_home_manage` 的「精选项目」）、专题精选（摩旅/户外）、轮播图、版本更新、运营文案、我的页菜单 | 改完按端上缓存策略刷新 |
| 系统 | 管理员设置（改昵称/邮箱/口令）、系统信息 | 改口令后强制重新登录 |
| **不迁移** | 数据库工具、素材库治理页（查占用/查引用/删素材） | 菜单里标「未迁移」并说明原因，用 D1 控制台代替 |

上传说明：笔记封面/正文插图/轮播图/专题封面走 `POST /admin/image_upload` 写入 **R2**（图片 `image/`、视频 `video/`；历史素材仍在 `news_uploads/`，两边都能读），
视频走同一入口的 `purpose=video` 分支（按文件头嗅探类型，不只看扩展名）。
**缩略图功能已按 2.4.0 整体移除**（原始实现见 `README.md` 第 38 条）：列表/详情/预览/对外接口一律用原图，桶里也没有派生文件需要生成。

> ⚠️ **改了 `admin/static/**`（样式/脚本）或后台页面模板 → 必须升 `main.js` 的 `API_VERSION` 再部署**：
> 资源地址带 `?v=<main.js 的 API_VERSION>` 且缓存一天，图标字体缓存一年；不升版本号浏览器会继续用旧文件。

---

## 路线 B：wrangler 命令行

```powershell
cd D:\Users\Administrator\Desktop\开发者\xapp\iitbt\app\api-cf
```

### B1. 登录
```powershell
wrangler login                      # 方式一: 浏览器授权

# 方式二: API Token(无浏览器/CI)
# 控制台 → My Profile → API Tokens → Create Token, 权限: Workers Scripts:Edit、D1:Edit、R2:Edit、Account Settings:Read
$env:CLOUDFLARE_API_TOKEN = '<token>'
$env:CLOUDFLARE_ACCOUNT_ID = '<Account ID>'
wrangler whoami
```

### B2. 建 D1 并回填 id
```powershell
wrangler d1 create lyjxxapp-d1 --location apac
# --location apac = 亚太(就近中国大陆); 控制台建库就是 Location 选 Asia Pacific
# 这个位置建库后不可改, 选错只能新建库再导一遍数据
# 把输出的 database_id 填回 wrangler.toml 的 [[d1_databases]].database_id
```

### B3. 建 R2 bucket
```powershell
wrangler r2 bucket create lyjxxapp-r2 --location apac
# 同样选亚太; 绑定名固定 STORAGE(见 wrangler.toml 的 [[r2_buckets]] 与 A3 第 4 步)
wrangler r2 bucket list
```

### B4. 建表（远端，一条命令）
```powershell
npm run schema:remote
# 等价于:
#   wrangler d1 execute lyjxxapp-d1 --remote --file=app/sql/0001_schema.sql
#   wrangler d1 execute lyjxxapp-d1 --remote --file=app/sql/0002_rate_limit.sql
#   wrangler d1 execute lyjxxapp-d1 --remote --file=app/sql/0003_wechat_token.sql

# 核对: 应为 20 张表(18 业务 + 限流表 + token 表)
wrangler d1 execute lyjxxapp-d1 --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```
> 想先本地演练：`npm run schema:local`（本地文件在 `.wrangler/` 下，不动线上）。

### B5. 搬迁数据（旧库只读，旧后端不受影响）
```powershell
python scripts\export_sqlite.py ..\..\fastapi\data\lyjx.db out\seed.sql
wrangler d1 execute lyjxxapp-d1 --remote --file=out\seed.sql
python scripts\verify_counts.py ..\..\fastapi\data\lyjx.db      # 必须 0 差异
```
> 预期总量：18 张表 196 行（`users` 4、`news` 69、`banner_images` 18 …）。
> **切换前再跑一次前两步**，把旧库这段时间的新数据补上（按主键覆盖，重复执行安全）。

### B6. 密钥（改值就行，不用去控制台）
```powershell
# 1) 复制模板并填真值
copy .secrets.json.example .secrets.json
#    编辑 .secrets.json: {"WECHAT_APPID":"...","WECHAT_SECRET":"...","ADMIN_SESSION_SECRET":"..."}
# 2) 一条命令推上 Cloudflare
npm run secrets:put
#    等价: wrangler secret bulk .secrets.json
```
> 若你的 wrangler 版本不支持 `secret bulk`（以官方文档为准），退回逐条：`wrangler secret put WECHAT_APPID`、`wrangler secret put WECHAT_SECRET`、`wrangler secret put ADMIN_SESSION_SECRET`。
> 本地开发用 `.dev.vars`（`copy .dev.vars.example .dev.vars` 后填同一个三项），变量仍来自 `wrangler.toml` 的 `[vars]`。
> 一句话记：**`.dev.vars` 管本机 `npm run dev`，`.secrets.json` 管生产 `npm run secrets:put`** —— 两个都填。

### B7. 本地自检（部署前）
```powershell
npm test          # 255 条用例, 应全绿(不需要账号与网络)
npm run dev       # 本地起服务 http://127.0.0.1:8787, 先看 / 与 /health/ready
```

### B8. 部署
```powershell
npm run deploy    # 等价 wrangler deploy; 成功会给出 https://lyjxxapp-api.<子域>.workers.dev
```

### B9. 自定义域
```toml
# wrangler.toml 里加, 然后重新部署(媒体域 storage.250036.xyz 不在这里 —— 它绑的是 R2 桶, 见 A3)
routes = [
  { pattern = "lyjx.250036.xyz", custom_domain = true }
]
```

### B10. 日志与回滚
```powershell
wrangler tail                        # 实时日志(带 request-id), 免费额度内可用
wrangler deployments list
wrangler rollback                    # 回退到上一个版本
wrangler d1 execute lyjxxapp-d1 --remote --command "SELECT scope,bucket_key,count FROM rate_limit_counters ORDER BY window_start DESC LIMIT 10"
```

### B11. 定时清理（已配好，确认一下）
`wrangler.toml` 已声明 `[triggers] crons = ["17 3 * * *"]`，`main.js` 的 `scheduled` 每天清一次过期计数行。部署后在 Worker → **Settings → Triggers** 应能看到这条 Cron。

### B12.（可选）GitHub Actions 自动部署
```yaml
name: deploy-api
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          workingDirectory: app/api-cf
          command: deploy
```

---

## 素材上传（别漏 `images/`）

实测体量：`news_uploads/` 23 个文件 0.57 MB（全在 `home/`），`avatar_uploads/` 空，`app/images/` 4 个文件。详见 `tools/media_to_r2.md`：

1. **上传时保持 key = 库内相对路径**：历史素材仍是 `news_uploads/...`、`avatar_uploads/...`，新上传的走 `image/`、`video/`、`avatar/`（数据库字段一个字都不用改，见下节「素材目录」）。
2. **`app/images` 必须传到 `images/` 前缀**（Worker 的 `/images/*` 从这里读，不传则「我的」页菜单图标 404；**站点图标 `/favicon.ico` 不在这里** —— 它已内联进 Worker，见下节）：
   ```powershell
   wrangler r2 object put lyjxxapp-r2/images/user.jpg --file=..\..\fastapi\app\images\user.jpg
   # 文件多时用 rclone(需 R2 的 S3 凭据): rclone copy ..\..\fastapi\app\images r2:lyjxxapp-r2/images
   ```
3. 抽查：`https://storage.250036.xyz/news_uploads/home/<某个图>` 能打开。

---

## 素材目录（新目录 + 历史目录共存）

| 类型 | 新上传落哪 | 历史素材还在哪 | 谁在写 |
|---|---|---|---|
| 笔记封面/正文插图/轮播图/精选图标 | `image/` | `news_uploads/` | 后台「本地上传」→ `POST /admin/image_upload`（purpose=cover/content） |
| 视频（笔记视频、专题视频） | `video/` | `news_uploads/` | 同上（purpose=video） |
| 小程序头像 | `avatar/` | `avatar_uploads/` | `POST /user/upload_avatar` |

口径（真值在 `app/core/storage.js`，只有这一处定义）：

- **列举/引用判定同时覆盖新目录与历史目录**（`MEDIA_PREFIXES`）：素材库弹窗、素材占用统计、素材治理页的"是否被引用"都把两个目录算进来，所以老素材不会"消失"，新素材也不会被误判成未引用。
- **Worker 直出同时覆盖新旧路径**（`SERVED_PREFIXES`）：`/image/*`、`/video/*`、`/avatar/*`、`/news_uploads/*`、`/avatar_uploads/*`、`/images/*`，都带 `etag` + `cache-control` + `accept-ranges`（Range 回 206）。
- **数据库里存的是相对路径，一个字段都不用改**：历史值（`news_uploads/…`）继续有效，新值（`image/…`）由 `MEDIA_BASE` 拼绝对地址下发。**不需要迁移数据、也不需要搬动 R2 对象**。

### 缩略图（2.4.0 起**已整体移除**）

原来那套"目录随原图走"的派生规则（`<素材目录>_thumb/<宽>/`、`thumbKeyOf`、`image_thumb` 下发、
预览页 800px 替换、离线生成工具 `tools/thumb_plan.mjs`）**全部删掉了**，现在：

- **前端一律用原图**：素材库列表（≤512KB 的小图直接出预览，大图给占位）、素材详情页、笔记预览页
  （封面/正文配图/主视频都是原图地址）、素材库弹窗（列表与预览都用原图）。
- **对外接口**：`/news/list` **不再下发 `image_thumb`**。小程序侧本来就是"没有这个键就回退原图"，
  所以老版本客户端不用改，只是流量会比以前大（这正是移除缩略图的代价）。
- **代价（明确写下来）**：预览页的大图会直出原图（本站素材单张可达数十 MB，旧站实测 65~83 秒）；
  小程序的封面/列表图也要自己扛原图流量。若以后流量压力大，要么重新引入派生缩略图（离线生成 + 上传，
  Workers 免费版仍然不能在线生成），要么上 Cloudflare Images/Image Resizing（另外的功能与计费项，**待确认**）。
- **存量历史缩略图怎么清（本次**没有**自动删）**：桶里 `<素材目录>_thumb/` 下的对象仍在（历史上只有极少量：
  实测 `news_uploads/_thumb/` 与 `image/_thumb/` 各一两个文件）。两条清理路径：
  1. **用素材库页**：`/admin/media_manage` 的清单现在**不再跳过** `_thumb/` 对象（它们就是普通素材），
     用「目录」筛选定位后勾选批量删除（删除前的引用检查照旧跑）；
  2. **用命令行一次删净**（推荐，量大时更省事）：
     ```powershell
     wrangler r2 object list lyjxxapp-r2 --prefix=image/_thumb        # 先看有什么
     wrangler r2 object delete lyjxxapp-r2 --prefix=image/_thumb      # 确认后再删(按前缀)
     # 三个素材目录各来一遍: image/_thumb、video/_thumb、news_uploads/_thumb
     ```
  删除后公开域上可能还有最长 7 天的边缘缓存副本（`CACHE_CONTROL_MEDIA` 的 TTL），到期即消失。
  **待确认**：是否现在就执行清理（我这边没有桶的操作凭据，只给方案）。

### 素材上传的命名与限制（2.4.0 起；2.4.1 起入口按类型拆开；2.4.2 起目录结构整棵保留；2.4.3 起可改目标路径）

- **素材库页 2.4.1 起有两个独立入口**（图片 → `image/`、视频 → `video/`），每个入口都能「选文件（可多选）」或「选文件夹（含子目录）」：

  | 入口 | 发出的 purpose | 落到哪 | 说明 |
  |---|---|---|---|
  | 图片上传 | `cover` | `image/` | 只收图片（按文件头判），文件夹上传时内部子目录保留 |
  | 视频上传 | `video` | `video/` | 只收视频，同上 |
  | （接口保留） | `auto` | 按内容自动分流 | 2.4.0 的行为，页面已不用；脚本调用方仍可用 |

- **按钮文案**（2.4.2）：每个入口两个按钮 —— 「选择文件」（可多选）与「选择文件夹」（含子目录）。
  原生的 file 控件按钮文字由浏览器决定（`webkitdirectory` 只改弹出的对话框，按钮仍显示"选择文件"），
  所以两个 input 都是隐藏的，文案由 `label.btn` 提供；点按钮照样拉起系统选择框。

- **目标路径（2.4.3 起可选；2.4.4 起是"下拉可选 + 支持根目录"）**：每个入口一个 `<select>`，**默认就是 `image/` 与 `video/`**
  （不碰它行为与 2.4.2 完全一致）。可选项 = **根目录** + 本入口根目录 + **桶里已存在的各级目录**（来自列表页已有的那次列举，不额外发请求；
  层级用缩进表示），另有一项「其它（手动填写）」，选中才露出手填框（归档到一个还不存在的新目录时用，如 `image/2026-10/`）。
  文件落点 = `<目标路径>/<相对路径的目录>/<文件名>`（与 2.4.2 的文件夹结构**叠加**）。
  规则：图片只能写在 `image/` 下（或根目录）、视频只能写在 `video/` 下（或根目录）—— 写进对方目录会让素材库列不出来，所以直接拒绝；
  `avatar/`、`news_uploads/` 不在允许范围；`..`、绝对路径、空段、控制字符、`?#%`、超长一律拒绝（不做静默改写），
  `\` 归一成 `/`、尾斜杠自动补齐。前后端各校验一遍（前端开跑前拦，免得整批文件各失败一次）。
- **根目录（存储桶最外层）**：下拉第一项，**提交值是 `/`**（空串已被"没传 = 默认"占用），后端 `safeTargetDir` 把它翻成"空前缀" ——
  key 就是文件名或相对路径本身（`logo.png`、`素材/子/图.png`）。**根目录那一块在素材库里同样看得到、能筛选、能改能删**：
  列举会覆盖**整棵树**（根下文件 + 根下自定义目录，见 2.4.5），`normRel` 认这类记录值，目录筛选是「根目录」这一档（`?dir=/`），
  引用判定按候选名单精确命中。⚠️ `avatar/`、`avatar_uploads/`、`images/` 是**站内自有目录**（Worker 直出的用户头像与站点图标），
  它们**不进素材库** —— 这是有意的，不是漏扫。

- **子目录保留规则（2.4.2 起：整棵树都留）**：key = `<类型目录（入口决定）>/<相对路径>`，
  **连你选中的那层顶层文件夹名一起保留**（2.4.0/2.4.1 会剥掉顶层那层，2.4.2 不剥了）。
  例：选文件夹「素材」上传 → `image/素材/根目录图.png`（直接放在所选文件夹里的文件就落在这一层）、
  `video/素材/相册/子目录/片子.mp4`。**两种命名模式都保留目录**：「保留原名」文件名也不变，
  「自动生成」只把文件名换成 `<用途>_<时间戳>.<ext>`（目录照带）；空文件夹不保留（R2 没有目录，浏览器也不会列出空目录）。
  相对路径一律经 `safeRelPath` 清洗：`\`→`/`、去 `..` 与空段、剥控制字符与盘符段、`?`/`#`/`%`→`_`
  （公开域是 `${MEDIA_BASE}/${路径}` 直拼，带 `#`/`%` 的名字传上去也点不开）、每段 ≤120 字、总长 ≤300 字。
- **接口仍是既有的 `POST /admin/image_upload`**（旧地址 `POST /admin/news_image_upload` 等价），只是多了三个可选参数：

  | 参数 | 取值 | 说明 |
  |---|---|---|
  | `purpose` | `cover`(默认) / `content` / `video` / `auto` | 目录与命名前缀都跟着它走（见上表） |
  | `name_mode` | `auto`(默认) / **`keep`** | 只决定**文件名那一截**：`keep` = 保留原名；`auto` = `<用途>_<时间戳>.<ext>`。目录由 `rel_path` 决定，两种模式都保留 |
  | `rel_path` | 形如 `素材/子目录/文件名.png` | **2.4.2 起两种模式都生效**（2.4.0/2.4.1 只在 `keep` 模式用）；做**路径清洗**：`\`→`/`、去掉 `..`/空段/控制字符/盘符段、`?`/`#`/`%`→`_`、每段 ≤120 字、总长 ≤300 字 |
  | `target_dir` | 形如 `image/2026-10/`，或 **`/`** 表示存储桶根目录 | **2.4.3 新增（可选）**；不传 = 按类型落 `image/`、`video/`。只允许本入口根目录及其子目录（图片 `image/…`、视频 `video/…`）**或者根目录 `/`**；**清洗后必须与输入一致，否则拒绝**（不做静默改写）；与 `rel_path` 叠加：`<target_dir>/<rel_path 的目录>/<文件名>`（根目录时 key 不带任何前缀） |

- **重名冲突**：**绝不覆盖**。写入前 `head` 探一次目标 key，已存在就顺延 `_1`/`_2`…（最多 20 次，仍冲突则报错让你改名）。自动生成模式因为带时间戳，正常不会撞；同类并发上传撞上了也会自动顺延。
- **类型判定**：只认**文件内容**（图片看 JPEG/PNG/GIF/BMP/WEBP 头，视频看 ISO-BMFF/EBML），扩展名只作白名单（jpg/jpeg/png/gif/webp/mp4/mov/m4v/webm）。**入口即类型**：图片入口塞视频会被拒（同理视频入口塞图片），这样"文件夹里混进异类"会在进度条上直接报错，而不是静默落进另一个目录。
- **大小上限**：图片 8 MB、视频 64 MB（沿用旧站口径，超了在页面上直接报"文件过大"）。
- **文件夹上传**：页面用浏览器的 `webkitdirectory`（原生目录选择），**整棵目录树原样保留**（含你选中的那层顶层文件夹名）。子目录会成为 key 的一部分（如 `image/素材/相册/子目录/图.png`），R2 没有真目录（key 里的 `/` 只是名字的一部分）、公开域照常访问；空文件夹不会保留（R2 与浏览器两边都没有它）。
- **进度条**：前端用 `XMLHttpRequest.upload.onprogress`（**fetch 拿不到上传进度**），**一次请求一个文件、顺序上传**，所以能看到"当前文件百分比 + 整体字节进度 + 成功/失败/跳过计数"；失败项留在列表里可**重试**或**跳过**。服务端不报进度（Workers 里没有可用于"已接收字节"的进度接口，不要指望这个）。
- **R2 / Workers 限制与应对**（都是平台事实）：
  - 单请求体上限：免费套餐 100 MB/请求；本站更严（图片 8 MB / 视频 64 MB），且 **multipart 不受 5 MB 的 body 限制**（`middleware.bodyTooLarge` 对 multipart 直接放行）。
  - 子请求预算：免费套餐 50 次/请求 —— 每次上传 = 1 次 `head`（查重）+ 1 次 `put`，量很小；批量删除才需要按 20 分批。
  - 上传超时/并发：Workers 有单请求时长与并发限制，所以**顺序上传**（不并发几十个文件）既对进度友好，也不会自己打满并发；文件夹里文件很多时建议分批选。
  - 大文件：放到站内上限（64 MB）已经接近免费套餐的舒适区；更大的视频建议直接用 rclone/S3 直传桶（不经 Worker），再把相对路径填进后台字段。
  - **滚动加载（2.4.1）与子请求预算**：素材库页是"列 R2 + 内存切页"（R2 没有服务端分页），所以**每往下翻一页 = 2 趟 R2 列举**
    （`kind=all` 时图片/视频各一趟，单趟上限 1000 个对象）+ **9 条 D1 引用扫描**（并发）≈ 11 次子请求 —— 免费套餐 50 次/请求够用，
    但它意味着"翻到底"会重复列举同一批对象；素材涨到上千后再看要不要加短期缓存（**待确认**）。
  - **文件夹上传不会撑大单请求**：文件夹只是"一次选中多个文件"，仍然是**一个文件一个请求**（与进度条配套），
    所以不存在"一次请求体超过 100 MB"的问题；真正会撞上限的是单个 64 MB 的视频，与是否选文件夹无关。

---

## 富文本编辑器（`news_edit` 正文）

编辑器是 **wangEditor v5.1.23**（与旧站同一个版本、同一套初始化逻辑），但**资源自托管、不走 CDN**：

| 项 | 做法 |
|---|---|
| 资源位置 | `app/admin/static/vendor/wangeditor/{index.js,style.css}`（1.27 MB + 15 KB）。与旧站 CDN 上那份**逐字节相同**，可复核：`sha384` 分别是 `sha384-zvb7uTnmHz+292Yb+…`（js）与 `sha384-C75sGbV8c7rMv…`（css） |
| 打包与服务 | `node tools/embed_admin_assets.mjs` 把 `static/**` 打进生成物 `app/admin/assets/static-assets.js`，由 Worker 在 `/admin/static/**` 直出（**免登录**，`js`/`css` 的 MIME 由扩展名兜底）→ **部署即生效，不需要再往 R2 传任何东西** |
| 页面引用 | 只在**编辑页**加载，顺序不能乱：`vendor/wangeditor/style.css` → `vendor/wangeditor/index.js` → `js/news_editor.js`（见 `app/admin/pages/news.js` 的 `scripts`） |
| 缓存 | 三者都带 `?v=<API_VERSION>`；Worker 返回 `cache-control: public, max-age=86400`（图标字体 1 年，R2 素材 7 天）。**改了编辑器或初始化脚本必须升 `API_VERSION`**，否则用户拿到的是旧缓存 |
| 体积 | 生成物约 **2.4 MB 原始 / 0.80 MB gzip**（编辑器占 1.27 MB 原始 / 0.37 MB gzip）；Workers 免费版脚本上限 3 MB（压缩后），仍有余量。`wrangler deploy` 的包体因此变大是预期内的 |
| 加载失败兜底 | `window.wangEditor` 缺失或初始化抛错：隐藏编辑器与工具栏、露出**普通文本域**（照旧可编辑保存），并在页面上显示一条告警写明原因 → 不会出现"编辑页打不开" |
| 内容格式 | 与旧站一致：图片入库为相对路径 `<img src="image/…">`、视频入库为小程序标签 `<wx-video src="video/…">`；编辑器里显示的是根路径 + `<video>`，保存时由 `app/admin/lib/newsContent.js` 还原。编辑器的 `data-w-e-*` 私有属性与外层容器在入库前被清掉（净化的白名单里本来也没有它们） |

**为什么不用 CDN**（旧站是 jsdelivr + SRI）：

- 本站面向国内用户，公共 CDN 可达性不稳定 —— 这正是"编辑器打不开"最容易复发的地方；
- 自托管后编辑器与其它后台资源**同一条链路**（同一 MIME 兜底、同一缓存键、同一份生成物），没有第二个发布步骤；
- 被否掉的备选：① 放 R2 并新增 `/vendor/` 直出前缀 —— Worker 体积小，但多一个"必须记得上传"的手工步骤，忘了就只剩文本域；② 继续用 CDN —— 改动最小，但把可用性押在外部网络上。本次选**打进生成物**，代价是 Worker 脚本大 0.37 MB（gzip）。

### 编辑器相关的两处实现细节（改之前先看）

- **回显时把顶层图片包进 `<p>`，保存时拆回来**：wangEditor v5.1.23 解析"顶层连续 `<img>` 后面跟 `<video>`"时会丢图、甚至抛 `Cannot find a descendant at path [n]`（真实 Chromium 实测：单图+视频丢图，双图+视频直接报错）。`js/news_editor.js` 因此在回显时给顶层图片各包一层 `<p>`、保存时把"只有一张图"的段落再拆回顶层 —— **库内格式一个字节都不变**。
- **插入用"带校验的插入"**：上一次插入后编辑器会留一个失效选区，直接 `restoreSelection()` + `insertNode()` 会**静默失败**（不报错也不生效，实测：插过视频之后再插图片就丢）。`insertNode()` 现在插完比对模型，没插进去就重聚焦再试一次，仍失败则把原因写到弹窗里（素材库弹窗与上传弹窗各写一份，不会静默）。

---

## 素材对外域名（`MEDIA_BASE`）怎么选

库里只存**相对路径**（历史是 `news_uploads/home/a.jpg`，新上传是 `image/a.png`），下发时由 Worker 拼上 `MEDIA_BASE`。两种填法都能用：

| 填法 | 值 | 谁在服务素材 | 什么时候选它 |
|---|---|---|---|
| **A. R2 公开域（推荐）** | `https://storage.250036.xyz`（A3 建的自定义域） | 直接由 R2 边缘返回 | 默认。**不吃 Worker 请求额度、不经 Worker CPU**；视频 Range/拖动由 R2 原生支持；缓存命中率最高 |
| B. Worker 域名 | `https://lyjx.250036.xyz` | Worker 从 R2 读出来再返回 | 想少维护一个域名时用。`/image/*`、`/video/*`、`/avatar/*`、`/news_uploads/*`、`/avatar_uploads/*`、`/images/*` 都已由 Worker 直出（带 `etag`、`cache-control: max-age=604800`、`accept-ranges`，Range 回 **206**），与旧站 `StaticFiles` 挂载同口径 |

要点：

- 换成 B 只需改 `[vars]` 的 `MEDIA_BASE` 后重新部署，**代码不用动**（旧库里存的是相对路径，不涉及数据迁移）。
- 选 B 的代价：每条图片/视频请求都算一次 Worker 请求（免费套餐 100,000 次/日）并占用 CPU 时间；列表页一屏十几张图就十几个请求。素材量大时优先 A。
- 选 B 时**微信公众平台的 request 合法域名**只需保留 `https://lyjx.250036.xyz`（`storage.250036.xyz` 可留可不留，回滚要用就留着）。
- 不管选哪个，`/images/*`（包内图标）始终由 Worker 直出（旧站也是 StaticFiles，与素材域无关）。

---

## 站点图标（favicon，所有页面共用）

图标只有一个来源：`app/favicon.ico`（与旧站 `fastapi/app/favicon.ico` 是同一个文件，48725 字节）。
它被**内联进 Worker**（生成物 `app/core/favicon.js`），由 `main.js` 在 `/favicon.ico` 直出：

| 项 | 做法 | 为什么 |
|---|---|---|
| 页面引用 | `<link rel="icon" href="/favicon.ico?v=<内容指纹>" type="image/png">`，由 `core/html.js` 的 `FAVICON_LINK` 统一注入（状态页 / 协议·隐私·下载页 / 后台所有页 / 登录页 / 初始化页） | **根绝对路径、不带域名**：自定义域 `lyjx.250036.xyz`、`*.workers.dev` 预览域、本地 `wrangler dev` 都成立；写死域名会在预览域失效 |
| 服务侧 | Worker 路由 `GET /favicon.ico`，返回内联字节（在 `/images/*` 判定之后、路由表之前） | Workers/Pages 上 `/favicon.ico` 只是一次普通请求，**不会自动命中静态托管**；图标必须由 Worker 自己响应 |
| 响应头 | `content-type: image/png`、`cache-control: public, max-age=604800`、`etag`（内容指纹） | 浏览器对图标是**按地址缓存**的：没有长缓存 + 稳定 ETag，每个页面都会再拉一次（旧站 StaticFiles 给的也是 `max-age=604800`） |
| 类型要与字节一致 | 这个 `favicon.ico` **其实是 800×800 的 PNG**（前 8 字节是 PNG 魔数），所以声明 `image/png`；页面 `type=` 与响应 `Content-Type` 同源取自 `core/favicon.js` | 类型与真实字节不符、又带 `x-content-type-options: nosniff` 时，挑剔的客户端（非 Chromium 内核的 WebView 等）会直接丢掉图标 |
| 带 `?v=<指纹>` | 指纹 = 图标内容 hash（`FAVICON_HASH`），与 `etag` 同源 | 浏览器**按站点**记"有没有图标"：本站以前 404 过（内联之前就是 404），不加指纹它不会主动重取，表现为"改好了也一直不显示" |
| 换图标 | 覆盖 `app/favicon.ico` → `node tools/embed_favicon.mjs` → 升 `main.js` 的 `API_VERSION` → 部署 | 生成物与版本号联动，避免"换了图标但用户看到的是旧缓存" |
| 后端直出 | 不依赖 R2 里有没有该对象，也不额外消耗 R2 子请求 | 内联之前线上 `/favicon.ico` 就是"R2 里没这个对象 → 404" |

部署后自查：

```powershell
curl.exe -I https://lyjx.250036.xyz/favicon.ico
# 期望: 200 / content-type: image/png / cache-control: public, max-age=604800 / 有 etag
curl.exe -s https://lyjx.250036.xyz/admin/login | Select-String 'rel="icon"'
# 期望: <link rel="icon" href="/favicon.ico?v=<指纹>" type="image/png">
```

> **浏览器仍不显示时**（服务端已 200 却还是默认地球图标）：这是浏览器按站点缓存的旧结论，按顺序试——
> ① 强刷 `Ctrl+F5`（或 `Ctrl+Shift+R`）；② 关掉全部本站标签页再打开；
> ③ 清掉该站点数据（Chrome：地址栏左边图标 → Cookie 和网站数据 → 删除）；
> ④ 换个浏览器/隐身窗口验证（隐身窗口一定是最新结果）。
> 本次已经用"换 URL（`?v=`）"来规避这一条，正常用户重新打开页面就会取到新图标。

> `/images/logo.png` 是另一回事（登录页品牌图标，走 R2 的 `images/` 前缀）。
> R2 里没有它时登录页显示兜底的盾牌图标（不会裂图）；想换成真 logo，把它传到 `images/` 前缀即可。

---

## 验证清单（切线路前必须全过）

| 请求 | 期望 |
|---|---|
| `GET /` | HTML 状态页（服务名 + 运行中药丸 / 服务器时间·走动 / 进程启动时间·当前 isolate / 数据统计 6 项 / 依赖状态监控 D1+R2 与总连接状态 / 使用说明），与旧站 `templates/status.html` 同形 |
| `GET /favicon.ico` | **200** + `content-type: image/png` + `cache-control: public, max-age=604800`（内联字节直出，不需要往 R2 传） |
| 任意页面 `view-source` 或 `curl` 看 `<head>` | 都有同一串 `<link rel="icon" href="/favicon.ico?v=<指纹>" type="image/png">`（状态页 / 协议页 / 登录页 / 后台各页都一致） |
| `GET /images/<已上传的图>` | **200** + `etag` + `cache-control: public, max-age=604800` + `accept-ranges: bytes` |
| `GET /image/<新上传的图>`、`GET /video/<新上传的视频>`、`GET /avatar/<头像>` | 同上；历史路径 `/news_uploads/...`、`/avatar_uploads/...` 同样能直出（带 `Range: bytes=0-1023` 时回 **206** + `content-range`，视频拖动/续播靠它） |
| `GET /image/<不存在的对象>` | **404**；R2 绑定名写错时是 **502**（说明 `wrangler.toml` 与桶没对上） |
| 后台「本地上传」选一张图/一段视频 → 点上传 | 进度条走完并提示 `上传成功: image/xxx.png`（视频为 `video/xxx.mp4`），字段被回填；素材库弹窗里能立刻看到它（带目录徽章） |
| 后台笔记编辑页点「图片素材库」/「视频素材库」 | 弹窗按类型列出来自 R2 的素材（每行带目录徽章 `image`/`news_uploads`，图片直接显示**原图**缩略展示 —— 2.4.0 起不再有派生缩略图），点一行即把相对路径回填到对应字段 |
| 后台笔记编辑页的 HTML 里 | 必须能看到 `/admin/static/js/image_upload.js?v=` 与 `/admin/static/js/media_library.js?v=`（这两个脚本由外壳统一引，见下表"点上传没反应"） |
| `GET /admin/static/vendor/wangeditor/index.js`、`/admin/static/vendor/wangeditor/style.css`、`/admin/static/js/news_editor.js` | **200**（免登录）；MIME 分别为 `application/javascript` / `text/css`；带 `max-age=86400` |
| 后台笔记编辑页的正文 | 是**富文本编辑器**（工具栏 + 可编辑区），存量内容里的图片与视频都在；三种插图入口（本地上传 / 图片素材库 / 视频素材库）都能插到光标处；保存后 `news.content` 仍是"相对路径 + `<wx-video>`" |
| `node tools/cf_region.mjs report`（或控制台看 Location 列） | D1 与 R2 的 location 都是 **`apac`**；显示西欧/其它区域就是踩了"自动创建"的坑，按「区域（Location）与资源重建」处理（**不可原地改**） |
| 区域迁移完成 | 后台能登录（`admin_users` 行数一致）、素材能打开（R2 对象数与旧桶一致）、`/health/ready` 的 `checks.database` 与 `checks.storage` 都 ready、`storage.250036.xyz` 已挂到新桶 |
| 笔记列表（`/news/list`） | **不再下发 `image_thumb`**（2.4.0 起缩略图整体移除；小程序侧"没有这个键就用原图"，老客户端不用改）；封面/正文地址都指向原图 |
| `GET /admin/news_preview?id=<id>` | HTML 里有 `.mp-preview.mp-frame`（宽 800）、`.mp-cover`、`.mp-card`、`.mp-meta`（`.mp-chip` 显示**中文分类**）、`.mp-video`、`.news-content`、`.page-actions-center`（两个返回按钮居中）；正文配图 src 为 `_thumb/800/…` 或原图；**刷新前后 `view_count` 不变** |
| `GET /admin/news_edit?id=<id>` | 单列 `col-lg-8 mp-frame`（宽 800）；六个字段顺序为 标题/分类/封面图/视频地址/摘要/正文；正文下方依次是「发布设置」卡与「数据统计：浏览 n ｜ 点赞 n ｜ 收藏 n」；工具栏与编辑区正常（编辑器资源见「富文本编辑器」节） |
| 三个带状态筛选的列表（笔记/留言/公告） | 表格外层带 `data-status-filter-param="status"`：行内通过/停用后，**不再匹配当前筛选的行会就地隐藏**（不整页刷新、不丢滚动位置） |
| 留言 / 笔记 / 专题 / 首页板块 / 素材库点筛选按钮 | 五页的筛选组**长得完全一样**（`.btn-group.btn-group-sm` + `btn-outline-secondary`，当前项深色高亮并带 `aria-current="page"`），位置也一样（列表卡片头部最左；首页板块没有列表壳，放在同构的一行里）；地址栏变成 `?status=pending`（留言）/`?category=outdoor`（笔记）/`?topic=outdoor`（专题）/`?section=featured`（首页板块）/`?kind=video`（素材库），**"全部"也带参数**（`?status=all`、`?kind=all`…）；把该地址刷新或复制到新标签页仍是同一筛选态；切筛选后页码回到第 1 页，翻页与触底加载带着当前筛选（如 `?kind=image&page=2`） |
| 手机上看上面五页的筛选组 | 4 个以上按钮会**自动换行**（Bootstrap 的 `.btn-group` 默认不换行，2.2.6 在手机端适配层加了 `flex-wrap` 并把圆角/间距补回来），不会横向溢出把卡片撑出屏幕；桌面端仍是按钮连成一排的原样 |
| 素材库管理：上传（2.3.9；2.4.1 拆两个入口；2.4.2 改按钮文案） | 「上传素材」卡里左侧是**图片入口**（→ `image/`）、右侧是**视频入口**（→ `video/`）；每个入口两个按钮，文案分别是**「选择文件」**（可多选）与**「选择文件夹」**（不再出现两个"选择文件"）→ 提示"上传成功：`image/cover_<时间戳>.<ext>`"并刷新列表。上限：图片 8 MB / 视频 64 MB（超出会回一句明确文案）；上传走既有 `POST /admin/image_upload`（图片入口 `purpose=cover`、视频入口 `purpose=video`），**没有新增上传接口** |
| 素材库管理：改名 / 移动（2.3.9） | 挑一个**未被引用**的素材点「改名」→ 可改文件名或换目录（图片只能 `image/`、视频只能 `video/`、历史 `news_uploads/` 两者都收）→ 确认后回列表带"已改为 …"。挑一个**被引用**的点「改名」→ 直接给拒绝说明（列出引用），**没有表单**；`/admin/app_featured_edit` 那种"自动改写引用"的行为本项目**没有**，也不会偷偷改笔记 |
| 素材库管理：批量删除（2.3.9） | 勾选 2 个**未引用**的素材 → 「删除所选」→ 确认页列出两条 → 提交后回列表；勾选里混一个被引用的 → 确认页与提交都**整批拒绝**（一个都不删，`R2 delete` 调用次数 0）；一次超过 20 个 → 直接提示"一次最多删除 20 个" |
| 缩略图已移除（2.4.0） | 逐处看：笔记列表页没有 `<img>` 缩略图列之外的东西（列表本来就是原图）、素材库列表「预览」列只有 ≤512KB 的小图直出、大图显示「无预览」、素材详情页/笔记预览页图片全是原图地址；`/news/list` 返回里**看不到 `image_thumb` 这个键**（`curl` 抓一次即可）；素材库页底部不再有"派生缩略图 N 个"统计 |
| 上传：文件夹（2.4.0/2.4.1/2.4.2） | 在对应入口（图片或视频）点**「选择文件夹」**选一个含子目录的文件夹 → 落 `<入口决定的目录>/<相对路径>`，**整棵树连你选中的那层文件夹名一起保留**（如 `image/素材/相册/子目录/图.png`、`video/片子素材/子目录/片子.mp4`）；直接放在所选文件夹里的文件落 `image/<所选文件夹>/`；重名自动 `_1`；**「自动生成」也保留目录**，只把文件名换成 `<用途>_<时间戳>.ext`；空文件夹不会被保留 |
| 上传：目标路径（2.4.3/2.4.4；2.4.6 起建议按当前层） | 两个入口的「目标路径」是**下拉**，默认分别是 `image/` 与 `video/`（不动它 = 与 2.4.2 完全一样）；可选项含**根目录（存储桶最外层）**、本入口根目录、**当前浏览层的子目录**（缩进显示层级；2.4.6 起不再为它做全桶扫描，要看更深一层就先浏览进去），选「其它（手动填写）」才露出输入框。选 `image/2026-10/`（手填）再传 → 文件落 `image/2026-10/…`，若同时选了文件夹则结构在它下面继续保留（`image/2026-10/素材/子/深图.png`）；选**根目录**再传 → key 就是文件名（`logo.png`）或相对路径（`素材/子/深图.png`），不带任何前缀。**校验**：图片写 `video/`、视频写 `image/`、或写成 `avatar/`、`news_uploads/`、`../image/`、`/image/x/` → 前端当场提示且**不发起上传**；绕过前端直接发请求也会被后端拒（`success:false` + 原因），桶里不新增对象 |
| 上传到根目录后能否看到（2.4.4/2.4.5/2.4.6） | ① 选「根目录」传**一个文件** → 回到列表：根层就能看到它（文件行），点「详情」打得开且"所在层"显示为存储桶根目录；② **再选「根目录」+「选择文件夹」**传一个含子目录的文件夹（如 `素材/子/深图.png`）→ 根层出现 `素材/` 目录行，进去后能看到 `深图.png`（带斜杠的键以前列不出来，2.4.5 修的就是它；2.4.6 起改成"进目录才看得到"）；在笔记里引用该相对路径后，它的行「引用」列显示 N 处、点「删除」**整批拒绝**；③ **素材选择器**（编辑页的「图片/视频素材库」弹窗）里同样能搜到这些素材，而 `avatar/`、`images/`、`assets/` 这类站内资源**不会**出现在选择器里（它们能在桶浏览器里看到，但不做引用扫描、也不进素材库） |
| 上传：进度与失败（2.4.0） | 选多个文件后点「开始上传」→ 进度条按**字节**推进并显示"共 N 个文件 · x/y MB · 成功 a · 失败 b"；当前文件名与百分比在下面一行；故意传一个 `.txt`（或往图片入口塞视频）→ 失败项列出原因并带「重试」「跳过」两个按钮 |
| 存储桶浏览（2.4.6） | 打开 `/admin/media_manage`：顶部是上传卡片，下面**根层只列"目录"**（`image/`、`video/`、`news_uploads/`、`avatar/`、`images/`，以及你自己在根下建的任何目录，例如 `素材/`）与**根下文件**；点目录名或「进入」→ 地址栏变 `?prefix=image/`，只列这一层的内容；面包屑每段可点、「上一级」回上层；顶部快捷按钮（存储桶根目录 / `image/` / `video/` / `news_uploads/`）一键跳转。层内每行显示对象键、类型、大小、修改时间、ETag、引用；行尾有「详情 / 改名·移动 / 复制 / 删除」，目录行有「进入 / 移动 / 删除」。滚到底自动加载这一层的下一页（统计条显示"已加载 N/M 个对象 · 第 x/y 页"）—— 一层超过 1000 个对象时会提示"已到单层上限，请用前缀/关键词缩小范围" |
| 桶内改名·移动·复制（2.4.6） | 「改名·移动」页的**目标目录是自由文本前缀**（预填当前所在目录；留空 = 桶根，写 `image/2026-10/` 就归到那儿，目录不需要预先存在）；「新文件名」只填文件名。勾选「复制」= 保留原对象、另存一份到目标键（复制不动原对象，所以被引用的素材也能复制）。**绝不覆盖**：目标键已存在时直接拒绝并说明。移动/改名在素材路径上仍受引用检查（被引用就拒绝，不擅自改笔记），页面上会给出「改为复制」入口 |
| 桶内目录级操作（2.4.6） | 在目录行点「移动」→ 确认页写明"这一批 N 个（一次最多 10 个）、合计大小、还有 M 个"，填目标前缀后提交：结构原样保留（原键去掉该前缀后拼到目标前缀后面），提交后可再点「移动」处理剩下的；点「删除」→ 确认页写明"即将删除 N 个对象（不可恢复），这一前缀下共 X 个"，提交即删（一次最多 20 个，一批只花 1 次 R2 delete 调用），被引用的一批**整批拒绝**（绕过页面直接 POST 也会被拒） |
| 素材库列表：滚动加载 + 回到顶部（2.4.1） | 打开 `/admin/media_manage`：底部不再有「上一页 / 下一页」，改成一个"滚动到底自动加载更多"的提示条与「回到顶部」按钮；往下滚 → 第 2 页的行**追加**在下面、顶部统计条从"已加载 10/30 个文件 · 第 1/3 页"变成"已加载 20/30…"、滚到底显示"— 已全部加载 —"；点「回到顶部」回到页首。**带筛选滚**：先点「图片」或选一个目录/排序，再往下滚 → 打开开发者工具看请求应是 `…/media_manage_rows?kind=image&dir=image&page=2`（**筛选参数一个都不丢**）；把 URL 里的 `page=2` 手改成 `page=99` 直接打开也不会 500（服务端夹到最后一页） |
| 笔记管理：没有跳页控件（2.4.1） | `/admin/news_manage` 底部只有「回到顶部」（不再有「跳至 N 页 / 跳转」）；往下滚仍然自动加载下一页、统计条照旧更新。其它列表页（留言/公告/专题/用户/轮播）**仍然保留**跳页控件 |
| 素材库管理：详情页（2.3.9/2.4.0） | 行内点「详情」→ 看到预览（图片直出**原图**、视频用 `<video>`）、体积、上传时间、`Content-Type`、缓存口径、ETag、公开地址、以及**引用明细**（笔记引用直接链到编辑页） |
| `/admin/media_manage` 的「引用」列与行内「N 处 → 查看引用」 | 两处数字**必须一致**（同一个 `scanReferences`）；回收站里被引用的素材带「含回收站」徽章；随便挑一个"未引用"的素材去 D1 里 `SELECT id FROM news WHERE image LIKE '%<文件名>%'` 应查不到（真未引用） |
| `/admin/app_home_manage`（首页板块管理） | **头部两行与 news_manage 同构（2.3.7/2.3.8）**：第一行是**一个**新增按钮（`btn btn-primary` + 加号；「全部」视图文案「添加」进 `?section=main`，选了某个板块则文案为该板块的「添加入口/添加精选」并带对应 `section`），第二行是标签条（全部 / 主题项目 / 拓展项目 / 精选项目）；默认「全部」时**三张表依次出现**；点「精选项目」地址栏变 `?section=featured` 且只显示精选那张表（列头含「标识/跳转页面」），选中项带 `aria-current="page"`；手机端按钮自动换行、不横向溢出 |
| `/admin/app_home_edit`（首页内容编辑页，2.3.8 三合一） | `?section=main\|ext` → 板块入口表单（板块/分类/图片/排序/启用，写 `app_home_sections`）；`?section=featured` → 精选表单（标识/名称/图片/跳转页面/排序/启用，写 `app_featured_items`）；新增时页面顶部有「改为添加精选项目 / 改为添加板块入口」一条链接可切类型；老地址 `/admin/app_featured_edit?id=0` 现在是 **404**（`/admin/app_featured_delete` 仍在，删除照旧） |
| 老书签 `/admin/app_featured_manage` | 落到统一 **404 页**（"没有这个页面"），侧栏也没有「首页精选管理」这一项了 —— 该页 2.2.5 已合并进首页板块管理 |
| `/admin/news_manage`、`/admin/media_manage` 的标题/文件名列 | 列宽固定（桌面 360px、手机 200px），超长标题显示为一行省略号，鼠标悬停能看到完整标题；其余列（封面/状态/操作）不会被挤走 |
| `/admin/db_tools`（需 `ENABLE_SQL_TOOL=1` + 超管；2.2.9 起菜单与标题叫「数据库管理」） | 表清单里有行数与「复制表名」，表名框可本地筛选；点「不统计行数（更快）」后不再发 COUNT；点「看结构」能看到 默认值 / 主键 / 索引及索引列（头部显示"这张表多少行"），并可复制列名与建表语句；点「浏览数据」可点列头排序（再点换方向）、按字段筛选、跨列关键字搜索、切 20/50 行一页；行尾按钮可复制 JSON、复制 INSERT、把 `UPDATE … WHERE 主键/rowid` 填进 SQL 控制台、展开完整值、**直接编辑这一行**；行首勾选后可**批量复制与批量删除** |
| 字段总览（2.2.9） | 点「字段总览」（或某张表的「看字段」）：一屏列出全部表的字段（字段名/类型/可空/默认值/主键），每张表一行分组标题带「浏览数据 / 看结构 / 复制列名」；`?table=news` 只看一张表。页面会写明取法（"一次 SQL 取回"或"逐表 PRAGMA"）与该屏用量 |
| 行内编辑与批量删除（2.2.9） | 点行尾铅笔 → 表单里只有可编辑列（敏感列不出现）；改完点保存会**先弹出要执行的 SQL** 让你确认，再执行**一条** `UPDATE`（空串与 NULL 用勾选框区分）；删除这一行是**一条** `DELETE`；行首勾选多行后「删除所选」是**一条** `DELETE … WHERE rowid IN (…)`（不可恢复，会先确认）；执行完立刻回显「影响 N 行 · D1 用量」，行内容就地刷新/移除 |
| 数据库工具"看某张表"时的语句数（2.2.8 / 2.2.9） | 打开某表的结构或数据**不再统计全库行数**（表清单里那 20+ 张表显示"未统计"、并提示"省掉 N 条 COUNT"）；2.2.8 结构与数据的元信息 + 取数合计约 8 条语句（2.2.7 是 39 / 41 条）；2.2.9 加了元数据缓存后，**同一分钟内再打开只剩 1 条**（本表行数），字段总览剩 **0 条**（实测真实库：结构 39→6→1、字段总览 1 条） |
| 行尾按钮取的是完整值（2.2.8 / 2.2.9） | 列表页**不内嵌整行数据**（长文本只显示前 120 字符）；点「复制 JSON / 复制 INSERT / 生成 UPDATE / 编辑」会先按 `rowid` 取那一行**再**执行，拿到的长文本是完整的（同一行第二次点击走页面缓存、不再发请求）；批量复制也是**一条** `rowid IN (…)`；长表（如 `news` 带正文）50 行页面体积约 125KB（2.2.7 是 269KB） |
| 控制台结果的成本提示（2.2.8） | 执行后结果区显示「本次查询：读 N 行 · 写 N 行 · N ms」（来自 D1 的 `meta`）；`rows_read` 明显偏大就是全表扫描，考虑加索引或 `LIMIT` |
| 成本与额度卡（2.2.9） | 页面顶部展开「成本与额度」：账号用量**参考快照**（手工记录，标了日期；实时值仍以控制台为准）+ **本机会话累计**（读/写/次数，只存在这台浏览器的 localStorage，可清零）+ 这一页的省额度做法清单 |
| 搜索区统一（2.3.4） | 逐页看搜索条：**下拉 → 输入框 → 搜索按钮** 一个顺序（笔记管理/笔记回收站/通知公告/专题精选/用户管理/运营文案/素材库管理/数据库管理），按钮一律「🔍 搜索」；**桌面端**三者等高（31px）且在同一行，输入框 192px、下拉框 144px；**手机端（≤768px）**等高 38px 且每个控件独占一行、不横向溢出；素材库弹窗里的筛选行也是 sm 尺寸（输入框与「刷新」按钮等高） |
| 控制台的常用语句与本机历史 | 选「常用语句」会填入示例（最近 20 条笔记、`EXPLAIN QUERY PLAN …` 等）；执行过的语句出现在「本机历史」（只存在你自己浏览器的 localStorage 里，换浏览器/清缓存就没了，服务端不存） |
| 控制台故意写错 / 写危险语句 | `SELECT boom FROM news` → 统一文案 **+ 一句数据库原文**（`no such column: boom`）；`DELETE FROM news`（无 WHERE）会多问一次确认，结果里还带「没有 WHERE」的告警，且整条语句进审计 |
| `GET /?format=json` | `{"name":"狼牙极限运动笔记API","description":"本服务为…数据服务。","status":"运行中","server_time"}`（name/description/status 三值与旧站逐字一致） |
| `GET /health` | **裸结构**（无 code 包装）`{"status":"ok","service":"狼牙极限运动笔记API","uptime_s":0,"server_time",checks:{database,media}}` |
| `GET /health/ready` | **裸结构**（无 code 包装）`{"status":"ready",version,server_time,checks}`；D1 或 R2 不通时 **503** 且 `status:"starting"` |
| `GET /apitest` | `{code:200,msg:"API测试成功",data:{api_status:"online",server_time,version,database_connected:true},timestamp}` —— `api_status` 必须是 `online`（与旧站同口径，小程序「检测线路」只认它） |
| `GET /test` | **301** → `location: /apitest`（旧站目标，已实测） |
| `GET /index`、`/info` | **301** → `location: /` |
| `GET /config/get_app_config` | `{code:200,message:"获取应用配置成功",data:{categories,home_sections,featured,version,texts,menu},timestamp}`（有行说明搬迁成功） |
| `GET /news/list` | `{code:200,data:[…]}` —— **没有 `msg` 键**（旧站如此，不是 bug） |
| `GET /news/list?page=1&page_size=2` | `data` 是 `{list,total,page,page_size,has_more}`，并带 `msg:"获取成功"` |
| `GET /content/get_banners` | `code` 是 **0**，`message` 与 `msg` 并存 |
| `GET /content/get_outdoor` | `code/msg/status/message` 四键；未登录时每行**没有 `video_url` 键**、有 `can_watch_video:false` |
| `GET /pages/terms`、`/pages/privacy`、`/pages/download` | 200 HTML；协议与隐私正文来自 D1 `app_texts`（改了库就变） |
| `POST /user/login`（`DEV_WECHAT_MOCK=1`） | `code:200,msg:"登录成功"`，`data` 有 `token` 与绝对头像地址 |
| 写接口（点赞/收藏/分享/留言） | 正常写入；压到配额（点赞 60/分钟）返回 `429`「操作过于频繁，请稍后再试」 |
| `node tools/diff_api.mjs --old https://api0.250036.xyz --new https://lyjx.250036.xyz --token <测试token>` | **全部 `[一致]`**；任何 `[差异]` 都必须先改到一致再切 |
| `python tools/export_sqlite.py ../../fastapi/data/lyjx.db out/seed.sql` + `node tools/live_smoke.mjs` | 真实数据结构与数据下的端到端冒烟（列表/详情/点赞/限流/内容/配置/用户/登录/注销恢复删除/静态页/探针）**全部 OK**；需要 Node 22+ |

---

## 切线路与回滚

1. **先只部署、不切小程序**：按上面的清单验收，观察 1~2 天（`wrangler tail` 看有无 5xx）。
2. 小程序侧改 `lyjx/utils/constants.js`：把 `https://lyjx.250036.xyz` 作为线路之一并指为默认（版本号按你的口径升一版）。
3. 灰度：内部测试账号先用线路切换走新站（不用发版）。
4. **回滚**：把小程序线路切回 `api0.250036.xyz` 即可 —— 旧后端与旧库全程没动过；服务端也可 `wrangler rollback`。
5. 旧后端与旧库**先别删**，保留 1~2 周做兜底。

---

## 区域（Location）与资源重建

**结论先写**：D1 的 **primary location** 与 R2 的 **location hint** 都是**建资源时定死的、建完不可修改**（控制台没有"改区域"的入口，API 也没有对应字段）。所以"区域选错了"**不能原地修**，只能"**新建一份正确的 + 迁数据 + 改绑定**"。

**为什么当初会落到西欧**：`wrangler.toml` 里 `database_id` 留空、R2 桶不存在时，首次部署会被 wrangler **自动创建**；自动创建**不带 location hint**，Cloudflare 按账号默认给到一个区域（本项目拿到的是西欧）。这不是代码问题，也不影响功能正确性，只影响 **D1 读写与 R2 首次回源的往返延迟**（中国大陆用户最直观的体感是后台操作与小程序接口变慢）。

**第 0 步（必做，否则一步都走不动）**：把 `wrangler.toml` 的 `database_id` 回填成真实值。现在它是注释状态，wrangler 会**拒绝加载整个配置**（`d1_databases[0] bindings must have a database_id field`），连迁移要用的 `d1 export` 都跑不了。

```powershell
# 取 ID: 控制台 D1 → lyjxxapp-d1 → Database ID; 或先配令牌再跑
$env:CLOUDFLARE_API_TOKEN="<D1:Edit + R2:Edit 的 API 令牌>"
node tools/cf_region.mjs report     # 会同时提示"缺 database_id"并列出所有库/桶与它们的 location
```

**再确认现状**（任选一种，本仓库无法代查：本机 wrangler 的登录态令牌在非交互环境用不了，需要你自己跑）：

```powershell
cd app\api-cf
# ① 一条命令看两个资源的 location（需要 CLOUDFLARE_API_TOKEN: D1:Edit + R2:Edit）
node tools/cf_region.mjs report
# ② 或用 wrangler 交互式
wrangler d1 list          # 看库列表里的 location 列
wrangler r2 bucket list   # 看桶列表里的 location 列
```

期望值：**`apac`（Asia Pacific）**。控制台对照：D1 详情页的 Location、R2 桶列表的 Location 列。

### 方案 A：新建 + 迁移（推荐，零删除、可回滚）

前提：**D1 名额**。账号 D1 配额是 10 个（本项目开建时已用 9/10）。若现在已满，方案 A 建不出新库 —— 要么先删一个确定不用的库腾名额（**待确认**：哪个能删只有你知道），要么走方案 B。

```powershell
cd app\api-cf
# 1) 在亚太建新资源（只新增，不动旧的）
node tools/cf_region.mjs create --d1 lyjxxapp-d1-apac --r2 lyjxxapp-r2-apac   # 或控制台建，Location 选 Asia Pacific
#    输出会直接给你要回填的两行（database_name/database_id、bucket_name）

# 2) 迁 D1（导出含建表与数据；行数对不上就别往下走）
wrangler d1 export lyjxxapp-d1 --remote --output=out\region\backup.sql
wrangler d1 execute lyjxxapp-d1-apac --remote --file=out\region\backup.sql

# 3) 迁 R2 素材（二选一；对象数/总字节数对得上才算成功）
#    a. 控制台 → R2 → Super Slurper：源桶 lyjxxapp-r2 → 目标桶 lyjxxapp-r2-apac（跨桶复制，最省事）
#    b. 有 R2 的 S3 凭据时用 rclone：
#       rclone copy r2:lyjxxapp-r2 r2new:lyjxxapp-r2-apac --transfers 8 --checkers 16

# 4) 改绑定并部署（只改这两处）
#    [[d1_databases]] database_name = "lyjxxapp-d1-apac" / database_id = "<新 uuid>"
#    [[r2_buckets]]  bucket_name  = "lyjxxapp-r2-apac"
npx wrangler deploy

# 5) R2 自定义域：先把 storage.250036.xyz 从旧桶摘掉，再挂到新桶（一个域同时只能挂一个桶）；MEDIA_BASE 不用改
```

迁完按「验证清单」走一遍，重点看：后台能登录（D1 行数一致）、素材能打开（对象数一致）、`/health/ready` 的 D1+R2 都 ready。

### 方案 B：保留同名（不推荐）

只有在"必须同名"或 D1 名额已满时才考虑。代价是**先删后建**，期间站点不可用，且**删除不可恢复**：

- D1：同账号内库名唯一 → `wrangler d1 export lyjxxapp-d1 --remote --output=out\region\backup.sql` → 控制台**删除** `lyjxxapp-d1` → `wrangler d1 create lyjxxapp-d1 --location apac` → 回填新 `database_id` → `wrangler d1 execute lyjxxapp-d1 --remote --file=out\region\backup.sql`。
- R2：**桶名全局唯一**（所有 Cloudflare 账号共用命名空间）→ 必须先把对象全部备份到别处（本地磁盘或临时桶；本项目素材是 GB 级，别用 `wrangler r2 object get` 逐条拉），再删桶、建同名桶、传回。
- 备份文件（`out/region/backup.sql`）在导入成功并验证前**不要删**。

### 可选缓解（不换 primary）：D1 读复制

D1 支持开启读复制（Read replication），把**读**请求就近到亚太的副本（**写**仍然回西欧 primary）。开关在控制台 D1 详情页；也可用 API `PUT /accounts/{account_id}/d1/database/{database_id}/read_replication`。**待确认**：控制台当前的具体文案位置，以及本项目是否已开启（本仓库看不到账号状态）。这只是缓解，不等于"资源挪到亚太"。

### 回滚与"要不要改代码"

- **回滚**：`wrangler.toml` 那两个名字改回旧值 → `npx wrangler deploy`，再把自定义域挂回旧桶。旧资源只要没删，数据一直都在。
- **不需要改代码**：区域是资源属性，`app/**` 里没有任何区域假设；绑定只来自 `wrangler.toml`；`MEDIA_BASE`、`SERVED_PREFIXES` 与素材目录规则都**不受影响**。

---

## D1 平台限制与页面上的应对

数据库工具能做什么、不能做什么，取决于 D1 本身。下面每条都给出"页面上怎么应对"；**凡是我这边没有实测过的具体数值，一律标"待确认"**（以 Cloudflare 官方文档与你的套餐为准）。

| D1 的限制 | 页面上/代码里的应对 |
|---|---|
| **单线程串行执行**：同一个库上的语句是一条一条跑的；`batch` / `Promise.all` 省的是 **HTTP 往返**，库侧仍逐条排队 | **减少语句条数**才是主要手段：`db_tools` 看某张表时不再统计全库行数（只在「表清单」那一屏统计，`?counts=0/1` 控制）、索引列由**一次** `sqlite_master` 查询本地解析（不再一条索引一次 `PRAGMA index_info`）、行数据按需取、元数据缓存 60 秒。实测（真实旧库）：结构页 **39 → 8 → 1** 条、数据页 **41 → 8 → 2** 条、字段总览 **1** 条（缓存命中 0 条） |
| **额度是按"读取行"计的**（账号 5M；2026-10-07 已用 28.98k） | 页面里能省的都省了：不再全表扫描式地统计行数、字段总览一条 SQL、缓存元数据、批量操作一条语句、行内编辑/删除按主键走索引（`rows_read` 通常 1~2）；每次查询与整屏的用量都显示出来（「成本与额度」卡 + 结果区 + 本机会话累计） |
| **表函数（`pragma_table_info`）在 D1 上的支持情况未实测**（本仓库有过"复合 SELECT 在 D1 报错"的先例） | 字段总览优先用一条关联 `pragma_table_info` 的 SQL；**一旦失败就回退逐表 `PRAGMA table_info`**（走缓存），并在页面上如实写出当前取法；降级标记带 60 秒 TTL，不会因一次偶发错误永久退化。**待确认**：线上 D1 是否支持（部署后用 `?view=columns` 看一眼页面上写的是"一次 SQL 取回"还是"逐表 PRAGMA"即可） |
| **查询成本可估**：每次执行都回 `meta`（`rows_read` / `rows_written` / `duration`） | SQL 控制台的结果区直接显示「读 N 行 · 写 N 行 · N ms」；`rows_read` 明显偏大 = 全表扫描，考虑加索引或 `LIMIT`（这是 D1 控制台看不到的） |
| **按语句执行，页面不提供交互式事务**：安全内核直接拒绝 `BEGIN`/`COMMIT` 与多语句（含 `;`） | 需要原子地跑多条语句时用 D1 原生的 `batch`（一次请求内执行）——本项目只用它做只读的逐表 COUNT（`app/core/overview.js`）。页面上的**批量删除**因此写成 `DELETE … WHERE rowid IN (…)` 的**一条**语句（一条即原子，不会"删一半"）；行内编辑/删除同样各是一条语句，且都要 `confirm=1` |
| **没有 DDL / PRAGMA 入口**（`CREATE`/`ALTER`/`DROP`/`PRAGMA` 一律被拒） | 结构变更走仓库里的 `app/sql/*.sql` + `wrangler d1 execute --file`（见「路线 B」）；`EXPLAIN QUERY PLAN` 属读语句，控制台可直接用（常用语句里有示例） |
| **没有"本地库文件"概念**：不能备份 / VACUUM / 压缩 / 整库下载 | 备份与迁移用 `wrangler d1 export`（导出 SQL）或控制台；页面只做浏览与单条 SQL |
| **结果集要一次性读进内存**（单次查询的行数/体积有上限，具体数值**待确认**） | 执行 SQL 时服务端最多回传 500 行（`MAX_EXEC_ROWS`，超出会在消息里说明并建议加 `LIMIT`）；结果表格再按 50 行/页客户端分页；数据浏览固定 20/50 行一页（`MAX_PAGE_SIZE=50`） |
| **`COUNT(*)` 在大表上要全表扫描**（逐表统计会明显变慢） | 行数统计走 `batch`（省 HTTP 往返、库侧仍逐条），并且**只在「表清单」这一屏默认统计**：看结构/看数据不统计（只查当前表 1 条 COUNT），表清单那屏也能一键关掉 |
| **单库写入吞吐与并发有配额**（具体数值**待确认**） | 页面不做批量写入界面：一次一条语句、写语句二次确认、无 WHERE 额外告警、所有写操作进审计（`admin.db_manage`） |
| **请求超时 / CPU 时间受 Workers 限制**（数值随套餐，**待确认**） | 长查询请自己加 `LIMIT` 并用上索引；结构页一次只读一张表的元信息，表清单不预读各表结构 |
| **区域影响往返延迟**：D1 现在还在西欧（见上一节） | 每次 D1 往返约 0.3~0.6 秒，所以既并发（省往返）也裁剪（省语句）：互不依赖的查询用 `Promise.all`，同时把"没必要的语句"删掉（见上面第一条） |

> 想导出/迁移数据、或要跑 `CREATE/ALTER` 这类结构语句时，**本页故意不给入口** —— 仍然走 `wrangler` 或 D1 控制台（`DEPLOY.md` 的路线 B）。

---

## 与旧站的差异（有意为之 —— 别再"补"回来）

逐页对照旧站时，下面这些是**刻意保持的差异**，不是漏迁。动手"补齐"前先看这一节（每条都有测试或注释守卫）：

| 项 | 现状 | 为什么 |
|---|---|---|
| `/admin/user_news_manage`（用户笔记审核） | **已裁掉**：菜单、页面路由、权限清单、状态注册表里都没有它，老地址落统一 404 页 | 2026-10-06 按需求裁剪，`tests/admin_sidebar_menus.test.mjs` 有守卫测试会拦"又加回来" |
| `/admin/sql_tool`、`/admin/fix_db` | 未迁移（权限清单里占位保留，将来要迁时口径已就位） | 旧站生产环境默认关闭 SQL 工具；本地 D1 直接用 D1 控制台 |
| `/admin/db_diagnostics` | 并入 `/admin/db_tools?tab=diagnostics` | 同一件事一个入口，少一页跳转 |
| `/admin/gitee_proxy`、旧兼容 302（`/admin/admin_upload`、`/test_upload`、`/test_avatar_upload`、`/test_image_loading`、`/test_image_path`）、旧入口 `/admin/index`、`/admin/admin_home` | 未迁移 | 低价值历史兼容；后台入口统一为 `/admin/login`、`/admin/bootstrap`、`/admin/dashboard` |
| 列表页筛选形态 | **留言 / 笔记 / 专题 / 首页板块 / 素材库五页统一为"URL 参数 + 按钮组（`.btn-group.btn-group-sm`）"**，共用 `partials.filterButtons` 一份实现（基准就是留言管理页那一组）；旧站是"pills / select / btn-check 混用" | 旧站每页各写一套（素材库是按钮组、笔记是下拉、专题是胶囊），换页就得重新找筛选器；统一后筛选态进 URL，可直链、可刷新、可回退，分页与触底加载也自动带着筛选。其余页面（用户/公告等）的筛选形态保持与旧站一致，不动 |
| 各页搜索区（输入框 / 下拉框 / 搜索按钮） | **9 处调用点全部统一到 `partials.searchBar`/`searchInput`/`searchSelect`**（基准 = 笔记管理页那条搜索条）：控件顺序、图标（`bi-search`）、按钮文案（「搜索」）、高度（桌面 31px / 手机 38px）与宽度（输入框 12rem、下拉框 9rem）全站一致；旧站/2.3.4 之前是"每页各写一套"（换行、对齐、宽度手法、顺序、图标、文案六项各不相同）。**例外**：数据库管理页表头"用这一列筛选"的链接仍是漏斗图标（它是跳转链接不是搜索按钮），"每页 N 行"选择器不属于搜索区 | 六项差异逐页出现时，用户看到的就是"每个页面的搜索框都长得不一样"，而这类"能一眼看出的不一致"只能靠共用结构 + 共用样式兜住（宽度/高度写在 `admin.css` 一处，`app/admin/README.md` 已写成实现约定） |
| 列表页"标题/文件名"列 | **固定宽度 360px（手机 200px）+ 省略号 + `title` 悬停看全文**；旧站是内容撑多宽就多宽 | 旧站那种"长标题挤掉封面/状态/操作列"在窄屏上要横向拖很远；固定列宽后每列位置稳定（依据见 `app/admin/README.md` 的实现约定表） |
| 首页板块 / 首页精选 | **合并为一页** `/admin/app_home_manage`（`?section=` 切「主题项目/拓展项目/精选项目」，默认全部三张表一起看）；旧站是两个独立页面、两个菜单项 | 两页都是"小图标 + 排序 + 启停"的同类配置，合并后少跳到另一页、少一套重复表格。精选的表（`app_featured_items`）、编辑页与对外接口都没动，只是入口挪进这一页 |
| 公告没有预览页、轮播/分类等没有预览页 | 与旧站一致（预览页只有笔记与专题） | 这些页面没有"前端呈现"可看 |
| 数据库管理（原「数据库工具」） | **比旧站多**：字段总览一屏读全库表与字段、结构给全（默认值/主键/索引及索引列）并可复制列名与建表语句、数据可排序/按字段筛选/跨列搜索、单行复制 JSON/INSERT 或生成 UPDATE、**行内编辑与单行/批量删除**、SQL 快捷语句与本机历史、失败给数据库原文、**每次查询与整屏的 D1 用量与额度参考**；**比旧站少**：MySQL 驱动、库文件备份/自愈/VACUUM（结构变更与导入导出仍走 wrangler/控制台） | 旧站那套依赖本地库文件与双驱动，Cloudflare 侧没有对应物；把"日常查数据"这一半补齐后，绝大多数操作不必再开 D1 控制台，也就不用反复在浏览器标签之间同步表名/列名 |
| 执行 SQL 失败时的提示 | 统一文案 **+ 一句截断的数据库原文**（如 `no such column: boom`），同时进 Workers 日志与审计 | 旧站是"详情只进日志"。这一页的使用者本来就是能浏览全库的超管，"语焉不详的报错"是这里最费时间的坑；页面默认关闭且仅超管，放开的是可诊断性而非权限 |

---

## 常见错误对照表

| 现象 | 原因 | 解决 |
|---|---|---|
| `Not logged in` / 需要 API Token | 没登录 | B1 |
| 部署报 `database_id` 相关错误（code 10021） | `database_id` 是占位符或填错；它**只有整行注释掉**时 wrangler 才会自动建库 | 回 A2 填真值，或注释掉该行再 push |
| `/health/ready` 里 `checks.database:false` | 绑定名不是 `DB`，或库不是 `lyjxxapp-d1` | 名字必须一致 |
| `checks.media:false` | 绑定名不是 `STORAGE`（或早期 `MEDIA`），或桶不是 `lyjxxapp-r2` | 名字必须与 `wrangler.toml` 的 `[[r2_buckets]].binding` 一致 |
| 图片/头像地址是空串 | `MEDIA_BASE` 没配（或写成别的域名） | 改 `[vars]` 的 `MEDIA_BASE` → 重新部署 |
| 登录报「微信登录失败，请稍后重试」 | 密钥没推上去（`npm run secrets:put`）或 AppID 不对 | 重推密钥；本地联调可先 `DEV_WECHAT_MOCK="1"` |
| 菜单图标 404 | `app/images` 没传到 R2 的 `images/` 前缀 | 见"素材上传"第 3 条 |
| 系统信息里"业务表数量/记录总数"显示 **统计失败，无法判定** | 行数统计那条查询没跑通（2026-10-06 线上曾因表清单混进 D1 内部表 `_cf_KV` 而整条统计失败） | 页面会直接显示失败原因原文；修好后正常显示张数与总数。若原因里出现 `_cf_` 之类内部表，说明表清单过滤需要更新（见 `app/core/overview.js` 的 `tableNames`） |
| 列表/预览要显示缩略图 | **2.4.0 起没有缩略图**（这是有意为之）：前端直接用原图，只是大图更慢更费流量。要恢复得上离线派生或 Cloudflare Images（**待确认**） |
| 改了变量/密钥但没生效 | 运行中的是旧部署 | Retry deployment / `npm run deploy` 再来一次 |
| 小程序请求被微信拦 | 服务器域名白名单没加 | 加 `lyjx.250036.xyz` 与 `storage.250036.xyz`（旧线路 `api0.250036.xyz` 一起留着，回滚要用） |
| 访问 `/admin` 看到"后台未就绪" | 没配 `ADMIN_SESSION_SECRET` | 见 A8 第 2 步（加密变量），配完重新部署 |
| 图标不显示，但 `curl -I /favicon.ico` 是 200 | 浏览器按**站点**记着旧的"没有图标"（本站此前 404 过；浏览器不因服务端变好就重取） | 本版页面引用已带 `?v=<指纹>`，重开页面即生效；仍不显示看「站点图标」节的四步（强刷 / 关标签页 / 清站点数据 / 隐身窗口） |
| 点「上传」没反应（页面刷新或什么都不发生） | 上传表单靠 `static/js/image_upload.js` 认领并改走 XHR；该脚本是**生成物里的一份**，只改源文件不重跑 `tools/embed_admin_assets.mjs` 就不会生效 | 重跑 `node tools/embed_admin_assets.mjs` 并升 `main.js` 的 `API_VERSION` 后重新部署 |
| 素材库页/弹窗里看不到刚上传的图 | ① 对象被放到了**站内自有目录**（`avatar/`、`avatar_uploads/`、`images/`）—— 这些有意不进素材库；② 对象前缀既不是素材目录、也不是"根目录那一块"（例如手工 `r2 object put` 时写错前缀）；③ **2.4.5 之前**，用「根目录 + 选择文件夹」传上去的对象（键形如 `素材/子/图.png`）列不出来 —— 旧版只列"根下不带斜杠的文件" | ① 按 `库内相对路径 = R2 key` 重传到 `image/`、`video/` 或根目录；② 升级到 **2.4.5**（根目录整棵树都会列出来）；目录清单见「素材目录」节 |
| 素材库列表里出现了 `_thumb/480/…` 这样的文件 | 那是 2.4.0 之前留下的**历史派生缩略图**，现在它们就是普通素材（故意不跳过，便于清理）：确认无用后勾选批量删除，或按「素材目录」节里的 `wrangler r2 object delete --prefix` 一次删净 |
| D1/R2 的区域显示是西欧（中国大陆访问后台与小程序接口偏慢） | 资源是**部署时自动创建**的：`database_id` 留空 / 桶不存在时 wrangler 会补建，而补建**不带 location hint** → 落到默认区域；D1 primary location 与 R2 location hint **建后不可修改** | 按「区域（Location）与资源重建」新建亚太资源并迁数据，然后改 `wrangler.toml` 两个名字重新部署；本次已把配置注释与 A2/A3 步骤里的"留空自动建"改成"必须手动建 + 回填 ID" |
| 编辑页（`news_edit` 等）点「本地上传」没反应；「图片/视频素材库」弹窗点开是空白 —— 而 `/admin/media_manage` 一切正常 | 上传与素材库这两块**由前端脚本驱动**（`image_upload.js` 认领表单并改走 XHR、`media_library.js` 拉列表并回填），而素材库管理页是**服务端直出**、不依赖脚本，所以只有编辑页会坏。这两个脚本由 `app/admin/lib/layout.js` 的 `MODAL_SCRIPTS` 统一引入（旧站是模板各自带 `<script>`，抽成 `partials.js` 时标签丢了→页面有弹窗有表单却没人处理 submit） | 打开编辑页看 HTML 里有没有 `/admin/static/js/image_upload.js?v=`、`/admin/static/js/media_library.js?v=`；改过 `app/admin/static/**` 必须 `node tools/embed_admin_assets.mjs` 并升 `API_VERSION` 后重新部署（`tests/admin_submit_action.test.mjs` 有"资源包不许有孤儿脚本"的检查拦这类回退） |
| 编辑页正文**没有工具栏**、退回成普通文本域，页面上有一条黄色告警 | 编辑器资源没加载：改了 `static/**` 但没重跑 `tools/embed_admin_assets.mjs`，或没升 `API_VERSION` 导致浏览器拿旧缓存，或部署包不全 | 重跑生成脚本 + 升 `API_VERSION` 重新部署；再硬刷页面（告警文案里也写了原因） |
| 编辑器里插图"点了没反应"（弹窗里没报错） | 极少数情况下编辑器没有可用插入位置（选区失效）—— 已改为"插入后校验、失败重聚焦重试、仍失败则把原因写进弹窗" | 升级部署到 2.2.0+；若仍失败，先在正文里点一下光标再插 |
| 后台"执行 SQL"一直提示"请输入要执行的 SQL" | 前端发的是 JSON，而入口只解析 urlencoded（2.1.6 已修） | 升级部署到 2.1.6+ |
| 普通管理员能打开"管理员管理"或提交成功 | 该页原本只在页面内自查超管（2.1.6 起分发层也拦 `route_super`） | 升级部署到 2.1.6+；普通管理员会看到 403 |
| `/admin/bootstrap` 说"已经初始化过" | `admin_users` 里已有账号 | 直接去 `/admin/login`；**忘了口令**就 `DELETE FROM admin_users;` 后重新 bootstrap（A8 有完整步骤） |
| 登录总说"用户名或密码不正确" | 输错了，或 15 分钟内的失败次数到了上限（5 次/IP） | 等窗口过期再试；急着清就 `DELETE FROM rate_limit_counters WHERE scope='login'` |
| `/admin/db_manage` 提示"数据库管理未开启" | `ENABLE_SQL_TOOL` 还是 `0` | 改成 `"1"` 重新部署（A8.5）；用完改回 |
| 数据库工具里执行 SQL 报"只允许操作这些业务表" | 语句里出现了白名单外的表（如 `admin_users`、`wechat_tokens`） | 这是设计如此：执行范围与浏览范围是两件事，需要看这类表就用 D1 控制台 |
| 素材库管理删除报"仍有 N 处引用，已拒绝删除" | 该素材被笔记（含回收站）或轮播/专题/菜单引用 | 先改引用或清理回收站；点行内「查看引用明细」看具体位置 |
| 素材库里**整列**都显示"未引用"（实际都在用） | 2.2.4 前的引用扫描把粗筛 SQL 拼成 `image LIKE ? OR LIKE ?`（后两个没有列名）→ SQLite 语法错 → 被 `catch` 吞成零命中 | 升级到 2.2.4 即可；判断依据：`node --test` 里有一条"用 `node:sqlite` 真解析粗筛 SQL"的用例，本地也能用 `python tools/export_sqlite.py` 导出的库复核（真实数据 185 个被引用路径应 100% 认出） |
| 后台管理页（尤其素材库管理）点开要等一两秒 | ① 页面顺序发出多条 D1 查询（素材库原先 11 条），每条一次往返；② **D1 还在西欧**（见「区域（Location）与资源重建」）时每次往返 0.3~0.6 秒；③ 素材库页每次（含每翻一页）都要重新列举一遍 R2 | 2.2.4 已把互不依赖的查询改成并发（依赖链：笔记列表 3→1、素材库 11→2）；剩下的固定成本是区域，按「区域（Location）与资源重建」把 D1/R2 迁到亚太；素材上千后再考虑给列举加短期缓存（**待确认**） |
| 找不到「首页精选管理」这个菜单 / 老书签打开是 404 | 2.2.5 起该页已合并进「首页板块管理」，路由与侧栏入口都已删除（这是有意为之，不是漏迁） | 到 `/admin/app_home_manage` 点「精选项目」标签（等价地址 `?section=featured`）；精选的新增/编辑/删除功能一个都没少 |
| 限流计数想立刻清 | 压测留下的计数 | 等窗口过（≤60 秒）或 `DELETE FROM rate_limit_counters` |
| 分享次数偏多 | 旧站 3 秒去重是进程内的，Workers 没做 | 见 `README.md` 第五节"已知差异"，需要就补 |

---

## 需要你拍板 / 待你确认

1. **D1 名额**：`lyjxxapp-d1` 占掉最后一个名额（9/10 → 10/10），确认可以。
2. **R2 桶**：新建 `lyjxxapp-r2`（与 backend-cf 的 `lyjxxapp-media` 不是同一个桶），确认。
3. **域名**：`api.` / `media.` / `pages.` 三个都用，还是只用其中一两个。
4. **是否先开 `DEV_WECHAT_MOCK`** 走一遍验收，再切真密钥。
5. **运营改数**：切换后改文案/菜单/轮播/公告只能手工执行 SQL（`notes/ops-sql.md`），确认接受。
6. **旧后端去向**：保留（回滚兜底）还是停服 —— 建议先保留 1~2 周。
7. **区域迁移走哪条路**：D1/R2 现在都在西欧（自动创建没带 location hint），**建后不可改**。走**方案 A**（新建 `lyjxxapp-d1-apac`/`lyjxxapp-r2-apac` + 迁数据，零删除、可回滚）还是**方案 B**（保留同名，`导出 → 删库 → 建 apac → 导入`，期间不可用）？
   > 与上面第 1 条直接相关：D1 已经是 **10/10**，方案 A 需要先删掉一个库腾名额 —— **待确认：哪个库可以删**（本仓库看不到账号里另外 9 个库是什么）。如果不愿删，就走方案 B。两条路的详细命令见「区域（Location）与资源重建」。
8. **R2 自定义域切换窗口**：迁移时要把 `storage.250036.xyz` 从旧桶摘下来挂到新桶（一个域同时只能挂一个桶），摘挂之间素材会短暂 404 —— 确认可以，并挑低峰时段执行。
