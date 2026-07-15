const express = require('express');
const { requireAuth } = require('../auth/middleware');
const { graphGet } = require('../graph/client');
const { verifyUserHasDrive } = require('../graph/onedriveAccess');

const router = express.Router();
router.use(requireAuth);

// Search the directory by name/email/UPN so the OneDrive target picker can
// find the destination person without needing their exact UPN typed out.
// Graph's $search on /users requires ConsistencyLevel: eventual.
router.get('/onedrive/users', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const escaped = q.replace(/"/g, '\\"');
    const data = await graphGet(
      req,
      '/users',
      {
        $search: `"displayName:${escaped}" OR "mail:${escaped}" OR "userPrincipalName:${escaped}"`,
        $select: 'id,displayName,mail,userPrincipalName',
        $top: 20,
      },
      { ConsistencyLevel: 'eventual' }
    );
    res.json({ items: data.value || [] });
  } catch (err) {
    next(err);
  }
});

// Confirms the target user has a provisioned OneDrive - used by the picker
// for immediate feedback, and by /api/mappings at save time.
router.get('/onedrive/verify', async (req, res, next) => {
  try {
    const upn = (req.query.upn || '').trim();
    if (!upn) return res.status(400).json({ error: 'upn is required' });
    res.json(await verifyUserHasDrive(req, upn));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
