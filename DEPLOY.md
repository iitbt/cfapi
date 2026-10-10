# 部署手册（照着做就行）

这份文档只讲一件事：把本项目（`cfapi`，微信小程序的主后端）部署到 Cloudflare。**所有步骤都由你自己执行。**

## 一、先记住这些固定的名字

| 东西 | 名字 | 说明 |
| --- | --- | --- |
| 程序本体（Worker） | `lyjxxapp-api` | `wrangler.toml` 里的 `name` |
| 数据库（D1） | `lyjxxapp-d1` | 绑定名是 `DB` |
| 存储桶（R2） | `lyjxxapp-r2` | 绑定名是 `STORAGE`，放图片和视频 |
| 定时任务 | 每天 3:17（UTC 时间，即北京上午 11:17） | 自动清理过期的限流计数 |
| 接口 + 后台地址 | `https://lyjx.250036.xyz` | 小程序接口和管理后台 `/admin` 共用同一个 |
| 素材地址 | `https://storage.250036.xyz` | 图片、视频直接从这里读 |

**两种做法，任选一种（要干的事完全一样）：**

| 做法 | 适合谁 |
| --- | --- |
| 网页点鼠标 + 少量本地命令 | 默认推荐，就是下面第 1 ~ 11 步 |
| 纯命令行 | 见文末「附录 B」，每一步都能对上第 1 ~ 11 步 |

## 二、开工前要准备的东西

| 要准备的 | 具体要求 |
| --- | --- |
| Cloudflare 账号 | 能建 Worker、D1、R2 |
| GitHub 账号 | 用"网页连接"方式部署时要 |
| 电脑环境 | Node 22 以上；会用到 Python 3（只在本地拆 SQL、导数据时用） |
| 三个密钥 | 小程序 AppID、小程序 AppSecret、后台会话密钥（第 6 步说明怎么来） |
| 旧数据文件（可选） | 旧后端的数据库文件 `..\fastapi\data\lyjx.db`，只迁数据时用 |
| 微信小程序后台 | 用来加"服务器域名"白名单 |

## 第 1 步 把代码放到 GitHub

1. GitHub 右上角 `+` → **New repository** → 名字填 `lyjxxapp-api` → 选 **Private** → Create。
2. 把本项目（`cfapi`）里的这些传上去：`app/`、`tools/`、`tests/`、`wrangler.toml`、`package.json`、`README.md`、`DEPLOY.md`。
   - 网页最省事：仓库页 **Add file → Upload files**，把目录整体拖进去 → Commit。
3. **不要传**：`node_modules/`、`.wrangler/`、`out/`、`.secrets.json`、`.dev.vars`（后两个是密钥，传上去等于泄露）。

## 第 2 步 建数据库（D1）

1. Cloudflare 控制台 → **Workers & Pages → D1**（有的界面叫 **Storage & Databases → D1**）→ **Create database**。
2. 名字填 `lyjxxapp-d1`，**地区（Location）选 `Asia Pacific`（亚太）** → 创建。
   - 这个地区**建完就不能改**，选错只能新建一个库、把数据重新导一遍。
3. 复制那串 **Database ID**，回 GitHub 编辑 `wrangler.toml`，填到 `[[d1_databases]]` 的 `database_id` 那一行 → Commit。
   - 必须**手动建库并回填 ID**。不要靠"把 `database_id` 留空、让首次部署自动建库"——自动建的库不带地区信息，会落到西欧，而且之后改不回来。

## 第 3 步 建存储桶（R2）并开通素材域名

1. **Storage & Databases → R2 → Create bucket**，名字填 `lyjxxapp-r2`，**地区（Location）选 `Asia Pacific`（亚太）** → 创建（桶保持**私有**）。
   - 同样**必须手动建**，不要靠部署时自动创建（自动建的不带地区信息，会落到西欧）。
2. 进这个桶 → **Settings → Public access → Custom Domain** → 填 `storage.250036.xyz` → 按提示加好 DNS 记录。
3. 绑定名固定是 `STORAGE`（在 `wrangler.toml` 的 `[[r2_buckets]]` 里），不要改。
4. 一个域名同时只能挂一个桶；以后换桶时，要先把域名从旧桶摘下来，再挂到新桶。

## 第 4 步 在数据库里建表

1. 先在本机项目目录下把建表脚本拆成小块（D1 控制台一次粘不了太长）：

   ```powershell
   cd <本项目目录>
   python tools\split_sql.py out\schema app\sql\0001_schema.sql app\sql\0002_rate_limit.sql app\sql\0003_wechat_token.sql app\sql\0004_admin.sql
   ```

