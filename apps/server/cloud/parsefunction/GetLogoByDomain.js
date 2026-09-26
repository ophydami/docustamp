import { appName } from '../../Utils.js';
import { stringParam } from './authGuard.js';
import { brandingFromTenant } from './tenantBranding.js';

/**
 * Shape the unauthenticated branding answer. `appname` is the tenant's own name
 * when it has one, so a workspace that renamed itself is branded on the sign-in
 * and guest-signing screens too; otherwise the server-wide constant.
 * @param {Object|null} tenant a `partners_Tenant` object, or null.
 * @param {string} user "exist" | "not_exist".
 * @returns {Object} the branding payload.
 */
function payload(tenant, user) {
  const branding = brandingFromTenant(tenant);
  const json = tenant ? JSON.parse(JSON.stringify(tenant)) : {};
  return {
    logo: branding.logo || '',
    favicon: json?.Favicon || branding.logo || '',
    appname: branding.tenantName || appName,
    tenantName: branding.tenantName || '',
    hidePoweredBy: branding.hidePoweredBy,
    footer: branding.footer,
    user,
  };
}

// `GetLogoByDomain` is used to get logo by domain as well as check any tenant exist or not in db
export default async function GetLogoByDomain(request) {
  // Cloud-function params arrive as parsed JSON, so an object here would reach
  // `equalTo` as a real Mongo operator (`{"$ne": ""}` matches any tenant).
  const domain = stringParam(request.params?.domain, 'domain');
  try {
    if (domain) {
      const tenantCreditsQuery = new Parse.Query('partners_Tenant');
      tenantCreditsQuery.equalTo('Domain', domain);
      const res = await tenantCreditsQuery.first({ useMasterKey: true });
      if (res) {
        return payload(res, 'exist');
      }
    }
    // No `Domain` match. On a single-tenant server that one workspace is
    // unambiguously the brand for every host, so answer with it; with more than
    // one tenant the host is the only way to tell them apart, so answer blank.
    const anyTenantQuery = new Parse.Query('partners_Tenant');
    anyTenantQuery.limit(2);
    const tenants = await anyTenantQuery.find({ useMasterKey: true });
    if (tenants.length === 1) return payload(tenants[0], 'exist');
    if (tenants.length > 1) return payload(null, 'exist');
    return payload(null, 'not_exist');
  } catch (err) {
    const code = err.code || 400;
    const msg = err.message || 'Something went wrong.';
    throw new Parse.Error(code, msg);
  }
}
