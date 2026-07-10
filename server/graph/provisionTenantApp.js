const axios = require('axios');
const crypto = require('node:crypto');
const forge = require('node-forge');

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const MICROSOFT_GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
// "Office 365 SharePoint Online" - SharePoint's own resource application,
// distinct from Microsoft Graph. Sites.Selected exists on BOTH resources and
// they are separate permissions: Graph's covers Graph API calls only, while
// SharePoint REST/CSOM (everything PnP.PowerShell's engine does) checks
// SharePoint's own. An app holding only Graph's Sites.Selected gets 401
// Unauthorized from CSOM/REST even with a valid cert and a fullcontrol
// site grant - Graph reads succeed, engine reads fail.
const SHAREPOINT_ONLINE_APP_ID = '00000003-0000-0ff1-ce00-000000000000';
const CERT_VALIDITY_YEARS = 2;

async function graphCall(accessToken, method, urlPath, body) {
  try {
    const { data } = await axios.request({
      url: `${GRAPH_ROOT}${urlPath}`,
      method,
      headers: { Authorization: `Bearer ${accessToken}` },
      data: body,
    });
    return data;
  } catch (err) {
    const graphMessage = err.response?.data?.error?.message;
    throw new Error(`Graph ${method} ${urlPath} failed: ${graphMessage || err.message}`);
  }
}

// Generates a self-signed RSA/X.509 certificate entirely in Node (node-forge
// - no OpenSSL, no local certificate store involved) and packages it two
// ways: the public certificate alone (DER, base64) to upload as the app's
// keyCredential, and a password-protected PKCS#12/PFX bundle (private key +
// cert, base64) for the engine's Connect-PnPOnline -CertificateBase64Encoded
// path. Verified this PFX format loads correctly via .NET's
// X509Certificate2 (what PnP.PowerShell uses internally) before relying on it.
//
// A CERTIFICATE, not a client secret, is required here - SharePoint Online
// app-only auth rejects client-secret-based tokens outright regardless of
// permissions ("all other options are blocked by SharePoint Online and
// will result in an Access Denied message" - Microsoft's own docs). This
// only affects the credential *type*; the Sites.Selected application
// permission below is unrelated and unaffected.
function generateSelfSignedCertificate(commonName) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + CERT_VALIDITY_YEARS);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  // setup/New-AppRegistration.ps1's cert (New-SelfSignedCertificate -KeySpec
  // Signature) gets these extensions from Windows automatically; a bare
  // node-forge cert doesn't unless set explicitly. SharePoint's own app-only
  // certificate validation (separate from, and stricter than, Azure AD's
  // token-issuance check) was rejecting the extensionless version with
  // Unauthorized even though Azure AD and Graph both accepted it fine.
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certDerBase64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());

  const pfxPassword = crypto.randomBytes(24).toString('base64');
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], pfxPassword, { algorithm: '3des' });
  const pfxBase64 = forge.util.encode64(forge.asn1.toDer(p12Asn1).getBytes());

  return { certDerBase64, pfxBase64, pfxPassword, expiresAt: cert.validity.notAfter };
}

