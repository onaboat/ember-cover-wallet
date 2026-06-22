import { expect, test } from 'vitest'

import { coverCapExhausted, isCoverable, normalizeCoverCapContext, normalizeCoverStatusSnapshot } from './ember-types.ts'

test('covered decision is coverable', () => {
  expect(isCoverable({ coverStatus: 'covered' })).toBe(true)
})

test('unavailable decision is not coverable', () => {
  expect(isCoverable({ coverStatus: 'unavailable' })).toBe(false)
})

test('normalizes cap context from the backend pre-sign response', () => {
  expect(
    normalizeCoverCapContext({
      capContext: { monthlyLossCapUsd: 10000, remainingCoveredTxThisMonth: 99 },
    }),
  ).toEqual({
    monthlyLossCapUsd: 10000,
    remainingCoveredTxThisMonth: 99,
  })
})

test('missing cap context normalizes to null', () => {
  expect(normalizeCoverCapContext({})).toBeNull()
})

test('normalizes a non-consuming cover status snapshot', () => {
  expect(
    normalizeCoverStatusSnapshot({
      subscriptionActive: true,
      walletRegistered: true,
      tier: 'demo',
      month: '2026-06',
      coveredTxPerMonth: 100,
      usedCoveredTxThisMonth: 1,
      remainingCoveredTxThisMonth: 99,
      monthlyLossCapUsd: 10000,
      usedLossCapUsd: 0,
      remainingLossCapUsd: 10000,
    }),
  ).toEqual({
    subscriptionActive: true,
    walletRegistered: true,
    tier: 'demo',
    month: '2026-06',
    coveredTxPerMonth: 100,
    usedCoveredTxThisMonth: 1,
    remainingCoveredTxThisMonth: 99,
    monthlyLossCapUsd: 10000,
    usedLossCapUsd: 0,
    remainingLossCapUsd: 10000,
  })
})

test('rejects malformed status snapshots', () => {
  expect(normalizeCoverStatusSnapshot({ coveredTxPerMonth: 100 })).toBeNull()
})

test('exhausted cap is identified from backend status and reason code', () => {
  expect(coverCapExhausted({ coverStatus: 'not_covered', reasonCodes: ['transaction_count_exhausted'] })).toBe(true)
  expect(coverCapExhausted({ coverStatus: 'covered', reasonCodes: ['transaction_count_exhausted'] })).toBe(false)
})
