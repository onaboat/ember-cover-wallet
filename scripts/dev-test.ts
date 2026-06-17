import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { startCoverProxy } from '../e2e/fixtures/cover-proxy-server.ts'

const DAPP_PORT = 5173
const PROXY_PORT = 8787

// The REAL cover proxy (holds the partner key server-side) -> live devnet engine.
await startCoverProxy(PROXY_PORT)
console.log(`✓ cover proxy   http://127.0.0.1:${PROXY_PORT}   ->  live devnet engine`)

// Keep the scale-to-zero devnet engine WARM so the first pre-sign isn't a ~5s cold start.
async function warm(): Promise<void> {
  await fetch('https://ember-v4-api-devnet.fly.dev/v1/cover/pre-sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-partner-key' },
    body: '{}',
  }).catch(() => {})
}
void warm()
setInterval(() => void warm(), 45_000)
console.log('✓ keeping the devnet engine warm (ping every 45s)')

// Serve the test dapp over http (the content script is http/https-scoped).
const html = readFileSync(new URL('./test-dapp.html', import.meta.url), 'utf8')
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}).listen(DAPP_PORT, () => {
  console.log(`✓ test dapp     http://127.0.0.1:${DAPP_PORT}`)
  console.log('\nNext: load .output/chrome-mv3 unpacked in Chrome, then open the test dapp.')
  console.log('Ctrl-C to stop.')
})
