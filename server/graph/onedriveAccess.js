const { graphGet } = require('./client');

// Confirms the given user actually has a provisioned OneDrive before a
// mapping can target it - a user who has never signed into Office/OneDrive,
// or one licensed without SharePoint/OneDrive, returns 404 here rather than
// failing hours into a job run. Uses the signed-in admin's own delegated
// token (same as the SharePoint browser), not the engine's app-only
// Files.ReadWrite.All credential - this is a save-time sanity check, not
// the migration itself.
//
// Also derives hostUrl (e.g. https://contoso-my.sharepoint.com) from the
// drive's webUrl - a real, connectable SharePoint URL the engine can hand to
// PnP.PowerShell's Connect-PnPOnline for a filesystem-source job, which has
// no SharePoint site of its own to connect to otherwise (see
// 015_onedrive_target.sql for why the engine needs this at all). "personal"
// is a fixed, unlocalized URL segment in every tenant regardless of the
// default document library's translated name, so trimming the path there is
// reliable even in non-English tenants.
function deriveHostUrl(webUrl) {
  if (!webUrl) return null;
  try {
    const u = new URL(webUrl);
    const personalIdx = u.pathname.toLowerCase().indexOf('/personal/');
    if (personalIdx === -1) return `${u.protocol}//${u.host}`;
    const alias = u.pathname.slice(personalIdx + '/personal/'.length).split('/')[0];
    return `${u.protocol}//${u.host}/personal/${alias}`;
  } catch {
    return null;
  }
}

async function verifyUserHasDrive(req, upn) {
  try {
    const drive = await graphGet(req, `/users/${encodeURIComponent(upn)}/drive`, { $select: 'id,driveType,webUrl' });
    return { ok: true, driveId: drive.id, driveType: drive.driveType, hostUrl: deriveHostUrl(drive.webUrl) };
  } catch (err) {
    if (err.status === 404) {
      return { ok: false, error: `No OneDrive found for "${upn}" - they may not be licensed for it or have never signed in.` };
    }
    throw err;
  }
}

module.exports = { verifyUserHasDrive };
