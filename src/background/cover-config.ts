import type { EmberConfig } from '../cover/ember-config.ts'

/**
 * DEV: points at a LOCAL cover-proxy (the src/worker/cover-proxy.ts code run on :8787) which
 * holds the partner key server-side and forwards to the live devnet Ember API. Production would
 * point at the deployed Worker URL. The proxy injects the real userRef.
 */
export const COVER_CONFIG: EmberConfig = {
  proxyBaseUrl: 'http://127.0.0.1:8787',
  cluster: 'devnet',
  // Pre-sign fires in parallel with the approval window opening (it never blocks signing), and the
  // engine does on-chain account/mint lookups for a real tx — so give it room. The banner polls ~5s.
  preSignTimeoutMs: 4000,
}