// Creates a brand-new, tenant-local Azure AD app registration - dedicated to
// one Project, never shared across client tenants - using the signed-in
// Global Admin's own delegated token (must carry Application.ReadWrite.All +
// AppRoleAssignment.ReadWrite.All; see server/auth/routes.js for when those
// are requested). Grants it the same app-only Sites.Selected permission the
// engine has always needed, and returns a certificate for
// Connect-PnPOnline's -CertificateBase64Encoded auth path
// (engine/Invoke-MigrationJob.ps1).
//
// Every step uses the caller's own token, in their own tenant - Knowall IT's
// shared app and credentials are never involved in any of this.
async function provisionTenantApp(accessToken, projectName) {
  // Display name avoids product-name words (SharePoint, Microsoft, Office,
  // Azure, ...) - some client tenants' Entra ID admin-configured
  // "prohibited words" policy rejects app registration names containing
  // them (ErrorCode: ProhibitedWordInDisplayName), and this call runs
  // automatically inside whichever tenant just signed in, with no chance
  // to pick a different name per tenant the way setup/New-AppRegistration.ps1's
  // -AppDisplayName parameter allows for the shared login app.
  const displayName = `Content Migration Tool - ${projectName}`;
  const { certDerBase64, pfxBase64, pfxPassword, expiresAt } = generateSelfSignedCertificate(displayName);

  // 1. Look up Microsoft Graph's own service principal in THIS tenant
  // (well-known appId, present in every tenant) and find the Sites.Selected
  // app role's id dynamically - same pattern setup/New-AppRegistration.ps1's
  // Get-GraphPermissionId already uses, just from Node. Done BEFORE creating
  // the app so it can be declared in requiredResourceAccess at creation time
  // (see step 2) - an appRoleAssignment with no matching requiredResourceAccess
  // declaration is accepted by Graph's own permissions API but was observed
  // NOT to be honored by SharePoint's own REST/CSOM authorization layer,
  // even though the grant itself is real and visible via Graph.
  const graphSp = await graphCall(
    accessToken, 'GET',
    `/servicePrincipals(appId='${MICROSOFT_GRAPH_APP_ID}')?$select=id,appRoles`
  );
  const sitesSelectedRole = graphSp.appRoles?.find((r) => r.value === 'Sites.Selected');
  if (!sitesSelectedRole) throw new Error("Could not find the 'Sites.Selected' application permission on Microsoft Graph's service principal.");

  // 1b. Same lookup against SharePoint Online's own service principal - its
  // Sites.Selected is a different permission with a different role id, and
  // it's the one SharePoint's REST/CSOM authorization actually checks.
  const spoSp = await graphCall(
    accessToken, 'GET',
    `/servicePrincipals(appId='${SHAREPOINT_ONLINE_APP_ID}')?$select=id,appRoles`
  );
  const spoSitesSelectedRole = spoSp.appRoles?.find((r) => r.value === 'Sites.Selected');
  if (!spoSitesSelectedRole) throw new Error("Could not find the 'Sites.Selected' application permission on the Office 365 SharePoint Online service principal.");

  // 2. Create the application, declaring Sites.Selected in
  // requiredResourceAccess (the app's own manifest saying "I want this
  // permission") and attaching its public certificate as a keyCredential -
  // only the public cert ever goes to Graph; the private key (inside the
  // PFX below) never leaves this function's return value.
  const app = await graphCall(accessToken, 'POST', '/applications', {
    displayName,
    signInAudience: 'AzureADMyOrg',
    keyCredentials: [
      { type: 'AsymmetricX509Cert', usage: 'Verify', key: certDerBase64, displayName: 'migration-engine' },
    ],
    requiredResourceAccess: [
      { resourceAppId: MICROSOFT_GRAPH_APP_ID, resourceAccess: [{ id: sitesSelectedRole.id, type: 'Role' }] },
      { resourceAppId: SHAREPOINT_ONLINE_APP_ID, resourceAccess: [{ id: spoSitesSelectedRole.id, type: 'Role' }] },
    ],
  });

  // 3. A service principal is required before any permission can be granted -
  // creating the application alone does not create one.
  const sp = await graphCall(accessToken, 'POST', '/servicePrincipals', { appId: app.appId });

  // 4. Grant (and thereby consent) BOTH Sites.Selected application
  // permissions to the new app's service principal - Graph's for the site
  // picker/permission-grant plumbing, SharePoint Online's for the engine's
  // actual CSOM/REST file operations.
  await graphCall(accessToken, 'POST', `/servicePrincipals/${sp.id}/appRoleAssignedTo`, {
    principalId: sp.id,
    resourceId: graphSp.id,
    appRoleId: sitesSelectedRole.id,
  });
  await graphCall(accessToken, 'POST', `/servicePrincipals/${sp.id}/appRoleAssignedTo`, {
    principalId: sp.id,
    resourceId: spoSp.id,
    appRoleId: spoSitesSelectedRole.id,
  });

  return { clientId: app.appId, certBase64: pfxBase64, certPassword: pfxPassword, certExpiresAt: expiresAt.toISOString() };
}

module.exports = { provisionTenantApp };
