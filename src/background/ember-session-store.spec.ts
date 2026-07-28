import type { PersistedWalletSession } from '@embercover/wallet-sdk'
import { beforeEach, expect, test } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'

import { BrowserWalletSessionStore } from './ember-session-store.ts'

const SESSION: PersistedWalletSession = {
  environment: 'sandbox',
  expiresAt: '2026-07-28T01:15:00.000Z',
  integrationId: 'integration_reference-wallet',
  integrationVersion: 1,
  partnerId: 'partner_ember',
  refreshExpiresAt: '2026-07-29T01:00:00.000Z',
  refreshToken: 'refresh_test-credential',
  scopes: ['offers:read'],
  sessionId: 'wallet_session_test',
  sessionPublicKey: '11111111111111111111111111111111',
  walletAddress: '22222222222222222222222222222222',
  walletSubjectId: 'wallet_subject_test',
}

beforeEach(() => fakeBrowser.reset())

test('persists and clears the exact SDK session', async () => {
  const store = new BrowserWalletSessionStore()
  await store.save(SESSION)
  expect(await store.load()).toEqual(SESSION)
  await store.clear()
  expect(await store.load()).toBeNull()
})

test('discards malformed session records', async () => {
  await storage.setItem('local:ember-wallet-session:v1', { sessionId: 'partial' })
  expect(await new BrowserWalletSessionStore().load()).toBeNull()
})
