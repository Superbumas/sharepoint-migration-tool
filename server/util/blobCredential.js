const { getDb } = require('../db');
const config = require('../config');
const { decrypt } = require('./secretCrypto');

// A Project's own Azure Blob connection string (set via the Settings page),
// falling back to the global AZURE_BLOB_CONNECTION_STRING env var if the
// project hasn't configured its own - keeps existing .env-based setups
// working unchanged while letting each project have its own storage
// account. Returns null (not an error) if neither is set - Azure Blob
// archiving is optional per project, unlike the engine app credential.
function resolveBlobConnectionString(tenantId) {
  if (tenantId) {
    const project = getDb().prepare('SELECT blob_connection_string_encrypted FROM projects WHERE tenant_id = ?').get(tenantId);
    if (project?.blob_connection_string_encrypted && config.credentialEncryptionKey) {
      try {
        return decrypt(project.blob_connection_string_encrypted, config.credentialEncryptionKey);
      } catch {
        // CREDENTIAL_ENCRYPTION_KEY changed since this value was stored -
        // treat as not configured (blob archiving shows as off, Settings page
        // lets the user just re-save the string) instead of 500ing every
        // /api/settings call.
        console.error('[blob] Stored blob connection string cannot be decrypted (CREDENTIAL_ENCRYPTION_KEY changed?) - re-save it in Settings.');
        return config.azureBlobConnectionString || null;
      }
    }
  }
  return config.azureBlobConnectionString || null;
}

module.exports = { resolveBlobConnectionString };
