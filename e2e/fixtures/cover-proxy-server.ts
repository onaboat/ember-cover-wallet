import { type Server, createServer } from 'node:http'

import { coverProxy } from '../../src/worker/cover-proxy.ts'

const ENV = {
  EMBER_API: 'http://ember-api.e2e.invalid',
  EMBER_PARTNER_API_KEY: 'test-partner-key',
  EMBER_USER_REF: 'user-1',
}

const upstreamFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  const walletPublicKey = String(body['walletPublicKey'] ?? '')

  if (url.pathname === '/v1/cover/status') {
    return Response.json({
      subscriptionActive: false,
      subscriptionStatus: 'inactive',
      walletRegistered: false,
      tier: 'core',
      month: '2026-07',
      currentPeriodEnd: null,
      coveredTxPerMonth: 100,
      usedCoveredTxThisMonth: 0,
      remainingCoveredTxThisMonth: 100,
      monthlyLossCapUsd: 10000,
      usedLossCapUsd: 0,
      remainingLossCapUsd: 10000,
    })
  }
  if (url.pathname.endsWith('/pre-sign')) {
    return Response.json({
      requestId: 'e2e-not-covered',
      coverStatus: 'not_covered',
      riskBand: 'low',
      reasonCodes: ['entitlement_inactive'],
      decisionExpiresAt: '2099-01-01T00:00:00.000Z',
      coveredTxCountImpact: 0,
    })
  }
  if (url.pathname.endsWith('/post-sign')) {
    return new Response(null, { status: 204 })
  }
  if (url.pathname === '/v1/wallets/register/nonce') {
    return Response.json({ nonce: 'e2e-wallet-registration' })
  }
  if (url.pathname === '/v1/wallets/register') {
    return Response.json({ registered: true, walletPublicKey })
  }
  return Response.json({ error: 'e2e_route_not_found' }, { status: 404 })
}) as typeof fetch

/** Runs the real cover proxy against a deterministic, process-local Ember API stub. */
export function startCoverProxy(port = 8787): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = []
        for await (const c of req) {
          chunks.push(c as Buffer)
        }
        const method = req.method ?? 'GET'
        const init: RequestInit = { method, headers: req.headers as Record<string, string> }
        if (method !== 'GET' && method !== 'HEAD') {
          init.body = Buffer.concat(chunks)
        }
        const path = req.url ?? '/'
        const request = new Request(`http://127.0.0.1:${port}${path}`, init)
        const response = await coverProxy(request, ENV, { fetch: upstreamFetch })
        const out = Buffer.from(await response.arrayBuffer())
        console.log(`[proxy] ${method} ${path} -> ${response.status}  ${out.toString('utf8').slice(0, 240)}`)
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        res.end(out)
      } catch (e) {
        res.writeHead(500)
        res.end(String(e))
      }
    })()
  })
  return new Promise((resolve) => {
    // Bind to loopback only. The proxy injects the partner key, so it must never be
    // reachable from the LAN; 127.0.0.1 keeps it to this machine.
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
