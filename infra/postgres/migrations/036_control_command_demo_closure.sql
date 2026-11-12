-- 036 演示库陈旧在途指令收口
--
-- 010 的六条演示指令里，`cmd-demo-001/002/003/005/006` 一直停在 QUEUED 或 SENT。031
-- 把生命周期补全为 QUEUED → SENT → ACKED → DONE 时**故意不回填** `sent_at` 等回执时间——
-- 历史行没有这些取值，编一个等于伪造设备上报。后果是这批行在 033 的收口任务上线后变成
-- 真正的麻烦：SQL 模式下 control-service 一起来，`ControlReceiptSweeper` 就把它们当成
-- 「超时未回执」刷成 FAILED，并各推一条 `control.command.timeout` 告警进消息中心。演示
-- 数据不是真实事故，不该占用现场告警通道，也不该让第一次启动的人以为设备集体掉线。
--
-- 本迁移按收口的口径把这批演示行手动落到终态，让收口任务无事可做：
-- - 范围只认 010 的演示编号前缀 `cmd-demo-`（真实指令的 id 由服务生成，不带这一前缀），
--   并且只改仍在途的行；现场自己下的超时指令仍归收口任务处理，它会连带推事件。
-- - 状态、`finished_at`、`version` 的写法与运行时跃迁一致（`version = version + 1`），
--   看板与列表读到的形状和真实收口过的指令相同。
-- - `receipt_message` 按在途阶段分两种：已下发未回执、入队未下发。文案写明是演示数据收口，
--   不是设备故障，避免后续开发照着它排查。
-- - **不**回填 `sent_at`/`acked_at`（031 的理由依旧成立），也**不**写 `result_json`：
--   运行时超时收口同样只改状态与留言，结果快照只有设备回执才会产生。
-- - **不**往 `control_outbox` 投递 `control.command.timeout`：迁移推告警等于给一批从没
--   发生过的事故发消息，去重键按指令 id 唯一，消息中心会长期留着这五条没人认领的告警。
--
-- 幂等：`status IN (...)` 让第二次执行匹配不到任何行，重复跑不改动任何东西。

UPDATE control_commands
SET status = 'FAILED',
    finished_at = now(),
    version = version + 1,
    receipt_message = CASE status
      WHEN 'QUEUED' THEN '演示数据收口：指令入队后从未下发，设备未接收，迁移 036 标记为失败（不是真实设备故障）'
      ELSE '演示数据收口：指令已下发但设备从未回执，迁移 036 标记为失败（不是真实设备故障）'
    END
WHERE id LIKE 'cmd-demo-%'
  AND status IN ('QUEUED', 'SENT', 'ACKED');
