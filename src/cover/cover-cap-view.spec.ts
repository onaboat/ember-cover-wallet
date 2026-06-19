import { expect, test } from 'vitest'

import { coverCapReviewText, formatCoverCapContext, formatCoverStatusSnapshot, formatLossCapSnapshot } from './cover-cap-view.ts'

test('formats cover cap context from the backend', () => {
  expect(formatCoverCapContext({ monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 12 })).toBe(
    '12 Ember Cover checks left this month',
  )
  expect(formatCoverCapContext({ remainingCoveredTxThisMonth: 1 })).toBe('1 Ember Cover check left this month')
})

test('formats cap usage for a covered review', () => {
  expect(coverCapReviewText('covered', { remainingCoveredTxThisMonth: 99 }, 1)).toBe(
    'Uses 1 Ember Cover check. 99 Ember Cover checks left this month.',
  )
})

test('formats the non-consuming status snapshot', () => {
  const snapshot = {
    subscriptionActive: true,
    walletRegistered: true,
    tier: 'demo',
    month: '2026-06',
    coveredTxPerMonth: 100,
    usedCoveredTxThisMonth: 1,
    remainingCoveredTxThisMonth: 99,
    monthlyLossCapUsd: 10000,
    usedLossCapUsd: 250,
    remainingLossCapUsd: 9750,
  }
  expect(formatCoverStatusSnapshot(snapshot)).toBe('99 of 100 Ember Cover checks left this month')
  expect(formatLossCapSnapshot(snapshot)).toBe('$9,750 of $10,000 monthly loss cap left')
})

test('formats exhausted cap for a review', () => {
  expect(coverCapReviewText('not_covered', { remainingCoveredTxThisMonth: 0 }, 0)).toBe(
    'No Ember Cover checks left this month.',
  )
})
