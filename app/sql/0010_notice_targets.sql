-- 0010: 公告"指定用户"由单值列改成逗号列表(2.6.0) —— 一条公告可以指定多位收件人。
--
-- 为什么改存法: 2.5.9 的 target_user_id 只能写一个人, 运营想"只发给这 5 位"就得发 5 条公告。
-- 新列 target_user_ids 存 `,7,9,`(两端带逗号), 可见性判定写成 `target_user_ids LIKE '%,7,%'` ——
-- 两端带逗号是为了不让 17、70 被当成 7 的收件人(写法与读法见 app/core/notice_targets.js)。
--
-- 幂等性: ALTER TABLE ADD COLUMN **不幂等**(重复执行报 duplicate column name), 只对老库执行一次。
-- 新建库的 app_notices 已含该列(见 0001_schema.sql), 不用跑本文件。
-- 执行: npm run schema:noticetargets
ALTER TABLE app_notices ADD COLUMN target_user_ids TEXT NOT NULL DEFAULT '';

-- 回填: 老库里的定向行(target_user_id 非空)折进新列, 两端补逗号;
-- 其余行保持默认空串(接收人类型不是「指定用户」时, 收件人列表本来就该是空的)。
-- 不回填的后果: 2.5.7 起发的"内部测试申请已通过 / 已取消"与后台发过的定向公告立刻变成"没有收件人" ——
-- 谁都看不到, 而且是静默丢消息(接口不报错, 只是列表里少几条)。
UPDATE app_notices SET target_user_ids = ',' || target_user_id || ','
  WHERE target_user_id IS NOT NULL AND target_user_id > 0;

-- 折完之后 target_user_id 再无读取方(新代码只认 target_user_ids), 但**不要删列** ——
-- 本文件重跑一次就等于把已折好的数据再折一遍(上面的 WHERE 仍能命中旧列), 删了它这条回填就不再幂等。
