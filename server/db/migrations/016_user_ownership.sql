-- Per-user ownership and roles: the tool is used by a whole team signing in
-- through one identity tenant, so tenant_id alone (which isolates CLIENTS
-- from each other) no longer isolates TEAMMATES from each other. Every
-- mapping/job now records which signed-in user created it (owner_user_id =
-- users.id, the Azure AD oid), and list/read/mutate APIs scope to the owner
-- unless the user is an admin.
--
-- role: 'admin' sees and can act on everything in the tenant; 'member' sees
-- only their own rows. Pre-existing users are backfilled to 'admin' in
-- server/db/index.js (they had full visibility before this migration - least
-- surprise), and ADMIN_UPNS in .env force-promotes at every login.
--
-- owner_user_id stays NULL on pre-existing rows: NULL means "legacy/shared",
-- visible to every user in the tenant, so nothing vanishes from anyone's
-- view the moment owner-scoped queries go live.
ALTER TABLE users ADD COLUMN role TEXT;
ALTER TABLE mappings ADD COLUMN owner_user_id TEXT;
ALTER TABLE jobs ADD COLUMN owner_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mappings_owner ON mappings(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_user_id);