2. 打开 D1 里的 `lyjxxapp-d1` → **Console / Query**，按文件名前面的序号从小到大，逐块粘贴 → **Run**：

   | 顺序 | 文件 | 里面是什么 |
   | --- | --- | --- |
   | 1 | `out/schema/01_0001_schema.sql` | 业务表（前一半） |
   | 2 | `out/schema/02_0001_schema.sql` | 业务表剩下的语句和索引 |
   | 3 | `out/schema/03_0002_rate_limit.sql` | 限流计数表 |
   | 4 | `out/schema/04_0003_wechat_token.sql` | 微信 token 缓存表 |
   | 5 | `out/schema/05_0004_admin.sql` | 管理员账号表（后台登录要用） |

3. 每一块都要"无报错"才算过。建表块只在第一次成功，重跑会提示 `table ... already exists`，这是正常的。

## 第 5 步 把旧数据导进去（全新部署可跳过）

1. 在本机项目目录下导出旧库数据，并拆成小块：

   ```powershell
   cd <本项目目录>
   python tools\export_sqlite.py ..\fastapi\data\lyjx.db out\seed.sql
   python tools\split_sql.py out\seed out\seed.sql
   ```

2. 回 D1 控制台的 Console，按 `out/seed/01_seed.sql` → `14_seed.sql` 的顺序逐块粘贴 → Run。
3. 四个要点：
   - **先建表、再导数据**，顺序反了会全部报 `no such table`。
   - 数据块是"有就覆盖"，反复粘贴也安全；建表块重跑才会报"已存在"。
   - 正文里的换行是真实换行（一条语句可能占好几十行），复制时整块全选，不要只框一行。
   - 想少粘几次：拆块命令后面加 `--max-bytes 30000`，会变成 3 块；粘不动或报错就回到默认块数。
4. 核对：一共 **21 张表**（业务 18 张 + 限流表 + token 表 + 管理员表）；数据条数与旧库一致（参考：`news` 69 行、`users` 4 行、`banner_images` 18 行）。
5. 正式切换前再跑一次第 1 小步，把旧库这段时间新增的数据补上（按主键覆盖，重复执行安全）。

## 第 6 步 填三个密钥

要填的三个值：

| 密钥 | 是什么 | 从哪里拿 |
| --- | --- | --- |
| `WECHAT_APPID` | 小程序 AppID | 微信小程序后台 |
| `WECHAT_SECRET` | 小程序 AppSecret | 微信小程序后台 |
| `ADMIN_SESSION_SECRET` | 管理后台的会话密钥 | 自己生成一串随机字符，32 位以上 |

**推给线上（生产）用这个文件：**

1. 填好 `.secrets.json`（模板是 `.secrets.json.example`，文件已在 `.gitignore` 里，不会被提交）。
2. 一条命令推上去：

   ```powershell
   npm run secrets:put
   ```

   等价于 `wrangler secret bulk .secrets.json`。

**本机调试用另一个文件：** `.dev.vars`（模板 `.dev.vars.example`）。它只在 `npm run dev` 时生效，和线上无关。两个文件填的是同样三项，互不替代，**都要填**。

**不想用命令行也行：** Worker → **Settings → Variables and Secrets** → 加三个**加密**类型的变量 → 配完点 **Deployments → 最新一条 → Retry deployment**。

**生成会话密钥（任选一种）：**

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 或者用 Windows 自带的 PowerShell
$b = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
-join ($b | ForEach-Object { $_.ToString('x2') })
```

三点提醒：

| 提醒 | 说明 |
| --- | --- |
| 这是密码类的东西 | 不要提交进仓库，不要写进文档 |
| 换掉它会怎样 | 已经登录的后台账号要重新登录（小程序不受影响） |
| 不配它会怎样 | 后台登录页显示"后台未就绪"，不会用默认值放行 |

**顺带确认几个开关**（都在 `wrangler.toml` 的 `[vars]` 里，改完重新部署即可生效）：

| 开关 | 现在该填什么 | 作用 |
| --- | --- | --- |
| `MEDIA_BASE` | `https://storage.250036.xyz` | 图片、视频对外用的地址 |
| `DEV_WECHAT_MOCK` | 先验收填 `"1"`，正式上线改 `"0"` | `"1"` = 随便一个登录码都能进（方便先跑通），`"0"` = 真去问微信 |
| `ENABLE_SQL_TOOL` | 要用"数据库管理 / 素材库治理"页填 `"1"`，用完改回 `"0"` | 开这两个后台页面（**默认关**，看全库数据、执行 SQL 的页面） |
| `ENABLE_PUBLIC_PROBE` | `"1"` | 开放 `/apitest` 连通性探测（小程序"检测线路"要用） |
| `OBSERVABILITY_ENABLED` | `"0"` | `"1"` 才开放 `/metrics` 用量页，平时关着 |

## 第 7 步 部署

**做法一：网页连接 Git**

