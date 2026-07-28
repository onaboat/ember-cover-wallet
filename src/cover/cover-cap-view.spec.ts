import { expect, test } from 'vitest'

import { coverCapReviewText, formatCoverCapContext, formatCoverStatusSnapshot, formatLossCapSnapshot } from './cover-cap-view.ts'

test('formats cover cap context from the backend', () => {
  expect(formatCoverCapContext({ monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 12 })).toBe(
    '12 Ember Cover checks left in this coverage period',
  )
  expect(formatCoverCapContext({ remainingCoveredTxThisMonth: 1 })).toBe(
    '1 Ember Cover check left in this coverage period',
  )
})

test('formats cap usage for a covered review', () => {
  expect(coverCapReviewText('covered', { remainingCoveredTxThisMonth: 99 }, 1)).toBe(
    'Uses 1 Ember Cover check. 99 Ember Cover checks left in this coverage period.',
  )
})

test('formats the non-consuming status snapshot', () => {
  const snapshot = {
    subscriptionActive: true,
    subscriptionStatus: 'active',
    walletRegistered: true,
    tier: 'demo',
    month: '2026-06',
    currentPeriodEnd: '2026-07-01T00:00:00Z',
    coveredTxPerMonth: 100,
    usedCoveredTxThisMonth: 1,
    remainingCoveredTxThisMonth: 99,
    monthlyLossCapUsd: 10000,
    usedLossCapUsd: 250,
    remainingLossCapUsd: 9750,
  }
  expect(formatCoverStatusSnapshot(snapshot)).toBe(
    '99 of 100 Ember Cover checks left in this coverage period',
  )
  expect(formatLossCapSnapshot(snapshot)).toBe('$9,750 of $10,000 coverage limit left')
})

test('formats exhausted cap for a review', () => {
  expect(coverCapReviewText('not_covered', { remainingCoveredTxThisMonth: 0 }, 0)).toBe(
    'No Ember Cover checks left in this coverage period.',
  )
})
