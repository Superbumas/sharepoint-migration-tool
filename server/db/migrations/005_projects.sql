-- A Project is an explicitly-created wrapper around one client tenant - "New
-- Project" happens BEFORE sign-in (you name it first), and its tenant_id
-- starts empty and gets bound the moment someone actually signs in through
-- it (see server/auth/routes.js). This is purely a naming/management layer:
-- all the actual data isolation (mappings/jobs/users scoped by tenant_id)
-- already exists from 004_tenants.sql and is untouched here - a project's
-- data is reached by joining on tenant_id, not a new project_id column.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tenant_id TEXT,               -- NULL until the first successful sign-in binds it
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  created_by_name TEXT,
  created_by_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenant_id);