1. **Workers & Pages → Create → Workers → Connect to Git**。
2. 选仓库 → 分支 `main`。
3. 按下面填：

   | 设置项 | 填什么 |
   | --- | --- |
   | Build command | 留空（不需要安装依赖、不需要构建） |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | 如果你是把 `cfapi` 里的内容当仓库根传的 → 留空；如果传的是整个大仓库 → 填 `cfapi` |

4. 点 **Deploy**。变量、数据库/存储桶绑定、定时任务都会跟着自动生效，不用再去控制台手点。
5. 如果构建日志报 `database_id` 相关的错误 → 回第 2 步，把 `database_id` 填对或整行注释掉，再 push。

**做法二：本机命令行**

```powershell
cd <本项目目录>
npm install        # 只想装一下命令行工具
npm test           # 可选：本地自检
npm run dev        # 可选：本地先跑起来看，地址 http://127.0.0.1:8787
npm run deploy     # 正式部署
```

> 部署成功后，**改了后台的样式、脚本或页面的话，要先把 `main.js` 顶部的 `API_VERSION` 加一位再部署**，否则浏览器会一直用旧文件。

## 第 8 步 绑域名、加微信白名单

1. Worker → **Settings → Domains & Routes → Add → Custom domain** → `lyjx.250036.xyz`。
2. 微信公众平台 → 开发管理 → 服务器域名 → **request 合法域名**，加上：
   - `https://lyjx.250036.xyz`
   - `https://storage.250036.xyz`
   - `https://api0.250036.xyz`（旧线路，留着回退用）

## 第 9 步 建第一个管理员，进后台

1. 浏览器打开 `https://lyjx.250036.xyz/admin/bootstrap`。
2. 填用户名、昵称、口令 → 提交 → 回到登录页，用这套账号登录（`https://lyjx.250036.xyz/admin`）。
3. 字段规则：

   | 字段 | 规则 |
   | --- | --- |
   | 用户名 | 只能用字母、数字、`_`、`.`、`-`，3~32 位 |
   | 昵称 | 可以留空（留空就用用户名） |
   | 口令 | 至少 10 位 |

4. 这个初始化地址只在"还没有任何管理员"时能用，建完自动失效。
5. **忘了口令**：在 D1 控制台执行 `DELETE FROM admin_users;`，再打开 `/admin/bootstrap` 重建一次。

## 第 10 步 上传素材

1. 上传时，**文件在桶里的路径要和数据库里存的相对路径一致**：
   - 历史素材保持原样：`news_uploads/…`、`avatar_uploads/…`；
   - 新上传的走：`image/`（图片）、`video/`（视频）、`avatar/`（头像）。
2. **小程序包内图标必须传到 `images/` 前缀**，否则小程序"我的"页图标会 404：

   ```powershell
   wrangler r2 object put lyjxxapp-r2/images/user.jpg --file=..\fastapi\app\images\user.jpg
   # 文件多时用 rclone（需要 R2 的 S3 凭据）：
   # rclone copy ..\fastapi\app\images r2:lyjxxapp-r2/images
   ```

3. 抽查：浏览器打开 `https://storage.250036.xyz/news_uploads/home/<某个图>` 能正常显示。
4. 特别大的视频（超过 64 MB）建议直接用 rclone 之类传进桶，不经过 Worker，再把相对路径填进后台。

## 第 11 步 上线前自查

| 打开这个地址 | 应该看到 |
| --- | --- |
| `https://lyjx.250036.xyz/` | 状态页，显示"运行中"、服务器时间、数据库和素材都正常 |
| `https://lyjx.250036.xyz/health/ready` | `status: ready`；数据库或素材不通会变成 503 |
| `https://lyjx.250036.xyz/apitest` | `api_status: online` |
| `https://lyjx.250036.xyz/favicon.ico` | 能返回图标文件，不是 404 |
| `https://lyjx.250036.xyz/admin` | 跳转到登录页 |
| 后台登录后看控制面板 | 能进，统计数字正常 |
| `https://storage.250036.xyz/<素材路径>` | 图片、视频能打开 |
| 后台传一张图再回列表看 | 能看到刚传的图，路径以 `image/` 开头 |

