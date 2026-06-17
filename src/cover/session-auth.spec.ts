import { expect, test } from 'vitest'

import { base58Encode } from './ember-auth.ts'
import { sessionAuthorizationPayload, verifySessionAuth } from './session-auth.ts'

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))

async function genKey(): Promise<{ pub: string; sign: (m: Uint8Array) => Promise<Uint8Array> }> {
  const kp = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
  const sign = async (m: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, new Uint8Array(m)))
  return { pub, sign }
}

async function build(method: string, path: string, body: string, nowMs: number) {
  const wallet = await genKey()
  const session = await genKey()
  const walletAuthSig = await wallet.sign(sessionAuthorizationPayload(session.pub, wallet.pub))
  const sessionHeader = `${session.pub}.${b64(walletAuthSig)}`
  const ts = new Date(nowMs).toISOString()
  const sessionSig = await session.sign(new TextEncoder().encode(`${method}\n${path}\n${ts}\n${body}`))
  const authHeader = `${ts}.${b64(sessionSig)}`
  return { wallet, session, sessionHeader, authHeader, ts }
}

test('accepts a valid wallet-authorized, session-signed request', async () => {
  const now = 1_700_000_000_000
  const body = '{"walletPublicKey":"W"}'
  const { wallet, sessionHeader, authHeader } = await build('POST', '/cover/pre-sign', body, now)
  expect(
    await verifySessionAuth({
      authHeader,
      sessionHeader,
      method: 'POST',
      path: '/cover/pre-sign',
      body,
      walletPublicKey: wallet.pub,
      nowMs: now,
    }),
  ).toBe(true)
})

test('rejects when the wallet did not authorize the session key', async () => {
  const now = 1_700_000_000_000
  const body = '{}'
  const { sessionHeader, authHeader } = await build('POST', '/cover/pre-sign', body, now)
  const otherWallet = await (async () => {
    const kp = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    return base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))
  })()
  expect(
    await verifySessionAuth({
      authHeader,
      sessionHeader,
      method: 'POST',
      path: '/cover/pre-sign',
      body,
      walletPublicKey: otherWallet, // not the wallet that signed the authorization
      nowMs: now,
    }),
  ).toBe(false)
})

test('rejects a stale request', async () => {
  const now = 1_700_000_000_000
  const body = '{}'
  const { wallet, sessionHeader, authHeader } = await build('POST', '/cover/pre-sign', body, now)
  expect(
    await verifySessionAuth({
      authHeader,
      sessionHeader,
      method: 'POST',
      path: '/cover/pre-sign',
      body,
      walletPublicKey: wallet.pub,
      nowMs: now + 5 * 60_000, // 5 min later, past skew
    }),
  ).toBe(false)
})
