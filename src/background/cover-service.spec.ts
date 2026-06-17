import { fakeBrowser } from 'wxt/testing'
import { beforeEach, expect, test } from 'vitest'

import { EmberCoverProvider } from './cover-service.ts'

const ADDR = 'So11111111111111111111111111111111111111112'
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

test('fails open to unavailable when the proxy errors', async () => {
  const fetchStub = (async () => {
    throw new Error('network')
  }) as unknown as typeof fetch
  const provider = new EmberCoverProvider(signer, { fetch: fetchStub })
  expect((await provider.preSign({ transactionBytes: 'AA==', dappUrl: 'https://x' })).coverStatus).toBe('unavailable')
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
