import type { VaultRecord, VaultStore } from './vault-store.ts'

export class MemoryVaultStore implements VaultStore {
  private record: VaultRecord | null = null

  async get(): Promise<VaultRecord | null> {
    return this.record
  }

  async put(record: VaultRecord): Promise<void> {
    this.record = record
  }

  async clear(): Promise<void> {
    this.record = null
  }
}
