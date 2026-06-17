import { expect, test } from 'vitest'

import { authPayload, base58Decode, base58Encode, verifyAuthHeader } from './ember-auth.ts'

async function newKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
}
async function addressOf(kp: CryptoKeyPair): Promise<string> {
  return base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
}
async function header(kp: CryptoKeyPair, method: string, path: string, ts: string, body: string): Promise<string> {
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', kp.privateKey, new Uint8Array(authPayload(method, path, ts, body))),
  )
  return `${ts}.${btoa(String.fromCharCode(...sig))}`
}

test('base58 round-trips', () => {
  const bytes = new Uint8Array([0, 0, 1, 2, 253, 254, 255])
  expect(Array.from(base58Decode(base58Encode(bytes)))).toEqual(Array.from(bytes))
})

test('a wallet-signed, fresh request verifies', async () => {
  const kp = await newKey()
  const ts = new Date().toISOString()
  const h = await header(kp, 'POST', '/cover/pre-sign', ts, '{"x":1}')
  const ok = await verifyAuthHeader({
    header: h,
    method: 'POST',
    path: '/cover/pre-sign',
    body: '{"x":1}',
    walletPublicKey: await addressOf(kp),
    nowMs: Date.now(),
  })
  expect(ok).toBe(true)
})

test('a stale timestamp is rejected', async () => {
  const kp = await newKey()
  const ts = new Date(Date.now() - 5 * 60_000).toISOString()
  const h = await header(kp, 'POST', '/cover/pre-sign', ts, '{}')
  const ok = await verifyAuthHeader({
    header: h,
    method: 'POST',
    path: '/cover/pre-sign',
    body: '{}',
    walletPublicKey: await addressOf(kp),
    nowMs: Date.now(),
  })
  expect(ok).toBe(false)
})

test('a signature from another key is rejected', async () => {
  const signer = await newKey()
  const other = await newKey()
  const ts = new Date().toISOString()
  const h = await header(signer, 'POST', '/p', ts, '{}')
  const ok = await verifyAuthHeader({
    header: h,
    method: 'POST',
    path: '/p',
    body: '{}',
    walletPublicKey: await addressOf(other),
    nowMs: Date.now(),
  })
  expect(ok).toBe(false)
})
