import { storage } from 'wxt/utils/storage'

import { forgetSessionKey } from './session-key.ts'

const WALLET_SCOPED_KEYS = [
  'local:ember-cover-enrollment',
  'local:ember-session-key',
  'local:ember-cover-prepaid-payment:v1',
  'local:ember-cover-records',
  'local:ember-dapp-connections',
  'local:ember-wallet-data-cluster',
] as const

/**
 * Clear identity-bound state before a backup import or destructive reset.
 * Removing the cluster selection deliberately returns a replacement wallet to Devnet.
 */
export async function clearWalletScopedState(): Promise<void> {
  await Promise.all(WALLET_SCOPED_KEYS.map(async (key) => await storage.removeItem(key)))
  forgetSessionKey()
}
