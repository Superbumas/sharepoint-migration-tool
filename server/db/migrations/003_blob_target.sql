-- Adds Azure Blob Storage as a second possible migration TARGET, alongside
-- the existing SharePoint target. target_provider is a NEW column, distinct
-- from target_type (which means folder-vs-file, not storage provider, and
-- is untouched here). Validity ('sharepoint'|'azure_blob') is enforced in
-- the API layer (see VALID_ACTIONS in server/api/mappings.js for the same
-- pattern), not via an inline CHECK - SQLite's support for CHECK constraints
-- added through ALTER TABLE ADD COLUMN is version-dependent.
--
-- target_path remains NOT NULL (relaxing it would require a full SQLite
-- table rebuild). Blob-target rows write the same value into target_path
-- and target_blob_prefix to satisfy that legacy constraint; all blob code
-- reads only target_blob_prefix.
ALTER TABLE mappings ADD COLUMN target_provider TEXT NOT NULL DEFAULT 'sharepoint';
ALTER TABLE mappings ADD COLUMN target_container TEXT;
ALTER TABLE mappings ADD COLUMN target_blob_prefix TEXT;

ALTER TABLE jobs ADD COLUMN target_provider TEXT NOT NULL DEFAULT 'sharepoint';
ALTER TABLE jobs ADD COLUMN target_container TEXT;
ALTER TABLE jobs ADD COLUMN target_blob_prefix TEXT;
