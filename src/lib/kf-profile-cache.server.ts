/**
 * Legacy re-export shim.
 * New code should import from './auth-internal.server.js' directly.
 */

export {
  getAuthProfile as getKfProfile,
  type AuthProfile as KFProfile,
} from './auth-internal.server.js'
