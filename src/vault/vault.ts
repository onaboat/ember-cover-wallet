import { getAddressFromPublicKey } from '@solana/kit'

import { base58Decode } from '../crypto/base58.ts'
import { decryptKey, encryptKey } from './crypto.ts'
import { assessPassword } from './password-policy.ts'
import type { VaultRecord, VaultStore } from './vault-store.ts'

const DEFAULT_IDLE_LOCK_MS = 5 * 60 * 1000
const DEFAULT_MAX_FAILED_ATTEMPTS = 5
const DEFAULT_LOCKOUT_MS = 60 * 1000
const MAX_BACKUP_BYTES = 64 * 1024

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
  static async importBackup(store: VaultStore, blob: string, password: string): Promise<string> {
    const record = await validateBackup(blob, password)
    await store.put(record)
    return record.publicKey
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

function positiveInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function base64ByteLength(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum * 2) {
    return false
  }
  try {
    const length = atob(value).length
    return length >= minimum && length <= maximum
  } catch {
    return false
  }
}

function parseBackupRecord(blob: string): VaultRecord {
  if (new TextEncoder().encode(blob).byteLength > MAX_BACKUP_BYTES) {
    throw new Error('Backup file is too large.')
  }
  let value: unknown
  try {
    value = JSON.parse(blob)
  } catch {
    throw new Error('Backup file is not valid JSON.')
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Backup file is invalid.')
  }
  const record = value as Record<string, unknown>
  const params =
    record.argon2Params && typeof record.argon2Params === 'object'
      ? (record.argon2Params as Record<string, unknown>)
      : {}
  if (
    !base64ByteLength(record.salt, 16, 64) ||
    !base64ByteLength(record.iv, 12, 16) ||
    !base64ByteLength(record.ciphertext, 32, 512) ||
    typeof record.publicKey !== 'string' ||
    !positiveInteger(params.m, 8, 262_144) ||
    !positiveInteger(params.t, 1, 10) ||
    !positiveInteger(params.p, 1, 4)
  ) {
    throw new Error('Backup file is invalid.')
  }
  let publicKeyBytes: Uint8Array
  try {
    publicKeyBytes = base58Decode(record.publicKey)
  } catch {
    throw new Error('Backup wallet address is invalid.')
  }
  if (publicKeyBytes.length !== 32) {
    throw new Error('Backup wallet address is invalid.')
  }
  return {
    salt: record.salt,
    argon2Params: { m: params.m, t: params.t, p: params.p },
    iv: record.iv,
    ciphertext: record.ciphertext,
    publicKey: record.publicKey,
  }
}

async function validateBackup(blob: string, password: string): Promise<VaultRecord> {
  const record = parseBackupRecord(blob)
  let raw: Uint8Array | null = null
  try {
    raw = await decryptKey(record, password)
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(raw),
      { name: 'Ed25519' },
      false,
      ['sign'],
    )
    const publicKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(base58Decode(record.publicKey)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    const challenge = new TextEncoder().encode('ember-wallet-backup-check')
    const signature = await crypto.subtle.sign('Ed25519', privateKey, challenge)
    if (!(await crypto.subtle.verify('Ed25519', publicKey, signature, challenge))) {
      throw new Error('Backup key does not match its wallet address.')
    }
    return record
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Backup ')) {
      throw error
    }
    throw new Error('Backup password is wrong or the file has been changed.')
  } finally {
    raw?.fill(0)
  }
}
