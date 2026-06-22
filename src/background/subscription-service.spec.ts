import { fakeBrowser } from 'wxt/testing'
import { storage } from 'wxt/utils/storage'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { SolanaSubscriptionProvider } from './subscription-service.ts'

const ADDRESS = 'So11111111111111111111111111111111111111112'
const OTHER_ADDRESS = '11111111111111111111111111111112'

const unavailable = {
  requestId: '',
  coverStatus: 'unavailable' as const,
  riskBand: 'severe' as const,
  reasonCodes: [],
  decisionExpiresAt: new Date(0).toISOString(),
}

beforeEach(() => {
  fakeBrowser.reset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

test('fails closed when onchain plan ids are not configured', async () => {
  // Force the missing-config path regardless of any local .env the build loaded.
  vi.stubEnv('WXT_EMBER_SUBSCRIPTION_CORE_MONTHLY_PLAN_ID', '')
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

test('sync entitlement authorizes, activates, registers, then reads status — in that order', async () => {
  const calls: string[] = []
  const cover = {
    preSign: async () => unavailable,
    postSign: async () => {},
    status: async () => {
      calls.push('status')
      return {
        subscriptionActive: true,
        walletRegistered: true,
        tier: 'core',
        month: '2026-06',
        coveredTxPerMonth: 100,
        usedCoveredTxThisMonth: 0,
        remainingCoveredTxThisMonth: 100,
        monthlyLossCapUsd: 10000,
        usedLossCapUsd: 0,
        remainingLossCapUsd: 10000,
      }
    },
    preSignMessage: async () => unavailable,
    postSignMessage: async () => {},
    enroll: async () => true,
    authorizeSession: async () => {
      calls.push('authorize')
      return true
    },
    registerWithApi: async () => {
      calls.push('register')
      return true
    },
    isEnrolled: async () => true,
    activateSubscriptionEntitlement: async () => {
      calls.push('activate')
      return true
    },
  }
  const provider = new SolanaSubscriptionProvider(
    { getAddress: async () => ADDRESS, sign: async () => new Uint8Array(64) },
    cover,
  )
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

  const result = await provider.syncEntitlement(ADDRESS)

  expect(calls).toEqual(['authorize', 'activate', 'register', 'status'])
  expect(result?.status).toBe('active')
})
