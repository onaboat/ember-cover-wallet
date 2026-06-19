import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { beforeEach, expect, test } from 'vitest'

import { SolanaSubscriptionProvider } from './subscription-service.ts'

const ADDRESS = 'So11111111111111111111111111111111111111112'
const OTHER_ADDRESS = '11111111111111111111111111111112'

beforeEach(() => {
  fakeBrowser.reset()
})

test('fails closed when onchain plan ids are not configured', async () => {
  const provider = new SolanaSubscriptionProvider({
    getAddress: async () => ADDRESS,
    sign: async () => new Uint8Array(64),
  })

  await expect(
    provider.previewSubscription({ planId: 'core', billingPeriod: 'monthly', cluster: 'devnet' }),
  ).rejects.toThrow('Solana subscription plan config missing')
})

test('local subscription state is scoped to the active wallet address', async () => {
  const provider = new SolanaSubscriptionProvider({
    getAddress: async () => ADDRESS,
    sign: async () => new Uint8Array(64),
  })
  await storage.setItem('local:ember-cover-solana-subscription', {
    cluster: 'devnet',
    walletAddress: ADDRESS,
    planId: 'core',
    billingPeriod: 'monthly',
    onchainPlanId: '1',
    status: 'api_registration_pending',
    programId: 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44',
    planPda: 'plan',
    subscriptionAuthorityPda: 'authority',
    subscriptionPda: 'subscription',
    paymentMint: 'mint',
    merchantWallet: 'merchant',
    pullerWallet: 'puller',
    subscriptionSignature: 'signature',
    registeredWithApi: false,
    lastSyncedAt: '2026-06-19T00:00:00.000Z',
  })

  expect(await provider.localSubscription(ADDRESS)).toMatchObject({ walletAddress: ADDRESS })
  expect(await provider.localSubscription(OTHER_ADDRESS)).toBeNull()
})

test('sync entitlement refuses setup-only state', async () => {
  const provider = new SolanaSubscriptionProvider({
    getAddress: async () => ADDRESS,
    sign: async () => new Uint8Array(64),
  })
  await storage.setItem('local:ember-cover-solana-subscription', {
    cluster: 'devnet',
    walletAddress: ADDRESS,
    planId: 'core',
    billingPeriod: 'monthly',
    onchainPlanId: '1',
    status: 'setup_confirmed',
    programId: 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44',
    planPda: 'plan',
    subscriptionAuthorityPda: 'authority',
    subscriptionPda: 'subscription',
    paymentMint: 'mint',
    merchantWallet: 'merchant',
    pullerWallet: 'puller',
    registeredWithApi: false,
    lastSyncedAt: '2026-06-19T00:00:00.000Z',
  })

  await expect(provider.syncEntitlement(ADDRESS)).rejects.toThrow('not confirmed')
})
