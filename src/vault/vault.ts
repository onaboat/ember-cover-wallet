import { getAddressFromPublicKey } from '@solana/kit'

import { decryptKey, encryptKey } from './crypto.ts'
import { assessPassword } from './password-policy.ts'
import type { VaultRecord, VaultStore } from './vault-store.ts'

const DEFAULT_IDLE_LOCK_MS = 5 * 60 * 1000
const DEFAULT_MAX_FAILED_ATTEMPTS = 5
const DEFAULT_LOCKOUT_MS = 60 * 1000

export interface VaultOptions {
  now?: () => number
  idleLockMs?: number
  maxFailedAttempts?: number
  lockoutMs?: number
}

export class Vault {
  private store: VaultStore
  private signingKey: CryptoKey | null = null
  private readonly now: () => number
  private readonly idleLockMs: number
  private readonly maxFailedAttempts: number
  private readonly lockoutMs: number
  private lastActivityAt = 0
  private failedAttempts = 0
  private lockedOutUntil = 0

  constructor(store: VaultStore, options: VaultOptions = {}) {
    this.store = store
    this.now = options.now ?? Date.now
    this.idleLockMs = options.idleLockMs ?? DEFAULT_IDLE_LOCK_MS
    this.maxFailedAttempts = options.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS
    this.lockoutMs = options.lockoutMs ?? DEFAULT_LOCKOUT_MS
  }

  async create(password: string): Promise<void> {
    const policy = assessPassword(password)
    if (!policy.ok) {
      throw new Error(policy.reason ?? 'weak password')
    }
    const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
    const rawPrivate = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const address = await getAddressFromPublicKey(pair.publicKey)
    const record = await encryptKey(rawPrivate, password, address)
    rawPrivate.fill(0)
    await this.store.put(record)
  }

  async unlock(password: string): Promise<void> {
    if (this.now() < this.lockedOutUntil) {
      throw new Error('vault is locked out')
    }
    const record = await this.store.get()
    if (!record) {
      throw new Error('no vault')
    }
    let rawPrivate: Uint8Array
    try {
      rawPrivate = await decryptKey(record, password) // throws on wrong password / tamper
    } catch (err) {
      this.failedAttempts += 1
      if (this.failedAttempts >= this.maxFailedAttempts) {
        this.lockedOutUntil = this.now() + this.lockoutMs
        this.failedAttempts = 0
      }
      throw err
    }
    this.failedAttempts = 0
    this.signingKey = await crypto.subtle.importKey('pkcs8', new Uint8Array(rawPrivate), { name: 'Ed25519' }, false, [
      'sign',
    ])
    rawPrivate.fill(0)
    this.lastActivityAt = this.now()
  }

  lock(): void {
    this.signingKey = null
  }

  isUnlocked(): boolean {
    return this.signingKey !== null
  }

  /** The already-encrypted record as a string — safe to write to a file. No seed words. */
  async exportBackup(): Promise<string> {
    const record = await this.store.get()
    if (!record) {
      throw new Error('no vault')
    }
    return JSON.stringify(record)
  }

  /** Validate the blob decrypts with the password (integrity + auth), then persist it. */
  static async importBackup(store: VaultStore, blob: string, password: string): Promise<void> {
    const record = JSON.parse(blob) as VaultRecord
    const raw = await decryptKey(record, password) // throws on wrong password / tampered blob
    raw.fill(0) // zero the decrypted key bytes, matching create()/unlock() discipline
    await store.put(record)
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    if (!this.signingKey) {
      throw new Error('vault is locked')
    }
    if (this.now() - this.lastActivityAt >= this.idleLockMs) {
      this.lock()
      throw new Error('vault is locked')
    }
    this.lastActivityAt = this.now()
    return new Uint8Array(await crypto.subtle.sign('Ed25519', this.signingKey, new Uint8Array(message)))
  }
}
