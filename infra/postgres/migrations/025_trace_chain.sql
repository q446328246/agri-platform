-- 025 全链路质量溯源：给 trace_records 增加 batch_code（溯源码），把同一批产品的多条档案事件串成一条链。
--
-- 背景：档案表 trace_code 每行唯一（处方事件按事件号幂等），单条只能回答"这一件事"，
-- 无法回答"这批产品从整地到采收经历了哪些环节"。batch_code 是面向消费者的溯源码，
-- 同一溯源码下的多条事件按时间正序即为完整链条。
-- batch_code 为纯文本，不建外键：批次可由人工在建档时填写（投入品、采收、加工…），
-- 事件自动写入的处方档案默认留空（决策服务不产出批次号），不参与成链。
ALTER TABLE trace_records ADD COLUMN IF NOT EXISTS batch_code TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_trace_records_batch ON trace_records (batch_code);

-- 演示链条回填：按地块把既有 2026 档案归入可读溯源码，形成"按溯源码看全链条"的样例。
-- 仅回填 batch_code，不新增/删除行，保证溯源档案总数与既有基线一致。
UPDATE trace_records SET batch_code = 'BT-2026-E01' WHERE plot_code = '511723-000001-01-00001-0000-5' AND batch_code = '';
UPDATE trace_records SET batch_code = 'BT-2026-E02' WHERE plot_code = '511723-000001-01-00002-0000-Z' AND batch_code = '';
UPDATE trace_records SET batch_code = 'BT-2026-E03' WHERE plot_code = '511723-000001-01-00003-0000-T' AND batch_code = '';
UPDATE trace_records SET batch_code = 'BT-2026-E04' WHERE plot_code = '511723-000001-01-00004-0000-N' AND batch_code = '';
UPDATE trace_records SET batch_code = 'BT-2026-W05' WHERE plot_code = '511723-000001-02-00005-0000-C' AND batch_code = '';
UPDATE trace_records SET batch_code = 'BT-2026-W07' WHERE plot_code = '511723-000001-02-00007-0000-0' AND batch_code = '';
UPDATE trace_records SET batch_code = 'BT-2026-N08' WHERE plot_code = '511723-000001-03-00008-0000-P' AND batch_code = '';
UPDATE trace_records SET batch_code = 'BT-2026-N09' WHERE plot_code = '511723-000001-03-00009-0000-J' AND batch_code = '';
UPDATE trace_records SET batch_code = 'BT-2026-N10' WHERE plot_code = '511723-000001-03-00010-0000-U' AND batch_code = '';
