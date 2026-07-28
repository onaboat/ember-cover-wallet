import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { startEmberApiFixture } from '../e2e/fixtures/ember-api-server.ts'

const DAPP_PORT = 5173
const API_PORT = 18787

await startEmberApiFixture(API_PORT)
console.log(`✓ direct SDK API http://127.0.0.1:${API_PORT}`)

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
