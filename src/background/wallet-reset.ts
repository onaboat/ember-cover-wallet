import { storage } from 'wxt/utils/storage'

import { forgetSessionKey } from './session-key.ts'

const WALLET_SCOPED_KEYS = [
  'local:ember-session-key',
  'local:ember-wallet-session:v1',
  'local:ember-coverage-payment:v3',
  'local:ember-authoritative-lifecycle-cache:v1',
  'local:ember-evidence-outbox:v1',
  'local:ember-cover-records',
  'local:ember-dapp-connections',
  'local:ember-wallet-data-cluster',
] as const

/**
 * Clear identity-bound state before a backup import or destructive reset.
 * Removing the cluster selection returns a replacement wallet to the build-bound cluster.
 */
export async function clearWalletScopedState(): Promise<void> {
  await Promise.all(WALLET_SCOPED_KEYS.map(async (key) => await storage.removeItem(key)))
  forgetSessionKey()
}
