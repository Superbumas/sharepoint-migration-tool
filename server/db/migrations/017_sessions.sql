-- Sign-in sessions used to live in express-session's in-memory store, so
-- every server restart (an update, a reboot, nodemon reloading in dev)
-- signed everyone out and forced a fresh Microsoft sign-in. They now persist
-- here (server/auth/sessionStore.js). `data` is AES-GCM encrypted because a
-- session holds the user's MSAL token cache, refresh token included.
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
