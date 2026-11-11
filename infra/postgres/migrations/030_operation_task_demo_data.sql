-- 030 农事任务演示数据落库：把 operation-service 内存种子（http.ts 的 demoTasks）同口径写入 operation_tasks。
--
-- 背景：016 只建表不种子，SQL 模式（容器默认，DB_URL 存在即启用）下农事任务页与
-- `smoke:demo`/`smoke:filters` 的「农事任务 ≥8」一直拿不到数据；内存种子只在
-- OPERATION_REPOSITORY_MODE=memory 的单进程演示里存在，重启即消失，落库后演示数据不再依赖进程内存。
--
-- 口径：
-- - 八条任务覆盖六种作业类型与四种状态，时间用 now() 相对偏移，任何时候部署都是「正在进行 + 未来排程 + 历史完成」；
-- - 完成作业的 finishedAreaMu 不写死，按任务所属地块的台账面积现取（plot_records.area_mu 恒等于边界几何重算值，见迁移 015）；
-- - 严格遵守 016 的 CHECK：RUNNING 必有 started_at，COMPLETED 必有 started_at/completed_at/result_json，
--   CANCELLED 必有 cancelled_at（内存种子留空是 SQL 模式下无法照搬的一处差异）；
-- - 只为仍在册的地块建任务（软删归档的地块跳过），避免示范任务挂在已归档编码上；
-- - 幂等：ON CONFLICT DO NOTHING，重复执行不产生第二套任务。
INSERT INTO operation_tasks (
  id, tenant_id, plot_code, type, name, status,
  scheduled_at, scheduled_end_at, assignee_name, created_at,
  started_at, completed_at, cancelled_at, result_json, version
)
SELECT
  seed.id, 'tenant-demo', plot.parcel_code, seed.type, seed.name, seed.status,
  now() + seed.scheduled_offset,
  CASE WHEN seed.scheduled_duration IS NULL THEN NULL ELSE now() + seed.scheduled_offset + seed.scheduled_duration END,
  seed.assignee_name,
  now() + seed.created_offset,
  CASE WHEN seed.status IN ('RUNNING', 'COMPLETED') THEN now() + seed.started_offset ELSE NULL END,
  CASE WHEN seed.status = 'COMPLETED' THEN now() + seed.completed_offset ELSE NULL END,
  CASE WHEN seed.status = 'CANCELLED' THEN now() + seed.cancelled_offset ELSE NULL END,
  CASE WHEN seed.status = 'COMPLETED' THEN
    jsonb_build_object(
      'outcome', 'success',
      'finishedAreaMu', plot.area_mu,
      'notes', seed.name || '按农艺方案完成，作业面积按地块边界台账面积记账'
    )
  ELSE NULL END,
  1
FROM (VALUES
  ('task-demo-001', '511723-000001-02-00005-0000-C', 'IRRIGATION',     '西区一号田补灌执行',       'RUNNING',   INTERVAL '-4 hours',  INTERVAL '3 hours',  '张建国', INTERVAL '-8 hours',  INTERVAL '-4 hours', NULL::interval,          NULL::interval),
  ('task-demo-002', '511723-000001-01-00003-0000-T', 'SPRAYING',       '东区三号田病虫害喷防',     'PENDING',   INTERVAL '6 hours',   INTERVAL '2 hours',  '李秀芳', INTERVAL '-10 hours', NULL::interval,          NULL::interval,          NULL::interval),
  ('task-demo-003', '511723-000001-03-00009-0000-J', 'FERTILIZATION',  '联片二号田抽穗期追肥',     'PENDING',   INTERVAL '20 hours',  INTERVAL '4 hours',  '王德明', INTERVAL '-26 hours', NULL::interval,          NULL::interval,          NULL::interval),
  ('task-demo-004', '511723-000001-04-00012-0000-D', 'TILLAGE',        '演练田耕整地作业',         'PENDING',   INTERVAL '30 hours',  INTERVAL '6 hours',  '赵光辉', INTERVAL '-30 hours', NULL::interval,          NULL::interval,          NULL::interval),
  ('task-demo-005', '511723-000001-03-00010-0000-U', 'WEEDING',        '联片三号田除草作业',       'RUNNING',   INTERVAL '-2 hours',  INTERVAL '5 hours',  '陈利军', INTERVAL '-14 hours', INTERVAL '-2 hours',   NULL::interval,          NULL::interval),
  ('task-demo-006', '511723-000001-01-00001-0000-5', 'IRRIGATION',     '东区一号田水肥一体化追肥', 'COMPLETED', INTERVAL '-50 hours', INTERVAL '4 hours',  '张建国', INTERVAL '-60 hours', INTERVAL '-50 hours',  INTERVAL '-46 hours',    NULL::interval),
  ('task-demo-007', '511723-000001-02-00007-0000-0', 'SPRAYING',       '西区三号田叶面肥喷施',     'COMPLETED', INTERVAL '-96 hours', INTERVAL '3 hours',  '李秀芳', INTERVAL '-110 hours', INTERVAL '-96 hours',   INTERVAL '-93 hours',    NULL::interval),
  ('task-demo-008', '511723-000001-01-00002-0000-Z', 'SEEDING',        '东区二号田机插秧',         'CANCELLED', INTERVAL '-140 hours', INTERVAL '8 hours', '王德明', INTERVAL '-150 hours', NULL::interval,          NULL::interval,          INTERVAL '-141 hours')
) AS seed (id, plot_code, type, name, status, scheduled_offset, scheduled_duration, assignee_name, created_offset, started_offset, completed_offset, cancelled_offset)
JOIN plot_records plot ON plot.parcel_code = seed.plot_code AND plot.deleted_at IS NULL
ON CONFLICT (id) DO NOTHING;
