import { type Server, createServer } from 'node:http'

import { coverProxy } from '../../src/worker/cover-proxy.ts'

const ENV = {
  EMBER_API: 'https://ember-v4-api-devnet.fly.dev',
  EMBER_PARTNER_API_KEY: 'test-partner-key',
  EMBER_USER_REF: 'user-1',
}

/** Runs the REAL cover-proxy (partner key server-side) forwarding to the live devnet engine. */
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
        const response = await coverProxy(request, ENV)
        const out = Buffer.from(await response.arrayBuffer())
        // Debug: show each forwarded call + the engine status/body (truncated).
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
