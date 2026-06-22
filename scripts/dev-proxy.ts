import { startCoverProxy } from '../e2e/fixtures/cover-proxy-server.ts'

// Starts ONLY the cover proxy on 8787 (the real proxy: partner key server-side,
// forwarding to the live devnet engine). Use this when a dapp is already serving
// on 5173, so it does not collide like the full `dev:test` launcher does.
const PROXY_PORT = 8787
const ENGINE = 'https://ember-v4-api-devnet.fly.dev'

await startCoverProxy(PROXY_PORT)
console.log(`✓ cover proxy   http://127.0.0.1:${PROXY_PORT}   ->  ${ENGINE} (live devnet engine)`)

// Keep the scale-to-zero devnet engine warm so the first call isn't a cold start.
async function warm(): Promise<void> {
  await fetch(`${ENGINE}/v1/cover/pre-sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-partner-key' },
    body: '{}',
  }).catch(() => {})
}
void warm()
setInterval(() => void warm(), 45_000)
console.log('✓ keeping the devnet engine warm (ping every 45s). Ctrl-C to stop.')
