/**
 * Legacy re-export shim.
 * New code should import from './oidc.server.js' and './auth-internal.server.js' directly.
 */

export {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  extractOrgs,
  OIDC_ISSUER_URL,
  OIDC_CLIENT_ID,
  REDIRECT_URI,
  type OIDCOrg as KFOrg,
  type OIDCUserInfo as KFUserInfo,
  initOidc,
} from './oidc.server.js'
