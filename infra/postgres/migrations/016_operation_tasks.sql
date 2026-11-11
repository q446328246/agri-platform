CREATE TABLE IF NOT EXISTS operation_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plot_code TEXT NOT NULL CHECK (length(trim(plot_code)) > 0),
  type TEXT NOT NULL CHECK (type IN ('TILLAGE','SEEDING','IRRIGATION','WEEDING','SPRAYING','FERTILIZATION')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','CANCELLED')),
  scheduled_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  assignee_name TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  result_json JSONB,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (scheduled_end_at IS NULL OR (scheduled_at IS NOT NULL AND scheduled_end_at > scheduled_at)),
  CHECK (status <> 'RUNNING' OR started_at IS NOT NULL),
  CHECK (status <> 'COMPLETED' OR (started_at IS NOT NULL AND completed_at IS NOT NULL AND result_json IS NOT NULL)),
  CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_operation_tasks_tenant_created ON operation_tasks(tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_operation_tasks_plot ON operation_tasks(tenant_id, plot_code);
CREATE TABLE IF NOT EXISTS operation_outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES operation_tasks(id),
  tenant_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_operation_outbox_pending ON operation_outbox(created_at) WHERE published_at IS NULL;
