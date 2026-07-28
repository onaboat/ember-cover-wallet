import type { EmberMessageSigner } from '@embercover/wallet-sdk'
import { storage } from 'wxt/utils/storage'

import { base58Encode } from '../crypto/base58.ts'

const STORE_KEY = 'local:ember-session-key' as const

interface StoredKeyMaterial {
  /** Base64 PKCS#8. This key authorizes Ember API requests only and can never move funds. */
  pkcs8: string
  /** Canonical base58 Ed25519 public key. */
  publicKey: string
}

interface StoredSessionKeys {
  version: 2
  current: StoredKeyMaterial
  /** Written before server rotation so a service-worker restart can finish promotion safely. */
  pending?: StoredKeyMaterial
}

const importedKeys = new Map<string, CryptoKey>()

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const unb64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value)
  const output = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index)
  }
  return output
}

function isKeyMaterial(value: unknown): value is StoredKeyMaterial {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredKeyMaterial).pkcs8 === 'string' &&
    typeof (value as StoredKeyMaterial).publicKey === 'string'
  )
}

function normalizeStore(value: unknown): StoredSessionKeys | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as StoredSessionKeys).version === 2 &&
    isKeyMaterial((value as StoredSessionKeys).current)
  ) {
    const stored = value as StoredSessionKeys
    return {
      version: 2,
      current: stored.current,
      ...(isKeyMaterial(stored.pending) ? { pending: stored.pending } : {}),
    }
  }
  // P14 migration from the legacy single session-key record.
  return isKeyMaterial(value) ? { version: 2, current: value } : null
}

async function generateMaterial(): Promise<StoredKeyMaterial> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const material = { pkcs8: b64(pkcs8), publicKey: base58Encode(raw) }
  importedKeys.set(material.publicKey, pair.privateKey)
  pkcs8.fill(0)
  raw.fill(0)
  return material
}

async function readStore(): Promise<StoredSessionKeys> {
  const raw = await storage.getItem<unknown>(STORE_KEY)
  const normalized = normalizeStore(raw)
  if (normalized) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      (raw as Partial<StoredSessionKeys>).version !== 2
    ) {
      await storage.setItem(STORE_KEY, normalized)
    }
    return normalized
  }
  const created = { version: 2, current: await generateMaterial() } satisfies StoredSessionKeys
  await storage.setItem(STORE_KEY, created)
  return created
}

async function importPrivateKey(material: StoredKeyMaterial): Promise<CryptoKey> {
  const cached = importedKeys.get(material.publicKey)
  if (cached) return cached
  const pkcs8 = unb64(material.pkcs8)
  try {
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'])
    importedKeys.set(material.publicKey, key)
    return key
  } finally {
    pkcs8.fill(0)
  }
}

function signerFor(material: StoredKeyMaterial): EmberMessageSigner {
  return {
    publicKey: material.publicKey,
    signMessage: async (message) =>
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          await importPrivateKey(material),
          new Uint8Array(message),
        ),
      ),
  }
}

/** Returns the signer matching a persisted SDK session, recovering an interrupted rotation. */
export async function getSessionSigner(expectedPublicKey?: string): Promise<EmberMessageSigner> {
  const stored = await readStore()
  if (!expectedPublicKey || stored.current.publicKey === expectedPublicKey) {
    return signerFor(stored.current)
  }
  if (stored.pending?.publicKey === expectedPublicKey) {
    const recovered = { version: 2, current: stored.pending } satisfies StoredSessionKeys
    await storage.setItem(STORE_KEY, recovered)
    importedKeys.delete(stored.current.publicKey)
    return signerFor(recovered.current)
  }
  throw new Error('The persisted Ember session does not match an available session key')
}

/** Persist a new key before requesting atomic server-side session rotation. */
export async function prepareNextSessionSigner(): Promise<EmberMessageSigner> {
  const stored = await readStore()
  const pending = await generateMaterial()
  await storage.setItem(STORE_KEY, { ...stored, pending } satisfies StoredSessionKeys)
  return signerFor(pending)
}

/** Promote only the exact key accepted by the server. */
export async function promoteSessionSigner(publicKey: string): Promise<void> {
  const stored = await readStore()
  if (!stored.pending || stored.pending.publicKey !== publicKey) {
    throw new Error('The rotated Ember session key is unavailable')
  }
  await storage.setItem(STORE_KEY, {
    version: 2,
    current: stored.pending,
  } satisfies StoredSessionKeys)
  importedKeys.delete(stored.current.publicKey)
}

export async function discardPendingSessionSigner(): Promise<void> {
  const stored = await readStore()
  if (!stored.pending) return
  importedKeys.delete(stored.pending.publicKey)
  await storage.setItem(STORE_KEY, {
    version: 2,
    current: stored.current,
  } satisfies StoredSessionKeys)
}

/** Compatibility helpers retained for non-cover request signing tests. */
export async function getSessionPublicKey(): Promise<string> {
  return (await getSessionSigner()).publicKey
}

export async function signWithSession(message: Uint8Array): Promise<Uint8Array> {
  return (await getSessionSigner()).signMessage(message)
}

/** Drop in-memory API credentials when wallet identity is replaced or reset. */
export function forgetSessionKey(): void {
  importedKeys.clear()
}
