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
    // Directory search needs the User.Read.All DELEGATED scope (distinct from
    // the engine's app-only Files.ReadWrite.All). Turn Graph's bare 403 into
    // something a non-admin colleague can act on rather than a dead end.
    if (err.status === 403) {
      return res.status(403).json({
        error: 'directory_search_denied',
        message: 'This app can\'t search your directory yet - it needs the "User.Read.All" permission granted and consented. An admin can fix it from Settings → Permissions (or re-run setup with -EnableOneDriveTarget, restart, and sign in again).',
      });
    }
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
