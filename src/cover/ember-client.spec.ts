import { expect, test } from 'vitest'

import { EmberClient } from './ember-client.ts'
import type { EmberConfig } from './ember-config.ts'

const cfg: EmberConfig = { proxyBaseUrl: 'https://proxy.test', cluster: 'devnet', preSignTimeoutMs: 50 }
const signMessage = async () => new Uint8Array(64)
const req = { walletPublicKey: 'W', userRef: 'user-1', transactionBytes: 'AA==', dappUrl: 'app.example' }

test('pre-sign fails open to cover_unavailable when the proxy is too slow', async () => {
  const slow = (() => new Promise(() => {})) as unknown as typeof fetch // never resolves -> loses the timeout race
  const client = new EmberClient(cfg, signMessage, { fetch: slow })
  const d = await client.preSign(req)
  expect(d.coverStatus).toBe('unavailable')
})

test('pre-sign returns the decision on success', async () => {
  const ok = (async () =>
    new Response(
      JSON.stringify({
        requestId: 'req_1',
        coverStatus: 'covered',
        riskBand: 'medium',
        reasonCodes: [],
        decisionExpiresAt: '2026-06-16T00:01:00Z',
      }),
      { status: 200 },
    )) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: ok })
  const d = await client.preSign(req)
  expect(d.coverStatus).toBe('covered')
})

test('post-sign never throws even when every attempt fails', async () => {
  const failing = (async () => {
    throw new Error('network down')
  }) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: failing })
  await expect(
    client.postSign({ requestId: 'req_1', signedBytes: 'AA==', signingWalletPublicKey: 'W', walletTimestamp: 't' }),
  ).resolves.toBeUndefined()
})

test('register signs the nonce then posts to register', async () => {
  const f = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/wallets/register/nonce')) {
      return new Response(JSON.stringify({ nonce: 'abc' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: f })
  expect(await client.register('WALLET')).toBe(true)
})
