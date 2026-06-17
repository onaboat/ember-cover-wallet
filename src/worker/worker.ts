import { coverProxy, isProxyPath } from './cover-proxy.ts'
import type { CoverProxyEnv } from './cover-proxy.ts'

/**
 * Cloudflare Worker entry for the Ember cover proxy. Deploys the SAME verified `cover-proxy.ts`
 * the local dev proxy + e2e run: it verifies the wallet's two-signature auth (x-ember-auth +
 * x-ember-session), injects the partner key + userRef SERVER-SIDE, and forwards /cover/* and
 * /wallets/* to the engine's /v1/... routes. The partner key is a Worker SECRET, never shipped to
 * the extension.
 *
 * env vars: EMBER_API, EMBER_USER_REF (in wrangler.toml [vars]);
 * env secret: EMBER_PARTNER_API_KEY (`wrangler secret put EMBER_PARTNER_API_KEY`).
 */
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, x-ember-auth, x-ember-session',
    'access-control-max-age': '600',
  }
}

export default {
  async fetch(request: Request, env: CoverProxyEnv): Promise<Response> {
    const origin = request.headers.get('origin')
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }
    const url = new URL(request.url)
    if (!isProxyPath(url.pathname)) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
      })
    }
    const response = await coverProxy(request, env)
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(corsHeaders(origin))) {
      headers.set(key, value)
    }
    return new Response(response.body, { status: response.status, headers })
  },
}
