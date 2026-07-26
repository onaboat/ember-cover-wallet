import { createProxyService, registerService } from '@webext-core/proxy-service'
import type { ProxyService, ProxyServiceKey } from '@webext-core/proxy-service'

import { BrowserVaultStore } from '../vault/browser-store.ts'
import { VaultController } from './vault-controller.ts'
import { clearWalletScopedState } from './wallet-reset.ts'

/** The methods exposed to UI contexts over the proxy. Deliberately NO `sign`. */
export interface VaultUI {
  hasVault(): Promise<boolean>
  createVault(password: string): Promise<string>
  unlock(password: string): Promise<void>
  isUnlocked(): Promise<boolean>
  lock(): Promise<void>
  getAddress(): Promise<string | null>
  exportBackup(password: string): Promise<string>
  importBackup(blob: string, password: string): Promise<string>
  resetVault(): Promise<void>
}

const VAULT_SERVICE_KEY = 'ember.VaultService' as ProxyServiceKey<VaultUI>

/**
 * SW only. Registers a sign-LESS facade under the proxy key and returns the REAL controller
 * (which HAS sign) for in-SW use by the request service. Because the registered service has no
 * `sign`, a runtime `proxy.sign(...)` marshals to a missing method and fails — signing is
 * unreachable from any page.
 */
export function registerVaultService(): VaultController {
  const controller = new VaultController(new BrowserVaultStore())
  const facade: VaultUI = {
    hasVault: () => controller.hasVault(),
    createVault: (password) => controller.createVault(password),
    unlock: (password) => controller.unlock(password),
    isUnlocked: () => controller.isUnlocked(),
    lock: () => controller.lock(),
    getAddress: () => controller.getAddress(),
    exportBackup: (password) => controller.exportBackup(password),
    importBackup: async (blob, password) => {
      const importedAddress = await controller.importBackup(blob, password)
      await clearWalletScopedState()
      return importedAddress
    },
    resetVault: async () => {
      await clearWalletScopedState()
      await controller.resetVault()
    },
  }
  registerService(VAULT_SERVICE_KEY, facade)
  return controller
}

/** Any UI context: a proxy WITHOUT sign. */
export function getVaultService(): ProxyService<VaultUI> {
  return createProxyService<VaultUI>(VAULT_SERVICE_KEY)
}
