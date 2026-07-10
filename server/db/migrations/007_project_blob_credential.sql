-- Each Project can hold its own Azure Blob Storage connection string
-- (Settings page), instead of every project sharing the single global
-- AZURE_BLOB_CONNECTION_STRING env var. Same encryption-at-rest approach as
-- engine_client_secret_encrypted (006_project_engine_credentials.sql).
-- NULL means "not configured for this project" - falls back to the global
-- env var if that's set (see server/util/blobCredential.js), so existing
-- .env-based setups keep working unchanged.
ALTER TABLE projects ADD COLUMN blob_connection_string_encrypted TEXT;
