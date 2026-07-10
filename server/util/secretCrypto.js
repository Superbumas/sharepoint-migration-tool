const crypto = require('node:crypto');

// AES-256-GCM, keyed by CREDENTIAL_ENCRYPTION_KEY (a 32-byte base64 value,
// generated once and kept in .env alongside SESSION_SECRET/CLIENT_SECRET).
// Needed because a per-project client secret (see
// server/graph/provisionTenantApp.js) now lives in data/migration.db - a
// file that could get copied/backed up more casually than the gitignored
// .env every other secret in this app lives in - so it's encrypted at rest
// rather than stored as plain text.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(rawKey) {
  const key = Buffer.from(rawKey, 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte value (e.g. `openssl rand -base64 32`).');
  }
  return key;
}

function encrypt(plaintext, rawKey) {
  const key = getKey(rawKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(blob, rawKey) {
  const key = getKey(rawKey);
  const [ivB64, authTagB64, ciphertextB64] = blob.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
