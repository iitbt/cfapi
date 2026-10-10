---
name: nickname-raw-joint-fix
overview: 前后端联动修复昵称状态后缀口径：前端编辑框回填/比较改用 nickname_raw，后端修正剥离顺序与比较基准并加空更新防护，补齐存量 raw_nickname 启动自检 + 只读 CLI 报表、3 条防回归用例与文档口径同步。
todos:
  - id: backend-selfcheck
    content: 在 database.py 新增只读 verify_raw_nicknames() 并在 init_schema 的 backfill 之后调用，汇总告警且不阻断启动
    status: completed
  - id: backend-cli
    content: 新增 fastapi/tools/check_nicknames.py 只读 CLI 报表，复用自检函数，支持 --limit/--all/--json，不含写回开关
    status: completed
    dependencies:
      - backend-selfcheck
  - id: backend-update-profile
    content: 用 [subagent:code-explorer] 核对行号后重构 update_profile：剥离前置、比较基准改 account_raw_nickname、按 nickname_changed 写库、空更新早退、顺带回填 raw、两档哨兵日志
    status: completed
    dependencies:
      - backend-selfcheck
  - id: frontend-profile
    content: 改 profile.js：编辑框回填与比较改用 nickname_raw、注销弹窗文案对齐实现、同步修正旧注释
    status: completed
    dependencies:
      - backend-update-profile
  - id: smoke-tests
    content: 在 smoke_test.py 注销/恢复用例后追加后缀在中间、在末尾、16 字截断巧合、语义未变共 4 条用例（先补 token）
    status: completed
    dependencies:
      - backend-update-profile
  - id: docs-sync
    content: 同步文档：主 README 加同版本发布醒目说明并修正注销表述，fastapi/README.md 与 lyxj/README.md 改昵称口径，用 [skill:launch-wechat-miniprogram] 复核注销告知合规性
    status: completed
    dependencies:
      - frontend-profile
      - backend-update-profile
  - id: acceptance
    content: 输出验收清单：三条测试命令与预期项数、只读 CLI 预期 raw_empty 为 0、后端启动日志检查点、前端手工回归步骤与同版本发布口径
    status: completed
    dependencies:
      - smoke-tests
      - docs-sync
---

## User Requirements

统一「状态后缀（(已注销)/(已恢复)）」的昵称口径：数据库直接存带后缀的展示昵称，各端只读数据库昵称，并以 raw_nickname（真实原昵称）作为唯一基准重算 nickname。本轮要把这条口径真正做干净。

## Product Overview

修复一个跨端的数据污染问题：账号被注销或由管理员恢复后，数据库昵称形如「原名(已恢复)」；而「编辑资料」弹窗当前把这份带后缀的昵称原样填进输入框。用户只要在编辑框里把后缀挪到中间或在其后加字，保存后这段本该是状态标记的文字就会变成他的真实昵称，并被长期保留、随每次注销/恢复继续传递，形成难以排查的脏数据。

同时修正注销告知：弹窗现在告诉用户「重置昵称与头像」，而系统实际是保留原头像、把昵称标记为「原昵称(已注销)」。

## Core Features

- 编辑资料弹窗内只显示真实原昵称（不带任何状态后缀），输入框长度上限与真实昵称对齐，不再出现"回填值超长"的错乱体验。
- 页面与列表展示仍显示数据库昵称（含状态后缀），保证后台、数据库、小程序三处一致，互不拼接。
- 后端写入昵称时按正确顺序处理：先剥离状态后缀，再限长；后缀只认末尾连续出现的形式，不误剥、不吞字。
- "只是把后缀提交回来、其实没改昵称"被判定为无变化：不写库、不触发多余的昵称安全校验、不产生"改了又被回滚"的状态。
- 后端在昵称落库前后做只读哨兵检查：一旦发现状态后缀被带进真实昵称，立即在日志中告警，便于线上尽早发现。
- 注销二次确认的告知文案与实际行为完全一致：账号立即停用、昵称标记为「原昵称(已注销)」、头像与已发布内容保留、可联系管理员恢复。
- 存量数据可校验：启动时自动统计并告警（昵称为空的原昵称、状态与昵称不匹配、正常账号昵称里混入状态后缀），并提供只读报表供人工随时核查导出。
- 新增防回归用例，固化"后缀在中间原样保留、后缀在末尾被剥掉、超长截断后恰好干净"等行为；文档口径同步。
- 发版约束：前后端必须同版本上线（只改一端都会引入新问题）。