## 附录 A 出问题对照表

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 部署报 `database_id` 相关错误 | ID 是占位的或填错了 | 回第 2 步，填真值或把那一整行注释掉再 push |
| 打不开后台，提示"后台未就绪" | 没配 `ADMIN_SESSION_SECRET` | 回第 6 步，配好再部署一次 |
| 图片、头像地址是空的 | `MEDIA_BASE` 没填或写错 | 改 `wrangler.toml` 里 `[vars]` 的 `MEDIA_BASE` → 重新部署 |
| 登录提示"微信登录失败" | 微信两个密钥没推上去或 AppID 不对 | 重跑 `npm run secrets:put`；只想先验收可把 `DEV_WECHAT_MOCK` 临时改成 `"1"` |
| 小程序"我的"页图标 404 | 包内图标没传到 `images/` 前缀 | 回第 10 步第 2 小步 |
| 小程序请求被微信拦下 | 域名白名单没加 | 回第 8 步第 2 小步 |
| 改了密钥/变量但不生效 | 跑的还是旧部署 | Retry deployment，或本机 `npm run deploy` 再来一次 |
| 改了后台样式/脚本但不生效 | 没升版本号，浏览器用旧缓存 | 升 `main.js` 的 `API_VERSION` → 重新部署 |
| 后台打开要等一两秒 | 数据库/存储桶建在了西欧 | 见附录 C |
| `/health/ready` 里有一项不是 ready | 绑定名写错（数据库要叫 `DB`，桶要叫 `STORAGE`），或库/桶名字不对 | 名字必须与 `wrangler.toml` 完全一致 |

## 附录 B 纯命令行做法

```powershell
cd <本项目目录>

wrangler login                                   # 登录（或用 API Token 的账号环境变量）

wrangler d1 create lyjxxapp-d1 --location apac   # 建库（亚太），把输出的 ID 回填 wrangler.toml
wrangler r2 bucket create lyjxxapp-r2 --location apac   # 建桶（亚太）

npm run schema:remote                            # 一条命令建完 4 个建表脚本
wrangler d1 execute lyjxxapp-d1 --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"   # 核对表是否都在

python tools\export_sqlite.py ..\fastapi\data\lyjx.db out\seed.sql
wrangler d1 execute lyjxxapp-d1 --remote --file=out\seed.sql    # 导数据

# 把 .secrets.json 里三个值填好（模板是 .secrets.json.example），然后：
npm run secrets:put                              # 推密钥

npm test                                         # 本地自检
npm run deploy                                   # 部署

wrangler tail                                    # 看实时日志
wrangler deployments list                        # 看历史版本
wrangler rollback                                # 有问题就回到上一版
```

域名也可以在 `wrangler.toml` 里加，然后重新部署：

```toml
routes = [
  { pattern = "lyjx.250036.xyz", custom_domain = true }
]
```

部署后在 Worker → **Settings → Triggers** 应能看到这条定时任务（时间显示为 UTC）。

## 附录 C 如果数据库/存储桶建到了西欧

**先说结论**：建资源时选的地区，**建完就改不了**，控制台也没有"改地区"的入口。所以选错了只能"新建一份正确的 + 把数据搬过去 + 改绑定"。

先确认现状（需要能查账号的 API Token）：

```powershell
node tools/cf_region.mjs report     # 也可以分别用 wrangler d1 list / wrangler r2 bucket list 看地区列
```

期望值都是 **`apac`（亚太）**。

**做法 A（推荐：新建 + 搬数据，旧的不删、随时能退回来）**

```powershell
cd <本项目目录>
node tools/cf_region.mjs create --d1 lyjxxapp-d1-apac --r2 lyjxxapp-r2-apac   # 也可以在控制台手动建，地区选亚太

wrangler d1 export lyjxxapp-d1 --remote --output=out\region\backup.sql         # 备份旧库（行数对不上就别往下走）
wrangler d1 execute lyjxxapp-d1-apac --remote --file=out\region\backup.sql     # 导进新库

# 素材：控制台 → R2 → Super Slurper 把旧桶复制到新桶；或用 rclone 复制（对象数、总大小要一致）

# 改 wrangler.toml 两个名字后重新部署：
#   [[d1_databases]] database_name = "lyjxxapp-d1-apac" / database_id = "<新的 ID>"
#   [[r2_buckets]]  bucket_name  = "lyjxxapp-r2-apac"
npx wrangler deploy

# 最后把 storage.250036.xyz 从旧桶摘下来，挂到新桶（一个域名同时只能挂一个桶）；MEDIA_BASE 不用改
```

搬完照着「第 11 步 上线前自查」再走一遍。

**做法 B（保留原来的名字，不推荐）**：地点不同名会冲突，只能"先删再建"，期间网站不可用，且**删了不能恢复**。必须先完整备份（数据库导出 SQL，素材复制到本地或临时桶），再删库/删桶、按亚太重建、把数据传回去。备份文件在导完并验证成功之前不要删。

## 附录 D 上线后怎么回退

| 情况 | 怎么做 |
| --- | --- |
| 只回退程序版本 | `wrangler rollback` |
| 整站退到旧后端 | 小程序「我的 → 线路切换」切到线路二 `https://api0.250036.xyz`（旧后端和旧数据库全程没动过） |
| 数据库/存储桶也想退回去 | 把 `wrangler.toml` 里的库名、桶名改回旧值 → 重新部署 → 再把 `storage.250036.xyz` 挂回旧桶 |

旧后端和旧数据库**先保留 1~2 周**再考虑下线，作为兜底。
