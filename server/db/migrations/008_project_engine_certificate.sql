-- SharePoint Online app-only auth rejects client-secret-based tokens
-- outright, regardless of permissions ("all other options are blocked by
-- SharePoint Online" - Microsoft's own docs) - so a Project's
-- auto-provisioned engine app needs a CERTIFICATE, not the client secret
-- 006_project_engine_credentials.sql originally added columns for. Those
-- old engine_client_secret_* columns are left in place (harmless, unused
-- going forward) rather than dropped - SQLite ALTER TABLE DROP COLUMN has
-- enough version-dependent gotchas that it's not worth the risk for an
-- unused nullable column.
ALTER TABLE projects ADD COLUMN engine_cert_base64_encrypted TEXT;
ALTER TABLE projects ADD COLUMN engine_cert_password_encrypted TEXT;
ALTER TABLE projects ADD COLUMN engine_cert_expires_at TEXT;