## Tech Stack Selection

沿用现有技术栈，不引入任何新依赖：

- 后端：Python 3.10+ / FastAPI（`fastapi/`），原生 SQL 访问 `app.core.database.DB`（双库 MySQL/MariaDB 与 SQLite），日志用 `app.core.logging.get_logger`
- 前端：微信原生小程序（`lyxj/`），纯 JS + wxml，无构建链
- 测试：`fastapi/tests/smoke_test.py`（临时 SQLite，只读、不连外网）
- 工具：`fastapi/tools/` 下的 argparse 脚本（对齐 `tools/reset_admin_password.py` 的写法与只读约定）

## Implementation Approach

1. **前端从源头堵**：编辑框的回填与"昵称是否变化"的比较基准从展示名 `nickname` 换成真实原昵称 `nickname_raw`（后端 `app/api/user.py:64-68` 的注释已写明该字段就是为此下发的）。后缀因此不再进入编辑框，S1 的根因被消除。
2. **后端兜底加固**：把 `_clean_nickname()` 里耦合的"去控制字符"与"限长"拆开，让执行顺序与既有注释（`user.py:359-360`）一致：**先剥离 → 再限长**；比较基准改为 `account_raw_nickname(user)`。
3. **连带修两处必须修的后果**（换基准后才会暴露，属于同一次改动的完整闭环）：

- 写库条件由 `if nickname:` 改为 `if nickname_changed:`，避免"语义未变却改库 → 下次启动回填又把后缀写回"的鬼状态；
- `update_parts` 可能为空，必须早退，否则会拼出 `UPDATE users SET  WHERE id = ?` 直接 SQL 语法错误（返回 500）。

4. **顺带回填**：当昵称语义未变、但库内 `raw_nickname` 为空而能算出真实原昵称时，把该值补写回去 —— 直接服务于"所有用户 raw_nickname 非空"。
5. **哨兵双档**：既判"最终值仍以后缀结尾"，也判"昵称内部含后缀 token"。后者才覆盖 S1 最典型的脏数据形态（后缀被挪到中间），只记 warning、绝不改写数据。
6. **存量校验双产物**：启动只读自检（汇总 + 限量告警，不阻断启动）＋ `tools/` 只读 CLI 报表（人工核查导出）。
7. **前后端同版本发布**：前端 `profile.js` 与后端 `user.py` 必须一起上；主 README 版本表附近补醒目说明。

关键取舍：剥离只保留"末尾连续后缀"语义，**不**升级为"全文替换"。因为昵称中间出现 `(已恢复)` 字符串既可能是用户自己写的，也可能是被带进去的，后端无法可靠区分；从源头（编辑框不再带后缀）解决才是正解，后端只做兜底与可见性。

## Implementation Notes

- **改动面控制**：只动 `fastapi/app/api/user.py`、`fastapi/app/core/database.py`、新增 1 个 tools 脚本、`fastapi/tests/smoke_test.py` 追加、`lyxj/pages/profile/profile.js`、3 份文档。既有 281 项断言**不得改动**，只允许在指定位置追加。
- **`nickname_changed` 影响面已核实**：全仓仅出现在 `user.py:371/372/391`，只用于"是否送机审"与"是否置 `nickname_modified=1`"，无统计/风控消费者，换基准安全。换基准后这两个用途的语义变为"用户是否真的把昵称改成了别的名字"，更准确。
- **`update_profile` 的查库字段必须补齐**：`user.py:353` 目前只选 `id, username, nickname, openid, deleted_at`；调用 `account_raw_nickname(user)` 需要 `raw_nickname` 与 `orig_nickname`，必须一起 SELECT，否则兜底永远走不到。
- **前端提交体形状未变**：`saveProfile` 只提交 `{ nickname }`（头像走 `wx.uploadFile` 单独上传），后端 `avatar` 字段在 App 流程里始终为空 —— 因此"空更新早退"分支只会被外来客户端/异常输入触发，但必须存在，否则是 500 隐患。
- **前端比较基准要三处一致**：`openEditProfile` 的回填、`saveProfile` 的 `nicknameChanged`、以及无变化时的 "没有需要保存的修改" 提示，必须使用同一个基准（`nickname_raw || nickname`），否则会出现"改了却没提交"或"没改却提交了"。
- **不动的东西**：`loginBehavior._guideSetNickname`（`loginBehavior.js:226-228`）已正确使用 `nickname_raw`；`profile.js:360-364` 保存成功后回写 `{nickname, nickname_raw}` 的逻辑正确；`/user/login`、`delete_account`、后台恢复动作、留言相关内容本轮均不改。
- **回归风险点**：`update_profile` 是"改昵称 + 改头像"共用的接口，改造时必须保证"只换头像"（昵称字段与当前一致）仍然正常返回 200 并带上 `avatar_url`。
- **日志规范**：哨兵日志只记 `user_id` 与昵称值本身（昵称是用户自填文本，属必要信息），不记 token/openid；自检清单限量（如最多 20 条）避免刷日志。

