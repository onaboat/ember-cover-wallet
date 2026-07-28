import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test } from 'vitest'

import { clearWalletScopedState } from './wallet-reset.ts'

beforeEach(() => {
  fakeBrowser.reset()
})

test('clears identity-bound state and restores the default cluster', async () => {
  await Promise.all([
    storage.setItem('local:ember-session-key', { publicKey: 'old' }),
    storage.setItem('local:ember-wallet-session:v1', { walletAddress: 'old' }),
    storage.setItem('local:ember-coverage-payment:v3', { walletAddress: 'old' }),
    storage.setItem('local:ember-authoritative-lifecycle-cache:v1', { walletAddress: 'old' }),
    storage.setItem('local:ember-evidence-outbox:v1', [{ decisionId: 'old' }]),
    storage.setItem('local:ember-cover-records', [{ walletAddress: 'old' }]),
    storage.setItem('local:ember-dapp-connections', [{ address: 'old' }]),
    storage.setItem('local:ember-wallet-data-cluster', 'mainnet-beta'),
  ])

  await clearWalletScopedState()

  expect(await storage.getItem('local:ember-wallet-session:v1')).toBeNull()
  expect(await storage.getItem('local:ember-coverage-payment:v3')).toBeNull()
  expect(await storage.getItem('local:ember-authoritative-lifecycle-cache:v1')).toBeNull()
  expect(await storage.getItem('local:ember-evidence-outbox:v1')).toBeNull()
  expect(await storage.getItem('local:ember-cover-records')).toBeNull()
  expect(await storage.getItem('local:ember-dapp-connections')).toBeNull()
  expect(await storage.getItem('local:ember-wallet-data-cluster')).toBeNull()
})
