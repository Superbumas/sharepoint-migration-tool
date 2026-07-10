-- Data fix: fresh installs whose .env still carried the literal TENANT_NAME
-- placeholder got their auto-created default project NAMED
-- "yourtenant.sharepoint.com", which then showed in the UI header next to
-- the real tenant ("yourtenant.sharepoint.com · contoso.onmicrosoft.com").
-- Rename exact placeholder matches to the tenant's real display name when
-- known, else "Default project". Deliberately touches nothing an operator
-- named themselves.
UPDATE projects
SET name = COALESCE(
  (SELECT t.display_name FROM tenants t WHERE t.id = projects.tenant_id AND t.display_name IS NOT NULL AND t.display_name != ''),
  'Default project'
)
WHERE name = 'yourtenant.sharepoint.com';
