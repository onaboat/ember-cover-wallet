import { expect, test } from 'vitest'

import type { LocalCoveragePaymentState } from '../background/coverage-payment-service.ts'
import type { CoverStatusSnapshot } from '../cover/ember-types.ts'
import { coveragePaymentStatusView } from './coverage-payment-status-view.ts'

const snapshot: CoverStatusSnapshot = {
  subscriptionActive: true,
  subscriptionStatus: 'active',
  walletRegistered: true,
  tier: 'Core',
  month: '2026-07',
  currentPeriodEnd: '2026-08-24T00:00:00Z',
  coveredTxPerMonth: 100,
  usedCoveredTxThisMonth: 7,
  remainingCoveredTxThisMonth: 93,
  monthlyLossCapUsd: 10000,
  usedLossCapUsd: 0,
  remainingLossCapUsd: 10000,
}

function state(overrides: Partial<LocalCoveragePaymentState> = {}): LocalCoveragePaymentState {
  return {
    version: 3,
    blockhash: 'blockhash',
    cluster: 'mainnet-beta',
    coverageEndsAt: null,
    lastError: null,
    lastUpdatedAt: '2026-07-25T00:00:00.000Z',
    lastValidBlockHeight: '1',
    offer: { displayName: 'Core' } as LocalCoveragePaymentState['offer'],
    payment: null,
    paymentSignature: 'signature',
    quote: {
      payload: {
        quoteId: 'quote_test',
      },
    } as LocalCoveragePaymentState['quote'],
    signedTransactionBase64: 'transaction',
    status: 'activation_pending',
    walletAddress: 'wallet',
    ...overrides,
  }
}

test('labels the account cover as active without implying the current request is covered', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: snapshot,
      nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
      paymentState: state({ status: 'active' }),
    }),
  ).toMatchObject({
    badgeLabel: 'COVER ACTIVE',
    badgeTone: 'protected',
    primaryAction: 'manage',
  })
})

test('offers a retry for a payment awaiting API activation', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'mainnet-beta',
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

test('never presents a reviewed but unsigned quote as a pending payment', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      paymentState: state({
        paymentSignature: null,
        signedTransactionBase64: null,
        status: 'quote_ready',
      }),
    }),
  ).toMatchObject({
    badgeLabel: 'NO COVER',
    badgeTone: 'none',
    detail: 'Review your Ember Cover offer.',
    metrics: [],
    primaryAction: 'activate',
  })
})

test('keeps an unsigned quote invisible while live cover status is loading', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: true,
      coverStatusLoading: true,
      coverStatusSnapshot: null,
      paymentState: state({
        paymentSignature: null,
        signedTransactionBase64: null,
        status: 'quote_ready',
      }),
    }),
  ).toMatchObject({
    badgeLabel: 'CHECKING',
    metrics: [],
    primaryAction: 'activate',
  })
})

test('presents a rejected on-chain payment as failed rather than unavailable', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      paymentState: state({ status: 'rejected' }),
    }),
  ).toMatchObject({
    badgeLabel: 'FAILED',
    badgeTone: 'failed',
    metrics: expect.arrayContaining([{ label: 'Payment', value: 'Failed' }]),
    primaryAction: 'activate',
  })
})

test('warns when the saved payment belongs to another network', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'devnet',
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

test('presents an offer-first state while connection is handled underneath', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: false,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      paymentState: null,
    }),
  ).toMatchObject({
    badgeLabel: 'NO COVER',
    badgeTone: 'none',
    detail: 'View your Ember Cover offer.',
    primaryAction: 'connect',
  })
})

test('offers renewal when the live API reports an expired period', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: {
        ...snapshot,
        subscriptionActive: false,
        subscriptionStatus: 'expired',
      },
      nowMs: Date.parse('2026-08-25T00:00:00Z'),
      paymentState: state({ status: 'active', coverageEndsAt: '2026-08-24T00:00:00Z' }),
    }),
  ).toMatchObject({
    badgeLabel: 'EXPIRED',
    primaryAction: 'activate',
  })
})

test('allows a new review after an unconfirmed payment blockhash expires', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: false,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      paymentState: state({ status: 'expired_unconfirmed' }),
    }),
  ).toMatchObject({
    badgeLabel: 'NOT SENT',
    primaryAction: 'activate',
  })
})

test('requires a live status refresh instead of offering another payment when status is unavailable', () => {
  expect(
    coveragePaymentStatusView({
      cluster: 'mainnet-beta',
      coverEnrolled: true,
      coverStatusLoading: false,
      coverStatusSnapshot: null,
      paymentState: state({ status: 'active' }),
    }),
  ).toMatchObject({
    badgeLabel: 'UNAVAILABLE',
    primaryAction: 'refresh',
  })
})
