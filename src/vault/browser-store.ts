import { storage } from 'wxt/utils/storage'

import type { VaultRecord, VaultStore } from './vault-store.ts'

const KEY = 'local:vault' as const

/** Persists ONLY the encrypted record (Argon2id ciphertext) — never the unlocked key. */
export class BrowserVaultStore implements VaultStore {
  async get(): Promise<VaultRecord | null> {
    return (await storage.getItem<VaultRecord>(KEY)) ?? null
  }

  async put(record: VaultRecord): Promise<void> {
    await storage.setItem(KEY, record)
  }

  async clear(): Promise<void> {
    await storage.removeItem(KEY)
  }
}
