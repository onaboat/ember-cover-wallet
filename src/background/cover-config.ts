import type { EmberConfig } from '../cover/ember-config.ts'

export const COVER_CONFIG: EmberConfig = {
  // Deployed HTTPS proxy. The extension calls /cover/* and /wallets/* here; this service
  // verifies wallet/session auth and injects the partner API key server-side before forwarding
  // to the raw /v1 engine routes.
  proxyBaseUrl: 'https://ember-v4-api-devnet.fly.dev',
  cluster: 'devnet',
  // Pre-sign fires in parallel with the approval window opening (it never blocks signing), and the
  // engine does on-chain account/mint lookups for a real tx — so give it room. The banner polls ~5s.
  preSignTimeoutMs: 4000,
}
