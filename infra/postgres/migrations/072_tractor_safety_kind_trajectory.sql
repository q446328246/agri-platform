-- 072：拖拉机安全事件类型扩展「轨迹跟随偏离」
--
-- 起因：作业期监测新增轨迹跟随偏离判定——带轨迹的作业，RTK 实时位置离轨迹折线
-- 过远说明拖拉机没有按轨迹运行，需暂停/急停处置。原 kind CHECK 未含该类型，
-- 直接写会撞约束报错。
--
-- 约定：先删旧约束再加新约束，重复执行不撞约束名；既有数据不含新类型，放宽不改变存量行。

ALTER TABLE tractor_safety_events DROP CONSTRAINT IF EXISTS tractor_safety_events_kind_check;
ALTER TABLE tractor_safety_events ADD CONSTRAINT tractor_safety_events_kind_check
  CHECK (kind IN ('PRECHECK_FAIL', 'GEOFENCE_BREACH', 'RTK_QUALITY', 'COMM_LOSS', 'ESTOP', 'TRAJECTORY_DEVIATION'));
