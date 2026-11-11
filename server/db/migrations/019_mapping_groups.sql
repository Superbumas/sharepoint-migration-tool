-- A free-text group for mappings, shown in the app as the mapping's
-- "project": one client engagement is often several separate pieces of work
-- (a Teams consolidation, a file-share move, an archive), each made of dozens
-- of mappings. NULL = not in a group. Named group_name because "project" in
-- this schema already means the client tenant a session is signed in to.
ALTER TABLE mappings ADD COLUMN group_name TEXT;
CREATE INDEX IF NOT EXISTS idx_mappings_group ON mappings(tenant_id, group_name);
