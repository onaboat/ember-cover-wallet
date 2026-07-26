import { storage } from 'wxt/utils/storage'

import { base58Encode } from '../cover/ember-auth.ts'

const STORE_KEY = 'local:ember-session-key' as const

interface StoredSessionKey {
  /** base64 of the pkcs8 private key */
  pkcs8: string
  /** base58 public key */
  publicKey: string
}

let signingKey: CryptoKey | null = null
let publicKeyB58: string | null = null

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

async function load(): Promise<{ signingKey: CryptoKey; publicKeyB58: string }> {
  if (signingKey && publicKeyB58) {
    return { signingKey, publicKeyB58 }
  }
  let stored = await storage.getItem<StoredSessionKey>(STORE_KEY)
  if (!stored) {
    const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    stored = { pkcs8: b64(pkcs8), publicKey: base58Encode(raw) }
    await storage.setItem(STORE_KEY, stored)
    pkcs8.fill(0)
  }
  const pkcs8Bytes = unb64(stored.pkcs8)
  signingKey = await crypto.subtle.importKey('pkcs8', pkcs8Bytes, { name: 'Ed25519' }, false, ['sign'])
  pkcs8Bytes.fill(0)
  publicKeyB58 = stored.publicKey
  return { signingKey, publicKeyB58 }
}

/** base58 public key of the session key — what the cover requests send as walletPublicKey. */
export async function getSessionPublicKey(): Promise<string> {
  return (await load()).publicKeyB58
}

/** Sign a message with the session key (cover-auth only; never moves funds). */
export async function signWithSession(message: Uint8Array): Promise<Uint8Array> {
  const { signingKey: key } = await load()
  return new Uint8Array(await crypto.subtle.sign('Ed25519', key, new Uint8Array(message)))
}

/** Drop the in-memory copy when the wallet identity is replaced or reset. */
export function forgetSessionKey(): void {
  signingKey = null
  publicKeyB58 = null
}
