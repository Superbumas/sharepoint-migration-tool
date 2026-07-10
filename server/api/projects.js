const express = require('express');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db');

const router = express.Router();

// Deliberately NOT behind requireAuth: both of these are used from the
// unauthenticated landing page (web/src/App.jsx's Gate) - a colleague needs
// to see the project list and be able to start a new one BEFORE signing in
// to any specific client tenant. Neither route exposes anything sensitive -
// just project names/status, never mapping/job data (that's all behind
// requireAuth + tenant_id scoping elsewhere, unchanged by this file).
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
