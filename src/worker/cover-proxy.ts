import { verifySessionAuth } from '../cover/session-auth.ts'

const PROXY_PREFIXES = ['/cover/', '/wallets/', '/entitlements/']

/** Paths the Ember cover proxy handles (everything else falls through to the Effect API). */
export function isProxyPath(pathname: string): boolean {
  return PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

export interface CoverProxyEnv {
  /** Base URL of the Ember API, e.g. https://ember-production-de2c.up.railway.app */
  EMBER_API: string
  /** Partner API key — a Worker SECRET, never in client code. */
  EMBER_PARTNER_API_KEY: string
  /** Demo entitlement reference (V1; per-user comes with session auth). */
  EMBER_USER_REF: string
}

export interface CoverProxyDeps {
  fetch?: typeof fetch
  now?: () => number
}

/**
 * Verifies the request was signed by the wallet key, then forwards it to the
 * Ember API with the partner key injected server-side. The key never reaches the
 * extension, and the proxy can only be driven for a pubkey the caller controls.
 */
export async function coverProxy(request: Request, env: CoverProxyEnv, deps: CoverProxyDeps = {}): Promise<Response> {
  const fetchFn = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const url = new URL(request.url)
  const body = await request.text()

  let parsed: Record<string, unknown>
  try {
    parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
  } catch {
    return jsonResponse({ error: 'invalid_request' }, 400)
  }

  const walletPublicKey = String(parsed['walletPublicKey'] ?? parsed['walletAddress'] ?? parsed['signingWalletPublicKey'] ?? '')
  const verified =
    walletPublicKey.length > 0 &&
    (await verifySessionAuth({
      authHeader: request.headers.get('x-ember-auth') ?? '',
      sessionHeader: request.headers.get('x-ember-session') ?? '',
      method: request.method,
      path: url.pathname,
      body,
      walletPublicKey,
      nowMs: now(),
    }))
  if (!verified) {
    return jsonResponse({ error: 'invalid_signature' }, 401)
  }

  // The subscriber identity is the VERIFIED wallet pubkey (wallet-native: the
  // engine keys registration/status/entitlement by wallet. We forward it as the
  // canonical `walletPublicKey` and as `userRef`. Client-supplied values
  // are overridden so they can't be spoofed. Partner key is injected server-side.
  const forwardBody = JSON.stringify({ ...parsed, walletPublicKey, userRef: walletPublicKey })
  const upstream = await fetchFn(`${env.EMBER_API}/v1${url.pathname}`, {
    method: request.method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.EMBER_PARTNER_API_KEY}`,
    },
    body: forwardBody,
  })
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}
