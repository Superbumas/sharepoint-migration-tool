-- Each Project can get its own dedicated, tenant-local Azure AD app
-- registration (created automatically via server/graph/provisionTenantApp.js
-- using the signing-in Global Admin's own delegated rights) instead of every
-- client tenant sharing one central app registration's credentials. NULL on
-- all three columns means "not yet provisioned" - the project keeps using
-- the global config.clientId/config.engineCertThumbprint identity until
-- provisioning succeeds (see server/jobs/orchestrator.js). This is how every
-- pre-existing project (backfilled from before this feature) behaves
-- forever - nothing is retroactively provisioned for them.
ALTER TABLE projects ADD COLUMN engine_client_id TEXT;
ALTER TABLE projects ADD COLUMN engine_client_secret_encrypted TEXT;
ALTER TABLE projects ADD COLUMN engine_client_secret_expires_at TEXT;
