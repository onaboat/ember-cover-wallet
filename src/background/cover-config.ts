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
    : 'https://ember-v4-api-devnet.fly.dev'
const cluster = env.WXT_COVER_CLUSTER === 'mainnet' ? 'mainnet' : 'devnet'

export const COVER_CONFIG: EmberConfig = {
  // Prefer the deployed Worker proxy in configured builds. The extension calls /cover/* and
  // /wallets/*; the proxy verifies wallet/session auth and injects the partner API key before
  // forwarding to /v1. The fallback direct dev API supports old bare tx/register routes only.
  proxyBaseUrl,
  cluster,
  // Pre-sign fires in parallel with the approval window opening (it never blocks signing), and the
  // engine does on-chain account/mint lookups for a real tx — so give it room. The banner polls ~5s.
  preSignTimeoutMs: 4000,
}
