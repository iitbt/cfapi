# 素材搬迁到 R2（由你自行执行）

实测体量（2026-10-04 于 `fastapi/`）：`news_uploads/` 23 个文件 0.57 MB（全在 `home/` 子目录），`avatar_uploads/` 空，`app/images/` 4 个文件 0.1 MB。**体量极小，几乎是一次性的复制操作。**

本次只搬仓库内这些现有文件，**不涉及视频**（已定），因此不需要私有块与签名 URL。

## 一、原则

- **R2 key 与数据库里存的相对路径保持一致**（历史是 `news_uploads/xxx.jpg`、`avatar_uploads/xxx.png`），这样库里字段一个都不用改。
- 新上传按类型落 `image/`（图片）、`video/`（视频）、`avatar/`（头像）；Worker 侧全部直出（含历史目录），见 `DEPLOY.md` 的「素材目录」节。
- 三个历史前缀（`news_uploads/`、`avatar_uploads/`、`images/`）全部公开，走自定义域直读。
- ~~派生文件（缩略图）必须在旧环境预生成~~ → **2.4.0 起缩略图功能整体移除**（规则、工具、接口与前端引用都删了），这里不再需要生成/上传派生文件；存量 `_thumb/` 对象的清理方案见 `README.md` 第 38 条与 `DEPLOY.md`「缩略图（已整体移除）」节。

## 二、步骤

1. 建立 bucket 与公开域（公开域已定：`storage.250036.xyz`）：

   ```bash
   wrangler r2 bucket create lyjxxapp-r2
   ```

3. 批量上传（保持目录层级即 key）：

   ```bash
   cd fastapi
   # 逐个上传; 文件只有二十几个, 不必写复杂脚本
   # **--remote 必须带**: wrangler v4 的 r2 object put 默认写本地模拟桶, 会照常打印 Upload complete 但线上桶里没有
   wrangler r2 object put lyjxxapp-r2/news_uploads/home/<文件> --file=news_uploads/home/<文件> --remote
   ```

   文件多时改用 S3 兼容方式（rclone / aws-cli，需 R2 的 Access Key 与 Secret —— **待确认**）：

   ```bash
   rclone copy fastapi/news_uploads r2:lyjxxapp-r2/news_uploads --transfers 8
   rclone copy fastapi/avatar_uploads r2:lyjxxapp-r2/avatar_uploads
   # app/images 里的 4 个文件必须放到 images/ 前缀: Worker 的 /images/* 从这里读
   # (站点图标 /favicon.ico 不在这里 —— 它是内联进 Worker 的, 见 DEPLOY.md「站点图标」)
   rclone copy fastapi/app/images r2:lyjxxapp-r2/images
   ```

4. 核对数量与体积：

   ```bash
   find fastapi/news_uploads -type f | wc -l          # 本地文件数
   ```

   R2 侧的对象数**没有 CLI 列举子命令**（实测 wrangler 4.147：`wrangler r2 object` 只有 `get` / `put` / `delete`），
   到控制台 R2 → 桶 `lyjxxapp-r2` → 对象列表按前缀筛，或直接请求公开域核对：`https://storage.250036.xyz/<key>` 返回 200 且体积与本地一致即为到位。

5. 验证公开访问：用一个真实 key 直接请求自定义域，确认 200 与 `Content-Type` 正确，并核对 **`Cache-Control`** 是否符合口径（上传写入的对象是 `public, max-age=604800, immutable`；vendor 1 年 immutable）—— 由自定义域缓存规则或前置 Worker 设置（**待确认**用哪种）。

## 三、验收

- 随机抽 5 个 key：R2 上的 key、体积与本地一致。
- `/news/list` 返回的 `image_url` 能直接打开（HTTP 200）。
- 后台素材库页能看到这些对象（列举覆盖 `image/`、`video/`、`news_uploads/`），且**不再有 `image_thumb` / `_thumb` 相关的键与地址**（2.4.0 起缩略图整体移除）。
