import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test } from 'vitest'

import { base58Encode } from '../cover/ember-auth.ts'
import { EmberCoverProvider } from './cover-service.ts'

const ADDR = 'So11111111111111111111111111111111111111112'
const OTHER_ADDR = base58Encode(new Uint8Array(32).fill(2))
const signer = {
  getAddress: async () => ADDR,
  sign: async (_m: Uint8Array) => new Uint8Array(64).fill(1),
}

beforeEach(() => {
  fakeBrowser.reset()
})

test('enroll then preSign sends the vault address with a session-authorization header', async () => {
  let presignHeaders: Headers | undefined
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/wallets/register/nonce')) {
      return new Response('{"nonce":"abc"}', { status: 200 })
    }
    if (u.endsWith('/wallets/register')) {
      return new Response('{"registered":true}', { status: 200 })
    }
    if (u.endsWith('/cover/pre-sign')) {
      presignHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({
          requestId: 'r',
          coverStatus: 'covered',
          riskBand: 'low',
          reasonCodes: [],
          decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch

  const provider = new EmberCoverProvider(signer, { fetch: fetchStub })
  expect(await provider.enroll()).toBe(true)
  const decision = await provider.preSign({ transactionBytes: 'AA==', dappUrl: 'https://x' })
  expect(decision.coverStatus).toBe('covered')
  expect(presignHeaders?.get('x-ember-session')).toBeTruthy()
})

test('status uses the enrolled wallet session and returns the cap snapshot', async () => {
  let statusHeaders: Headers | undefined
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/wallets/register/nonce')) {
      return new Response('{"nonce":"abc"}', { status: 200 })
    }
    if (u.endsWith('/wallets/register')) {
      return new Response('{"registered":true}', { status: 200 })
    }
    if (u.endsWith('/cover/status')) {
      statusHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({
          subscriptionActive: true,
          walletRegistered: true,
          tier: 'demo',
          month: '2026-06',
          coveredTxPerMonth: 100,
          usedCoveredTxThisMonth: 1,
          remainingCoveredTxThisMonth: 99,
          monthlyLossCapUsd: 10000,
          usedLossCapUsd: 0,
          remainingLossCapUsd: 10000,
        }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch

  const provider = new EmberCoverProvider(signer, { fetch: fetchStub })
  expect(await provider.enroll()).toBe(true)
  const snapshot = await provider.status()
  expect(snapshot?.remainingCoveredTxThisMonth).toBe(99)
  expect(statusHeaders?.get('x-ember-session')).toBeTruthy()
})

test('message pre-sign uses the message cover route', async () => {
  let messageHeaders: Headers | undefined
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/wallets/register/nonce')) {
      return new Response('{"nonce":"abc"}', { status: 200 })
    }
    if (u.endsWith('/wallets/register')) {
      return new Response('{"registered":true}', { status: 200 })
    }
    if (u.endsWith('/cover/message/pre-sign')) {
      messageHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({
          requestId: 'msg-r',
          coverStatus: 'unsupported',
          riskBand: 'high',
          reasonCodes: ['unknown_message_schema'],
          decisionExpiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch

  const provider = new EmberCoverProvider(signer, { fetch: fetchStub })
  expect(await provider.enroll()).toBe(true)
  const decision = await provider.preSignMessage({
    messageBytes: 'AQID',
    walletMethod: 'signMessage',
    messageKind: 'wallet_standard_sign_message',
    dappUrl: 'https://x',
  })
  expect(decision.coverStatus).toBe('unsupported')
  expect(messageHeaders?.get('x-ember-session')).toBeTruthy()
})

test('fails open to unavailable when the proxy errors', async () => {
  const fetchStub = (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/wallets/register/nonce')) {
      return new Response('{"nonce":"abc"}', { status: 200 })
    }
    if (u.endsWith('/wallets/register')) {
      return new Response('{"registered":true}', { status: 200 })
    }
    throw new Error('network')
  }) as unknown as typeof fetch
  const provider = new EmberCoverProvider(signer, { fetch: fetchStub })
  expect(await provider.enroll()).toBe(true)
  expect((await provider.preSign({ transactionBytes: 'AA==', dappUrl: 'https://x' })).coverStatus).toBe('unavailable')
})

test('not enrolled preSign returns not_covered without calling the proxy', async () => {
  let called = false
  const fetchStub = (async () => {
    called = true
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  const provider = new EmberCoverProvider(signer, { fetch: fetchStub })
  expect((await provider.preSign({ transactionBytes: 'AA==', dappUrl: 'https://x' })).coverStatus).toBe('not_covered')
  expect(called).toBe(false)
})

test('reports enrolled after enroll', async () => {
  const fetchStub = (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/wallets/register/nonce')) {
      return new Response('{"nonce":"abc"}', { status: 200 })
    }
    return new Response('{"registered":true}', { status: 200 })
  }) as unknown as typeof fetch
  const provider = new EmberCoverProvider(signer, { fetch: fetchStub })
  expect(await provider.isEnrolled()).toBe(false)
  await provider.enroll()
  expect(await provider.isEnrolled()).toBe(true)
})

test('rolls back enrollment when registration fails', async () => {
  const fetchStub = (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/wallets/register/nonce')) {
      return new Response('{"nonce":"abc"}', { status: 200 })
    }
    if (u.endsWith('/wallets/register')) {
      return new Response('{"error":"nope"}', { status: 400 }) // registration fails
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  const provider = new EmberCoverProvider(signer, { fetch: fetchStub })
  expect(await provider.enroll()).toBe(false)
  expect(await provider.isEnrolled()).toBe(false) // rolled back — not stuck "enabled"
})

test('ignores stale enrollment for a different wallet address', async () => {
  const fetchStub = (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/wallets/register/nonce')) {
      return new Response('{"nonce":"abc"}', { status: 200 })
    }
    if (u.endsWith('/wallets/register')) {
      return new Response('{"registered":true}', { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  const provider = new EmberCoverProvider(signer, { fetch: fetchStub })
  expect(await provider.enroll()).toBe(true)

  const otherProvider = new EmberCoverProvider(
    {
      getAddress: async () => OTHER_ADDR,
      sign: async (_m: Uint8Array) => new Uint8Array(64).fill(2),
    },
    { fetch: fetchStub },
  )
  expect(await otherProvider.isEnrolled()).toBe(false)
  expect((await otherProvider.preSign({ transactionBytes: 'AA==' })).coverStatus).toBe('not_covered')
})
