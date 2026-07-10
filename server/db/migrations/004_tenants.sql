-- Multi-tenant support: the app registration is now multi-tenant
-- (AzureADMultipleOrgs), so a single shared SQLite DB can serve many client
-- Microsoft 365 tenants. `tenants` tracks every tenant that's ever signed
-- in; `tenant_id` on users/mappings/jobs scopes each row to the tenant it
-- belongs to, so different clients' data never mixes together.
--
-- Pre-existing rows (from before this migration) are backfilled separately
-- in server/db/index.js, not here - plain .sql migrations run via
-- unparameterized db.exec(), so there's no way to reference config.tenantId
-- from inside this file.
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,             -- Azure AD tenant GUID
  display_name TEXT,
  first_login_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

ALTER TABLE users ADD COLUMN tenant_id TEXT;
ALTER TABLE mappings ADD COLUMN tenant_id TEXT;
ALTER TABLE jobs ADD COLUMN tenant_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mappings_tenant ON mappings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_id);
