-- Adds a specific user's OneDrive as a third possible migration TARGET,
-- alongside sharepoint and azure_blob (see 003_blob_target.sql). No new
-- provider-validity column - target_provider already accepts a free-form
-- string, just gains the 'onedrive' value; validity is enforced in the API
-- layer (VALID_TARGET_PROVIDERS in server/api/mappings.js), same pattern as
-- azure_blob.
--
-- target_path remains NOT NULL. OneDrive-target rows write the same value
-- into target_path and target_onedrive_path to satisfy that legacy
-- constraint; all onedrive code reads only target_onedrive_path.
--
-- target_onedrive_host_url is a real, connectable SharePoint URL for the
-- target user's OneDrive host (e.g. https://contoso-my.sharepoint.com),
-- derived server-side from Graph's /users/{upn}/drive response at mapping-
-- save time (never user-supplied). The engine needs it only for a
-- filesystem-source job: PnP.PowerShell's Connect-PnPOnline requires SOME
-- SharePoint site URL to establish a connection (and with it, a cached
-- Graph-audience token) even though OneDrive read/write traffic itself goes
-- through Graph, never that site's own CSOM/REST surface. A SharePoint-
-- source job instead reuses its own source connection for this and never
-- needs the column.
ALTER TABLE mappings ADD COLUMN target_onedrive_upn TEXT;
ALTER TABLE mappings ADD COLUMN target_onedrive_path TEXT;
ALTER TABLE mappings ADD COLUMN target_onedrive_host_url TEXT;

ALTER TABLE jobs ADD COLUMN target_onedrive_upn TEXT;
ALTER TABLE jobs ADD COLUMN target_onedrive_path TEXT;
ALTER TABLE jobs ADD COLUMN target_onedrive_host_url TEXT;
