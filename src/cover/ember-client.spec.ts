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
        capContext: { monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 },
        coveredTxCountImpact: 1,
      }),
      { status: 200 },
    )) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: ok })
  const d = await client.preSign(req)
  expect(d.coverStatus).toBe('covered')
  expect(d.capContext).toEqual({ monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 })
  expect(d.coveredTxCountImpact).toBe(1)
})

test('status posts to the non-consuming status route and normalizes the snapshot', async () => {
  let requestedUrl = ''
  const ok = (async (url: string | URL | Request) => {
    requestedUrl = String(url)
    return new Response(
      JSON.stringify({
        subscriptionActive: true,
        subscriptionStatus: 'active',
        walletRegistered: true,
        tier: 'demo',
        month: '2026-06',
        currentPeriodEnd: '2026-07-01T00:00:00Z',
        coveredTxPerMonth: 100,
        usedCoveredTxThisMonth: 1,
        remainingCoveredTxThisMonth: 99,
        monthlyLossCapUsd: 10000,
        usedLossCapUsd: 0,
        remainingLossCapUsd: 10000,
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: ok })
  const snapshot = await client.status({ walletPublicKey: 'W', userRef: 'user-1' })
  expect(requestedUrl).toBe('https://proxy.test/cover/status')
  expect(snapshot?.remainingCoveredTxThisMonth).toBe(99)
})

test('status returns null for a missing or old route', async () => {
  const missing = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: missing })
  await expect(client.status({ walletPublicKey: 'W', userRef: 'user-1' })).resolves.toBeNull()
})

test('message pre-sign posts the exact message route', async () => {
  let requestedUrl = ''
  const ok = (async (url: string | URL | Request) => {
    requestedUrl = String(url)
    return new Response(
      JSON.stringify({
        requestId: 'msg_1',
        coverStatus: 'unsupported',
        riskBand: 'high',
        reasonCodes: ['unknown_message_schema'],
        decisionExpiresAt: '2026-06-16T00:01:00Z',
        capContext: { monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 },
        coveredTxCountImpact: 1,
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: ok })
  const decision = await client.messagePreSign({
    walletPublicKey: 'W',
    userRef: 'user-1',
    walletMethod: 'signMessage',
    messageKind: 'wallet_standard_sign_message',
    messageBytes: 'AQID',
    dappUrl: 'https://app.example',
  })
  expect(requestedUrl).toBe('https://proxy.test/cover/message/pre-sign')
  expect(decision.coverStatus).toBe('unsupported')
  expect(decision.capContext).toEqual({ monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 })
})

test('message post-sign never throws when the route is unavailable', async () => {
  const missing = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: missing })
  await expect(
    client.messagePostSign({
      requestId: 'msg_1',
      signedMessage: 'AQID',
      signature: 'sig',
      signingWalletPublicKey: 'W',
      walletTimestamp: 't',
    }),
  ).resolves.toBeUndefined()
})

test('pre-sign maps exhausted transaction count to not covered', async () => {
  const exhausted = (async () =>
    new Response(
      JSON.stringify({
        error: 'transaction_count_exhausted',
        message: 'Subscription monthly transaction limit reached.',
      }),
      { status: 403 },
    )) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: exhausted })
  const d = await client.preSign(req)
  expect(d.coverStatus).toBe('not_covered')
  expect(d.reasonCodes).toEqual(['transaction_count_exhausted'])
  expect(d.capContext).toEqual({ remainingCoveredTxThisMonth: 0 })
  expect(d.coveredTxCountImpact).toBe(0)
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

test('payment entitlement activation posts the signature to the prepaid route', async () => {
  let requestedUrl = ''
  let requestedBody: Record<string, unknown> = {}
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url)
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        walletPublicKey: 'WALLET',
        subscriptionActive: true,
        subscriptionStatus: 'active',
        tier: 'Core',
        billingPeriod: '30_days',
        currentPeriodEnd: '2026-08-24T00:00:00Z',
        coveredTxPerMonth: 100,
        monthlyLossCapUsd: 10000,
        paymentSignature: 'signature',
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  const client = new EmberClient(cfg, signMessage, { fetch: f })

  expect(
    await client.activatePaymentEntitlement({
      walletPublicKey: 'WALLET',
      cluster: 'devnet',
      paymentSignature: 'signature',
    }),
  ).toMatchObject({ subscriptionActive: true, paymentSignature: 'signature' })
  expect(requestedUrl).toBe('https://proxy.test/entitlements/payments/activate')
  expect(requestedBody['walletPublicKey']).toBe('WALLET')
  expect(requestedBody['paymentSignature']).toBe('signature')
})
