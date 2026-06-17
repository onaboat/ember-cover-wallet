import { argon2id } from '@noble/hashes/argon2'

import type { Argon2Params, VaultRecord } from './vault-store.ts'

const ARGON2: Argon2Params = { m: 64 * 1024, t: 3, p: 1 } // 64 MiB, 3 passes

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

function aad(salt: string, params: Argon2Params, publicKey: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`${salt}|${params.m},${params.t},${params.p}|${publicKey}`))
}

async function deriveKey(password: string, salt: Uint8Array, params: Argon2Params): Promise<CryptoKey> {
  const raw = argon2id(new TextEncoder().encode(password), salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: 32,
  })
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptKey(secret: Uint8Array, password: string, publicKey: string): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, ARGON2)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(b64(salt), ARGON2, publicKey) },
      key,
      new Uint8Array(secret),
    ),
  )
  return { salt: b64(salt), argon2Params: ARGON2, iv: b64(iv), ciphertext: b64(ct), publicKey }
}

export async function decryptKey(rec: VaultRecord, password: string): Promise<Uint8Array> {
  const salt = unb64(rec.salt)
  const key = await deriveKey(password, salt, rec.argon2Params)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(rec.iv), additionalData: aad(rec.salt, rec.argon2Params, rec.publicKey) },
    key,
    unb64(rec.ciphertext),
  )
  return new Uint8Array(plain)
}
