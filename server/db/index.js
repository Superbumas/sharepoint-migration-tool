const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { v4: uuid } = require('uuid');
const config = require('../config');

let dbInstance = null;

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const migrationsDir = path.join(__dirname, 'migrations');
  const applied = new Set(
    db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename)
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
    });
    apply();
    console.log(`[db] applied migration ${file}`);
  }
}

// One-time backfill for rows that existed before the app went multi-tenant
// (004_tenants.sql adds tenant_id but, being a plain unparameterized .sql
// file, can't reference config.tenantId itself to backfill them). Tags
// every pre-existing users/mappings/jobs row - and seeds a tenants row -
// with the operator's own original single tenant, so nothing becomes
// invisible the instant tenant-scoped queries go live. Guarded by
// `WHERE tenant_id IS NULL` so it's a no-op on every run after the first.
function backfillLegacyTenant(db) {
  if (!config.tenantId) return; // fresh install, nothing to backfill
  const needsBackfill = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE tenant_id IS NULL) +
       (SELECT COUNT(*) FROM mappings WHERE tenant_id IS NULL) +
       (SELECT COUNT(*) FROM jobs WHERE tenant_id IS NULL) AS n`
  ).get().n;
  if (!needsBackfill) return;

  db.prepare(
    `INSERT INTO tenants (id, display_name, last_login_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(id) DO NOTHING`
  ).run(config.tenantId, config.tenantName || null);
  db.prepare(`UPDATE users SET tenant_id = ? WHERE tenant_id IS NULL`).run(config.tenantId);
  db.prepare(`UPDATE mappings SET tenant_id = ? WHERE tenant_id IS NULL`).run(config.tenantId);
  db.prepare(`UPDATE jobs SET tenant_id = ? WHERE tenant_id IS NULL`).run(config.tenantId);
  console.log(`[db] backfilled ${needsBackfill} pre-multi-tenant row(s) to tenant ${config.tenantId}`);
}

// Every pre-existing tenant needs a Project wrapper so its mappings/jobs
// show up under something in the Projects list - guarded by NOT EXISTS so
// it's a no-op after the first run and never overwrites a project someone
// has since renamed.
function backfillLegacyProject(db) {
  if (!config.tenantId) return;
  const exists = db.prepare('SELECT 1 FROM projects WHERE tenant_id = ?').get(config.tenantId);
  if (exists) return;
  db.prepare(
    `INSERT INTO projects (id, name, tenant_id, status, activated_at)
     VALUES (?, ?, ?, 'active', datetime('now'))`
  ).run(uuid(), config.tenantName || 'Default project', config.tenantId);
  console.log(`[db] created default project for pre-existing tenant ${config.tenantId}`);
}

function getDb() {
  if (dbInstance) return dbInstance;

  // Anchored to the repo root, NOT process.cwd(): under `npm run dev` the
  // workspace script runs with cwd=server/, while a bare `node server/index.js`
  // runs with cwd=repo root - cwd-relative resolution silently split the data
  // into two different database files depending on how the server was started.
  const dbPath = process.env.SQLITE_DB_PATH || './data/migration.db';
  const resolved = path.resolve(__dirname, '..', '..', dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  backfillLegacyTenant(db);
  backfillLegacyProject(db);

  dbInstance = db;
  return dbInstance;
}

module.exports = { getDb };
