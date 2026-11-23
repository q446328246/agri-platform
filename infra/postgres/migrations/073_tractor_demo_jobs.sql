-- 073：拖拉机作业演示数据（B2 端到端可见）
--
-- 为演示拖拉机 T01（device-tractor-001）补充作业台账、分步指令、轨迹与安全事件，
-- 使前端「拖拉机作业」页登录后即有数据可查。
--
-- 约定：
-- 1. T01 台账绑定地块为联片三号田（511723-000001-03-00010-0000-U）；
-- 2. 演示种子 ON CONFLICT DO NOTHING，重复执行不报错；
-- 3. 覆盖三种状态：已完成、作业中（已暂停）、已急停，保证页面列表不空。

-- ---------- 作业台账 ----------
INSERT INTO tractor_jobs (id, tenant_id, plot_code, device_id, operation_type, parameters, status, current_stage, operator, reason, started_at, finished_at, created_at, updated_at) VALUES
  ('job-demo-tractor-001', 'tenant-demo', '511723-000001-03-00010-0000-U', 'device-tractor-001', 'SEEDING',
   '{"areaMu": 27.9, "durationMin": 60}', 'COMPLETED', 3, 'user-operator', '联片三号田播种作业',
   now() - interval '3 days', now() - interval '2 days', now() - interval '3 days', now() - interval '2 days'),
  ('job-demo-tractor-002', 'tenant-demo', '511723-000001-03-00010-0000-U', 'device-tractor-001', 'TILLAGE',
   '{"areaMu": 20.0, "durationMin": 45}', 'PAUSED', 1, 'user-operator', '联片三号田整地作业',
   now() - interval '1 day', NULL, now() - interval '1 day', now() - interval '1 day'),
  ('job-demo-tractor-003', 'tenant-demo', '511723-000001-03-00010-0000-U', 'device-tractor-001', 'WEEDING',
   '{"areaMu": 15.5, "durationMin": 30}', 'ESTOPPED', 1, 'user-operator', '联片三号田除草作业',
   now() - interval '5 days', now() - interval '5 days', now() - interval '5 days', now() - interval '5 days')
ON CONFLICT (id) DO NOTHING;

-- ---------- 分步指令 ----------
INSERT INTO tractor_job_stages (id, job_id, stage, command_type, parameters, status, detail, created_at, updated_at) VALUES
  -- 作业 001：已完成
  ('stage-demo-001-1', 'job-demo-tractor-001', 'TOOL_SWITCH', 'TOOL_SWITCH', '{"toolCode":"SEEDER"}', 'DONE', '换具完成', now() - interval '3 days', now() - interval '3 days'),
  ('stage-demo-001-2', 'job-demo-tractor-001', 'OPERATION', 'SEEDING', '{"areaMu":27.9,"durationMin":60}', 'DONE', '播种完成', now() - interval '3 days', now() - interval '2 days'),
  ('stage-demo-001-3', 'job-demo-tractor-001', 'RETURN_HOME', 'RETURN_HOME', '{}', 'DONE', '返航完成', now() - interval '2 days', now() - interval '2 days'),
  -- 作业 002：已暂停
  ('stage-demo-002-1', 'job-demo-tractor-002', 'TOOL_SWITCH', 'TOOL_SWITCH', '{"toolCode":"PLOW"}', 'DONE', '换具完成', now() - interval '1 day', now() - interval '1 day'),
  ('stage-demo-002-2', 'job-demo-tractor-002', 'OPERATION', 'TILLAGE', '{"areaMu":20.0,"durationMin":45}', 'PENDING', '等待恢复', now() - interval '1 day', now() - interval '1 day'),
  ('stage-demo-002-3', 'job-demo-tractor-002', 'RETURN_HOME', 'RETURN_HOME', '{}', 'PENDING', '等待恢复', now() - interval '1 day', now() - interval '1 day'),
  -- 作业 003：已急停
  ('stage-demo-003-1', 'job-demo-tractor-003', 'TOOL_SWITCH', 'TOOL_SWITCH', '{"toolCode":"WEEDER"}', 'DONE', '换具完成', now() - interval '5 days', now() - interval '5 days'),
  ('stage-demo-003-2', 'job-demo-tractor-003', 'OPERATION', 'WEEDING', '{"areaMu":15.5,"durationMin":30}', 'FAILED', '急停收口', now() - interval '5 days', now() - interval '5 days'),
  ('stage-demo-003-3', 'job-demo-tractor-003', 'RETURN_HOME', 'RETURN_HOME', '{}', 'SKIPPED', '急停跳过', now() - interval '5 days', now() - interval '5 days')
