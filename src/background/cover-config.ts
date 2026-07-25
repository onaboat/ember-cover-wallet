import type { EmberConfig } from '../cover/ember-config.ts'

declare global {
  interface ImportMeta {
    readonly env?: Record<string, string | boolean | undefined>
  }
}

const env = import.meta.env ?? {}
const proxyBaseUrl =
  typeof env.WXT_COVER_PROXY_URL === 'string' && env.WXT_COVER_PROXY_URL.trim()
    ? env.WXT_COVER_PROXY_URL.trim().replace(/\/$/, '')
    : 'https://ember-cover-proxy.onaboat.workers.dev'
const cluster = env.WXT_COVER_CLUSTER === 'mainnet' ? 'mainnet' : 'devnet'

export const COVER_CONFIG: EmberConfig = {
  // The extension calls the deployed Worker. It verifies wallet/session auth and injects the
  // partner API key before forwarding to the Railway API's /v1 routes.
  proxyBaseUrl,
  cluster,
  // Pre-sign fires in parallel with the approval window opening (it never blocks signing), and the
  // engine does on-chain account/mint lookups for a real tx — so give it room. The banner polls ~5s.
  preSignTimeoutMs: 4000,
}
