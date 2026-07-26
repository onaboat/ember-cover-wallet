import { Vault } from '../vault/vault.ts'
import type { VaultStore } from '../vault/vault-store.ts'

/** Lives in the background SW. Holds the only unlocked-key-bearing Vault instance. */
export class VaultController {
  private store: VaultStore
  private vault: Vault

  constructor(store: VaultStore) {
    this.store = store
    this.vault = new Vault(store)
  }

  async hasVault(): Promise<boolean> {
    return (await this.store.get()) !== null
  }

  async createVault(password: string): Promise<string> {
    await this.vault.create(password)
    return this.requireAddress()
  }

  async unlock(password: string): Promise<void> {
    await this.vault.unlock(password)
  }

  async isUnlocked(): Promise<boolean> {
    return this.vault.isUnlocked()
  }

  async lock(): Promise<void> {
    this.vault.lock()
  }

  async exportBackup(password: string): Promise<string> {
    await this.vault.unlock(password)
    return await this.vault.exportBackup()
  }

  async importBackup(blob: string, password: string): Promise<string> {
    const address = await Vault.importBackup(this.store, blob, password)
    this.vault.lock()
    this.vault = new Vault(this.store)
    return address
  }

  async resetVault(): Promise<void> {
    this.vault.lock()
    await this.store.clear()
    this.vault = new Vault(this.store)
  }

  /**
   * Signs ONLY when unlocked. Vault.sign throws 'vault is locked' if the key is absent OR
   * if the idle window elapsed (a successful unlock does not guarantee a successful sign).
   */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return this.vault.sign(message)
  }

  async getAddress(): Promise<string | null> {
    return (await this.store.get())?.publicKey ?? null
  }

  private async requireAddress(): Promise<string> {
    const address = await this.getAddress()
    if (!address) {
      throw new Error('no vault')
    }
    return address
  }
}