ON CONFLICT (id) DO NOTHING;

-- ---------- 作业轨迹 ----------
INSERT INTO tractor_trajectories (id, job_id, tenant_id, plot_code, source, path, lanes, heading_deg, implement_width_m, total_distance_m, duration_min, warnings, created_at, updated_at) VALUES
  ('traj-demo-001', 'job-demo-tractor-001', 'tenant-demo', '511723-000001-03-00010-0000-U', 'AUTO',
   '[[107.4300,30.9847],[107.4310,30.9850],[107.4320,30.9855],[107.4330,30.9863],[107.4340,30.9871],[107.4335,30.9872],[107.4325,30.9865],[107.4315,30.9860],[107.4305,30.9855],[107.4300,30.9847]]',
   '[{"index":1,"pass":1,"coordinates":[[107.4300,30.9847],[107.4340,30.9871]],"lengthM":650.0}]',
   45.0, 6.0, 1200.0, 55.0, '[]', now() - interval '3 days', now() - interval '3 days'),
  ('traj-demo-002', 'job-demo-tractor-002', 'tenant-demo', '511723-000001-03-00010-0000-U', 'AUTO',
   '[[107.4300,30.9847],[107.4320,30.9855],[107.4340,30.9871],[107.4312,30.9873],[107.4297,30.9861],[107.4300,30.9847]]',
   '[{"index":1,"pass":1,"coordinates":[[107.4300,30.9847],[107.4340,30.9871]],"lengthM":520.0}]',
   90.0, 6.0, 980.0, 45.0, '[]', now() - interval '1 day', now() - interval '1 day'),
  ('traj-demo-003', 'job-demo-tractor-003', 'tenant-demo', '511723-000001-03-00010-0000-U', 'AUTO',
   '[[107.4300,30.9847],[107.4320,30.9855],[107.4340,30.9871],[107.4312,30.9873],[107.4297,30.9861],[107.4300,30.9847]]',
   '[{"index":1,"pass":1,"coordinates":[[107.4300,30.9847],[107.4340,30.9871]],"lengthM":520.0}]',
   90.0, 6.0, 980.0, 45.0, '[]', now() - interval '5 days', now() - interval '5 days')
ON CONFLICT (id) DO NOTHING;

-- ---------- 安全事件 ----------
INSERT INTO tractor_safety_events (id, tenant_id, job_id, plot_code, device_id, kind, level, message, lng, lat, created_at) VALUES
  ('safety-demo-001', 'tenant-demo', 'job-demo-tractor-002', '511723-000001-03-00010-0000-U', 'device-tractor-001', 'RTK_QUALITY', 'WARNING', 'RTK 定位质量下降，HDOP 偏大', 107.4320, 30.9855, now() - interval '12 hours'),
  ('safety-demo-002', 'tenant-demo', NULL, '511723-000001-03-00010-0000-U', 'device-tractor-001', 'GEOFENCE_BREACH', 'CRITICAL', '电子围栏越界预警', 107.4345, 30.9875, now() - interval '6 hours'),
  ('safety-demo-003', 'tenant-demo', 'job-demo-tractor-003', '511723-000001-03-00010-0000-U', 'device-tractor-001', 'ESTOP', 'CRITICAL', '人工急停：轨迹偏离，安全收口', 107.4320, 30.9855, now() - interval '5 days')
ON CONFLICT (id) DO NOTHING;