## Architecture Design

维持现有分层不变，只在既有位置做点状加固：

- 口径层（不变）：`app/core/common.py` 仍是昵称计算的唯一实现（`strip_account_state_suffix` / `build_state_nickname` / `account_raw_nickname` / `account_display_nickname` / `account_state`）
- 接口层（改）：`app/api/user.py::update_profile` 的清洗顺序、比较基准、写库条件
- 数据自愈层（改）：`app/core/database.py` 在 `backfill_raw_nicknames()` 之后新增只读 `verify_raw_nicknames()`，由 `init_schema()` 调用
- 运维层（新增）：`app/core/database.py` 的自检函数被 `tools/check_nicknames.py` 复用，避免"启动自检"和"人工报表"两份统计逻辑漂移
- 表现层（改）：`lyxj/pages/profile/profile.js` 的回填/比较/注销文案

数据流（改后）：用户编辑 → 前端用 `nickname_raw` 回填与比较 → 提交 → 后端去控制字符（不截断）→ 剥离末尾后缀 → 限长 → 与 `account_raw_nickname(user)` 比较 → 有变化则机审后写 `nickname` + `raw_nickname` + `nickname_modified=1`；无变化则不写库（必要时补写 `raw_nickname`）→ 返回干净昵称供前端同步两处缓存。

## Directory Structure

```
iitbt/
├── fastapi/
│   ├── app/
│   │   ├── api/
│   │   │   └── user.py                 # [MODIFY] update_profile：拆分清洗与限长（新增 _sanitize_nickname，_clean_nickname 保留旧语义）；剥离提到限长之前；SELECT 补 raw_nickname/orig_nickname；nickname_changed 比较基准改为 account_raw_nickname(user)；写库条件改为 nickname_changed；update_parts 为空时早退返回 200「资料未发生变化」且不回显 nickname；raw_nickname 为空时顺带回填；新增两档哨兵 warning。delete_account / login / get_user_info 不动。
│   │   └── core/
│   │       └── database.py             # [MODIFY] 新增只读 verify_raw_nicknames(db) -> dict（total / raw_empty / state_mismatch / suffix_in_normal，info 汇总 + warning 限量清单，内部 try/except 不抛错、全 SELECT）；在 init_schema() 的 backfill_raw_nicknames() 之后调用（注意 DB_AUTO_INIT 关闭时不执行，与现有行为一致）。
│   └── tools/
│       └── check_nicknames.py          # [NEW] 只读 CLI 报表：argparse + ROOT 入 sys.path + from app.core.database import DB/verify_raw_nicknames，默认打印汇总与限量清单，支持 --limit N / --all / --json；不提供任何写回/修复开关；finally 中 db.close()。
│   └── tests/
│       └── smoke_test.py               # [MODIFY] 仅在 :1658 之后、:1659 清理 DELETE 之前追加用例：①后缀在中间 ②后缀在末尾且有前缀文字 ③16 字原名+后缀+额外字符（歪打正着）④语义未变（保护不写库与早退分支）；追加前需 db.execute 给 del_id 补一个新 token（二次注销已把 token 置空）。既有断言不动。
├── lyxj/
│   └── pages/
│       └── profile/
│           └── profile.js              # [MODIFY] openEditProfile 回填改 nickname_raw || nickname；saveProfile 的 nicknameChanged 同基准；deleteAccount 弹窗 content 改为三行新文案、函数注释同步；:93-104 与 :252-254 的旧注释改写为"为什么这么改"。
├── README.md                           # [MODIFY] 版本状态表附近新增醒目说明：本次为前后端联动改动、必须同版本发布、只改一端的后果；:28 与 :173 的注销表述改为"昵称标记为『原昵称(已注销)』、头像与数据保留"。
├── fastapi/README.md                   # [MODIFY] :262 回填口径改为 nickname_raw；:261 补"剥离在限长之前、只认末尾连续后缀"；:346 补"送检基准是 raw_nickname"。
└── lyxj/README.md                      # [MODIFY] :89 改为"展示用 nickname，编辑回填与比较用 nickname_raw"；检索并统一其余"编辑框必须和数据库同步"的表述。
```

