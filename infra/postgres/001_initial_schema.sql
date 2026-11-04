CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS plot_records (
  parcel_id TEXT PRIMARY KEY,
  parcel_code TEXT NOT NULL UNIQUE,
  parcel_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  area_mu NUMERIC(14, 2) NOT NULL CHECK (area_mu >= 0),
  soil_type TEXT,
  geom JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_plot_records_tenant_created ON plot_records (tenant_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS finance_entries (
  id TEXT PRIMARY KEY,
  plot_code TEXT NOT NULL,
  season TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('INPUT', 'OUTPUT')),
  category TEXT NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
  unit TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_entries_plot_created ON finance_entries (plot_code, created_at DESC);

CREATE TABLE IF NOT EXISTS trace_records (
  id TEXT PRIMARY KEY,
  trace_code TEXT NOT NULL UNIQUE,
  plot_code TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL,
  operator TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_records_plot_created ON trace_records (plot_code, created_at DESC);
