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

// Resolves a user's OneDrive to the SharePoint site behind it, so it can be
// picked as a migration SOURCE. A OneDrive is just a personal SharePoint site
// collection (https://contoso-my.sharepoint.com/personal/jane_contoso_com)
// whose default library is the drive itself - so once the picker has that
// site, the mapping is stored as an ordinary SharePoint source and the engine,
// auto-grant, verification and cleanup paths all work on it unchanged.
//
// Uses the signed-in admin's delegated token. Being a tenant admin does NOT
// give access to other people's OneDrives: the admin has to be made a site
// collection admin of that OneDrive first, so a 403 here is turned into a
// message that says how.
const ONEDRIVE_ACCESS_HINT = 'You don\'t have access to this person\'s OneDrive yet. In the Microsoft 365 admin center open Users > Active users > the person > OneDrive > "Create link to files" (this makes you a site admin of their OneDrive), then pick them again.';

async function resolveUserOneDriveSite(req, upn) {
  let drive;
  try {
    drive = await graphGet(req, `/users/${encodeURIComponent(upn)}/drive`, { $select: 'id,driveType,webUrl,name' });
  } catch (err) {
    if (err.status === 404) {
      return { ok: false, error: `No OneDrive found for "${upn}" - they may not be licensed for it or have never signed in.` };
    }
    if (err.status === 403) return { ok: false, error: ONEDRIVE_ACCESS_HINT };
    throw err;
  }
  const siteUrl = deriveHostUrl(drive.webUrl);
  if (!siteUrl) return { ok: false, error: `Could not work out the OneDrive site address for "${upn}".` };
  let site;
  try {
    const u = new URL(siteUrl);
    site = await graphGet(req, `/sites/${u.host}:${u.pathname}`, { $select: 'id,webUrl,displayName,name' });
  } catch (err) {
    if (err.status === 403 || err.status === 404) return { ok: false, error: ONEDRIVE_ACCESS_HINT };
    throw err;
  }
  return {
    ok: true,
    site: { id: site.id, webUrl: site.webUrl || siteUrl, displayName: site.displayName || site.name },
    driveId: drive.id,
  };
}

module.exports = { verifyUserHasDrive, resolveUserOneDriveSite, ONEDRIVE_ACCESS_HINT };