## Key Code Structures

后端 `update_profile` 的写库决策（本次改动的核心契约）：

```python
# 1) 清洗(不截断) → 2) 剥离(带 deleted_at 时) → 3) 限长
nickname = _sanitize_nickname(strval(data.get("nickname", "")))
# ... 查询 user(含 raw_nickname / orig_nickname / deleted_at / openid)
if nickname and user.get("deleted_at"):
    nickname = strip_account_state_suffix(nickname)
nickname = nickname[:_MAX_NICKNAME_LEN]

raw_now = account_raw_nickname(user)
nickname_changed = bool(nickname) and nickname != raw_now

if nickname_changed:
    # 机审通过后, nickname 与 raw_nickname 一起写, 并置 nickname_modified = 1
    update_parts += ["nickname = ?", "raw_nickname = ?", "nickname_modified = 1"]
    params += [nickname, nickname]
elif nickname and not strval(user.get("raw_nickname")).strip():
    update_parts.append("raw_nickname = ?")   # 语义未变: 顺带回填, 服务于"所有用户 raw_nickname 非空"
    params.append(nickname)

if not update_parts:
    # 昵称语义未变且无头像变更: 不写库、不回显 nickname(避免客户端与库显示不一致)
    return _resp(200, "资料未发生变化", {})
```

哨兵（只告警、不改数据）：

```python
if any(suffix in nickname for suffix in ACCOUNT_STATE_SUFFIXES):
    logger.warning("昵称中检测到状态后缀(可能被用户从展示名带入): user_id=%s nickname=%s",
                   user["id"], nickname)
if strip_account_state_suffix(nickname) != nickname:
    logger.warning("昵称以状态后缀结尾: user_id=%s nickname=%s", user["id"], nickname)
```

前端比较基准（三处必须同源）：

```js
const nicknameBasis = this.data.userInfo.nickname_raw || this.data.userInfo.nickname || '';
// openEditProfile:  editNickname: nicknameBasis
// saveProfile:      const nicknameChanged = nickname !== nicknameBasis;
```

## Agent Extensions

### SubAgent

- **code-explorer**
- Purpose: 在动手改代码前复核本轮 6 处改动目标的文件与行号（`user.py:331-411`、`database.py:1261-1375`、`smoke_test.py:1530-1660`、`profile.js:93-104/246-260/288-387/1234-1256`、4 份文档的目标行），确认无偏移、无新增同名调用点。
- Expected outcome: 输出一份"目标位置核对结果"，标明每处待改代码的行号是否仍然准确、`_clean_nickname` 与 `nickname_changed` 是否出现新的调用点，避免按旧行号改错位置。

### Skill

- **launch-wechat-miniprogram**
- Purpose: 借其"审核门禁 / 隐私与权限"清单，复核 P1-2 的注销告知文案（是否完整覆盖"账号停用、昵称标记、头像与内容保留、可联系管理员恢复"四项）以及本次改动的提审注意事项。
- Expected outcome: 给出一份注销告知文案的合规核对结论与提审注意点，确认文案与后端实际行为逐条对应、不存在夸大或遗漏。