/**
 * Legacy re-export shim.
 * New code should import from './auth-internal.server.js' directly.
 */

export { fetchAuthOrgs as fetchKfOrgs, type AuthOrg as KFOrg } from './auth-internal.server.js'
