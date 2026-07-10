const express = require('express');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();

// Both routes require a signed-in session. They used to be open so the
// pre-login landing page could list projects, but project names are client
// names - an information leak to anyone who can reach the port - and since
// sign-in now auto-resolves (or auto-creates) the account's own tenant
// project, nothing pre-login needs this list anymore. Switching projects is
// done signed-in, from the /projects page.
router.use(requireAuth);

router.get('/projects', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT p.id, p.name, p.status, p.created_at, p.activated_at, t.last_login_at
     FROM projects p LEFT JOIN tenants t ON t.id = p.tenant_id
     ORDER BY COALESCE(t.last_login_at, p.created_at) DESC`
  ).all();
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      createdAt: r.created_at,
      activatedAt: r.activated_at,
      lastLoginAt: r.last_login_at,
    })),
  });
});

router.post('/projects', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const db = getDb();
  const id = uuid();
  db.prepare(`INSERT INTO projects (id, name, status) VALUES (?, ?, 'pending')`).run(id, name);
  res.status(201).json({ id, name, status: 'pending' });
});

module.exports = router;
