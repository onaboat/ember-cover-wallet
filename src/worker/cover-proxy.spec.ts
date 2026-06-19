import { base58Encode } from '../cover/ember-auth.ts'
import { sessionAuthorizationPayload } from '../cover/session-auth.ts'
import { expect, test } from 'vitest'

import { type CoverProxyEnv, coverProxy, isProxyPath } from './cover-proxy.ts'

const env: CoverProxyEnv = {
  EMBER_API: 'https://api.test',
  EMBER_PARTNER_API_KEY: 'secret-key',
  EMBER_USER_REF: 'user-1',
}

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))

async function genKey(): Promise<{ pub: string; sign: (m: Uint8Array) => Promise<Uint8Array> }> {
  const kp = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
  const sign = async (m: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, new Uint8Array(m)))
  return { pub, sign }
}

async function signedRequest(path: string, bodyObj: Record<string, unknown>): Promise<Request> {
  const wallet = await genKey()
  const session = await genKey()
  const body = JSON.stringify({ ...bodyObj, walletPublicKey: wallet.pub })
  const walletAuthSig = await wallet.sign(sessionAuthorizationPayload(session.pub, wallet.pub))
  const sessionHeader = `${session.pub}.${b64(walletAuthSig)}`
  const ts = new Date().toISOString()
  const sessionSig = await session.sign(new TextEncoder().encode(`POST\n${path}\n${ts}\n${body}`))
  const authHeader = `${ts}.${b64(sessionSig)}`
  return new Request(`https://proxy.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ember-auth': authHeader,
      'x-ember-session': sessionHeader,
    },
    body,
  })
}

interface Forward {
  status: number
  url: string
  auth: string | null
  forwarded: Record<string, unknown>
}

async function forwardOf(path: string, bodyObj: Record<string, unknown>): Promise<Forward> {
  const request = await signedRequest(path, bodyObj)
  let captured: Omit<Forward, 'status'> = { url: '', auth: null, forwarded: {} }
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(url),
      auth: new Headers(init?.headers).get('authorization'),
      forwarded: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }
    return new Response('{"coverStatus":"covered"}', { status: 200 })
  }) as unknown as typeof fetch
  const res = await coverProxy(request, env, { fetch: fetchStub })
  return { status: res.status, ...captured }
}

test('recognizes proxy paths', () => {
  expect(isProxyPath('/cover/pre-sign')).toBe(true)
  expect(isProxyPath('/cover/status')).toBe(true)
  expect(isProxyPath('/cover/message/pre-sign')).toBe(true)
})

test('leaves non-proxy paths alone', () => {
  expect(isProxyPath('/domain/x')).toBe(false)
})

test('forwards to the upstream Ember API path', async () => {
  expect((await forwardOf('/cover/pre-sign', { transactionBytes: 'AA==' })).url).toBe('https://api.test/v1/cover/pre-sign')
})

test('forwards status and message paths to the upstream v1 API', async () => {
  expect((await forwardOf('/cover/status', {})).url).toBe('https://api.test/v1/cover/status')
  expect((await forwardOf('/cover/message/pre-sign', { messageBytes: 'AA==' })).url).toBe(
    'https://api.test/v1/cover/message/pre-sign',
  )
  expect((await forwardOf('/cover/message/post-sign', { signingWalletPublicKey: 'ignored' })).url).toBe(
    'https://api.test/v1/cover/message/post-sign',
  )
})

test('injects the partner key as a Bearer header (never in the client)', async () => {
  expect((await forwardOf('/cover/pre-sign', {})).auth).toBe('Bearer secret-key')
})

test('overrides userRef with the configured demo value', async () => {
  expect((await forwardOf('/cover/pre-sign', { userRef: 'spoofed' })).forwarded['userRef']).toBe('user-1')
})

test('rejects a request with no signature (401)', async () => {
  const request = new Request('https://proxy.test/cover/pre-sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletPublicKey: 'So11111111111111111111111111111111111111112' }),
  })
  const res = await coverProxy(request, env, { fetch: (async () => new Response('{}')) as unknown as typeof fetch })
  expect(res.status).toBe(401)
})
