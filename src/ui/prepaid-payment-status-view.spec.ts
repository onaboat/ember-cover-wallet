import { expect, test } from 'vitest'

import type { LocalPrepaidPaymentState } from '../background/prepaid-payment-service.ts'
import type { CoverStatusSnapshot } from '../cover/ember-types.ts'
import { prepaidPaymentStatusView } from './prepaid-payment-status-view.ts'

const snapshot: CoverStatusSnapshot = {
  subscriptionActive: true,
  walletRegistered: true,
  tier: 'Core',
  month: '2026-07',
  coveredTxPerMonth: 100,
  usedCoveredTxThisMonth: 7,
  remainingCoveredTxThisMonth: 93,
  monthlyLossCapUsd: 10000,
  usedLossCapUsd: 0,
  remainingLossCapUsd: 10000,
}

function state(overrides: Partial<LocalPrepaidPaymentState> = {}): LocalPrepaidPaymentState {
  return {
    version: 1,
    amountBaseUnits: '1000000',
    cluster: 'devnet',
    lastUpdatedAt: '2026-07-25T00:00:00.000Z',
    paymentSignature: 'signature',
    signedTransactionBase64: 'transaction',
    status: 'activation_pending',
    tier: 'Core',
    tokenMint: 'mint',
    treasuryTokenAccount: 'treasury',
    walletAddress: 'wallet',
    ...overrides,
  }
}

test('uses protected only when the live API status is active and registered', () => {
  expect(
    prepaidPaymentStatusView({
      cluster: 'devnet',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: snapshot,
      paymentState: state({ status: 'active' }),
    }),
  ).toMatchObject({
    badgeLabel: 'PROTECTED',
    badgeTone: 'protected',
    primaryAction: 'manage',
  })
})

test('offers a retry for a payment awaiting API activation', () => {
  expect(
    prepaidPaymentStatusView({
      cluster: 'devnet',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      paymentState: state(),
    }),
  ).toMatchObject({
    badgeLabel: 'PENDING',
    badgeTone: 'pending',
    primaryAction: 'sync',
  })
})

test('warns when the saved payment belongs to another network', () => {
  expect(
    prepaidPaymentStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      paymentState: state(),
    }),
  ).toMatchObject({
    badgeLabel: 'NETWORK',
    badgeTone: 'pending',
  })
})

test('offers one-off activation when there is no cover or saved payment', () => {
  expect(
    prepaidPaymentStatusView({
      cluster: 'devnet',
      coverEnrolled: false,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      paymentState: null,
    }),
  ).toMatchObject({
    badgeLabel: 'NO COVER',
    badgeTone: 'none',
    primaryAction: 'activate',
  })
})
