import { expect, test } from 'vitest'

import type { LocalSubscriptionState } from '../background/subscription-service.ts'
import type { CoverStatusSnapshot } from '../cover/ember-types.ts'
import { subscriptionStatusView } from './subscription-status-view.ts'

const snapshot: CoverStatusSnapshot = {
  subscriptionActive: true,
  walletRegistered: true,
  tier: 'Core',
  month: '2026-06',
  coveredTxPerMonth: 100,
  usedCoveredTxThisMonth: 7,
  remainingCoveredTxThisMonth: 93,
  monthlyLossCapUsd: 10000,
  usedLossCapUsd: 0,
  remainingLossCapUsd: 10000,
}

function state(overrides: Partial<LocalSubscriptionState> = {}): LocalSubscriptionState {
  return {
    cluster: 'devnet',
    walletAddress: 'wallet',
    planId: 'core',
    billingPeriod: 'monthly',
    onchainPlanId: '1',
    status: 'api_registration_pending',
    programId: 'program',
    planPda: 'plan',
    subscriptionAuthorityPda: 'authority',
    subscriptionPda: 'subscription',
    paymentMint: 'mint',
    merchantWallet: 'merchant',
    pullerWallet: 'puller',
    registeredWithApi: false,
    lastSyncedAt: '2026-06-19T00:00:00.000Z',
    ...overrides,
  }
}

test('uses protected only when live cover status is active and registered', () => {
  expect(
    subscriptionStatusView({
      cluster: 'devnet',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: snapshot,
      subscriptionState: state({ status: 'active', registeredWithApi: true }),
    }),
  ).toMatchObject({
    badgeLabel: 'PROTECTED',
    badgeTone: 'protected',
    primaryAction: 'manage',
  })
})

test('shows setup state before subscription approval', () => {
  expect(
    subscriptionStatusView({
      cluster: 'devnet',
      coverEnrolled: false,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      subscriptionState: state({ status: 'setup_confirmed' }),
    }),
  ).toMatchObject({
    badgeLabel: 'SETUP',
    badgeTone: 'setup',
    primaryAction: 'activate',
  })
})

test('shows pending state after onchain approval before API entitlement', () => {
  expect(
    subscriptionStatusView({
      cluster: 'devnet',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      subscriptionState: state({ status: 'api_registration_pending', subscriptionSignature: 'sig' }),
    }),
  ).toMatchObject({
    badgeLabel: 'PENDING',
    badgeTone: 'pending',
    primaryAction: 'sync',
  })
})

test('warns when local subscription belongs to a different wallet network', () => {
  expect(
    subscriptionStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: snapshot,
      subscriptionState: state({ cluster: 'devnet', status: 'active' }),
    }),
  ).toMatchObject({
    badgeLabel: 'NETWORK',
    badgeTone: 'pending',
  })
})

test('falls back to unavailable when enrollment exists but status cannot be verified', () => {
  expect(
    subscriptionStatusView({
      cluster: 'devnet',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      subscriptionState: null,
    }),
  ).toMatchObject({
    badgeLabel: 'UNAVAILABLE',
    badgeTone: 'unavailable',
  })
})

test('shows no cover with no enrollment or local subscription', () => {
  expect(
    subscriptionStatusView({
      cluster: 'devnet',
      coverEnrolled: false,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      subscriptionState: null,
    }),
  ).toMatchObject({
    badgeLabel: 'NO COVER',
    badgeTone: 'none',
    primaryAction: 'activate',
  })
})
