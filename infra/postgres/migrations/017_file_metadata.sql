-- 017: Persistent, tenant-scoped file metadata. Objects remain in local/S3 storage.
-- No seeds or filesystem scans: only successful uploads create metadata.
-- Object storage and PostgreSQL are NOT a distributed transaction. The service
-- compensates failed metadata inserts by deleting only the newly created object.
CREATE TABLE IF NOT EXISTS file_metadata (
  id TEXT COLLATE "C" PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(btrim(tenant_id)) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 3 AND 127),
  size BIGINT NOT NULL CHECK (size >= 0 AND size <= 9007199254740991),
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) > 0),
  plot_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_file_metadata_tenant_created_id
  ON file_metadata (tenant_id, created_at DESC, id DESC);
